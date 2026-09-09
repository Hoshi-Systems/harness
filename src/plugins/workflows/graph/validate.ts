import { apiError, isConfigKey } from '../../../kernel/index.js'
import { parseWorkflowCondition, WorkflowConditionError } from '../workflow-condition.js'
import { validateMapping, WorkflowMappingError, type Mapping } from '../workflow-mapping.js'
import {
  HTTP_METHODS,
  MAX_APPROVAL_TIMEOUT_SECONDS,
  MAX_BRANCH_CASES,
  MAX_EDGES,
  MAX_HEADERS,
  MAX_LOOP_DEPTH,
  MAX_LOOP_ITERATIONS,
  MAX_NAME,
  MAX_NODES,
  MAX_NODE_RETRIES,
  MAX_NOTE,
  MAX_PROMPT,
  MAX_SCHEMA,
  MAX_STATE_KEYS,
  MAX_URL,
  MAX_RETRY_BACKOFF_SECONDS,
  MIN_APPROVAL_TIMEOUT_SECONDS,
  MIN_RETRY_BACKOFF_SECONDS,
  NODE_KEY,
} from './limits.js'
import { validateContainment, validateEdge, validateStructure } from './structure.js'
import {
  EMPTY_MAPPING,
  WORKFLOW_NODE_KINDS,
  type WorkflowApprovalNode,
  type WorkflowBranchCase,
  type WorkflowEndNode,
  type WorkflowLoopNode,
  type WorkflowNodeBase,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowHttpRequest,
  type WorkflowJoin,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRetries,
  type WorkflowStateAssignment,
} from './types.js'

/**
 * ── Validation ───────────────────────────────────────────────────────────────
 *
 * Per-field like v2, so a route can report the one thing that's wrong. Every
 * failure is an `apiError` with a stable `workflow.*` code; utils/org-assets.ts
 * catches these and re-throws them as its own error type, which is how an
 * installed workflow is held to exactly the rules a hand-built one is.
 *
 **/

export function validateWorkflowGraph(graphRaw: unknown): WorkflowGraph {
  const raw = (graphRaw && typeof graphRaw === 'object' ? graphRaw : {}) as Record<string, unknown>

  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : null
  if (!nodesRaw || nodesRaw.length < 1 || nodesRaw.length > MAX_NODES) {
    apiError(400, 'workflow.nodeCount', `A workflow needs 1–${MAX_NODES} nodes.`, { max: MAX_NODES })
  }
  const edgesRaw = Array.isArray(raw.edges) ? raw.edges : []
  if (edgesRaw.length > MAX_EDGES) {
    apiError(400, 'workflow.edgeCount', `A workflow may hold at most ${MAX_EDGES} edges.`, { max: MAX_EDGES })
  }

  const keys = new Set<string>()
  const nodes = nodesRaw.map((node) => withNodeIdentity(node, () => validateNode(node, keys)))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length) apiError(400, 'workflow.nodeIdDuplicate', 'Two nodes share an id.')

  validateContainment(nodes, byId)
  const edges = edgesRaw.map((edge) => validateEdge(edge, byId))
  validateStructure(nodes, edges, byId)

  return { nodes, edges }
}

/** Stamp the node under validation onto whatever it threw.
 *
 *  Every `workflow.node*` failure is raised deep in a helper that has no idea
 *  which node it is working on, and threading an id through twenty signatures
 *  to say so would be worse than the problem. Catching once at the node
 *  boundary covers every code — including ones added later — and gives the
 *  builder what it needs to select and highlight the offender instead of
 *  showing a toast that names no node at all.
 *
 *  The identity is read off the RAW input: validation may well have failed
 *  because the normalized node was never produced. */
function withNodeIdentity<T>(raw: unknown, run: () => T): T {
  try {
    return run()
  } catch (error) {
    const node = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const carrier = error as { data?: { code?: string; params?: Record<string, unknown> } }
    if (carrier?.data?.code) {
      carrier.data.params = {
        ...carrier.data.params,
        nodeId: typeof node.id === 'string' ? node.id : '',
        nodeKey: typeof node.key === 'string' ? node.key : '',
        nodeName: typeof node.name === 'string' ? node.name : '',
      }
    }
    throw error
  }
}

function validateNode(raw: unknown, keys: Set<string>): WorkflowNode {
  const node = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const kind = node.kind
  if (typeof kind !== 'string' || !(WORKFLOW_NODE_KINDS as readonly string[]).includes(kind)) {
    apiError(400, 'workflow.nodeKindInvalid', `"${String(kind)}" is not a node type.`)
  }

  if (typeof node.name !== 'string' || !node.name.trim() || node.name.trim().length > MAX_NAME) {
    apiError(400, 'workflow.nodeNameLength', `Each node needs a name (1–${MAX_NAME} characters).`, { max: MAX_NAME })
  }

  /**
   *
   * A note never executes and is never addressed from a template, so it is the
   * one kind that needs no key — requiring one would put meaningless slugs on
   * every sticky note.
   *
   **/
  let key = ''
  if (kind !== 'note') {
    if (typeof node.key !== 'string' || !NODE_KEY.test(node.key)) {
      apiError(
        400,
        'workflow.nodeKeyInvalid',
        'Each node needs a key: lowercase letters, digits, "-" or "_" (max 40 characters).',
      )
    }
    if (keys.has(node.key)) {
      apiError(400, 'workflow.nodeKeyDuplicate', `Node keys must be unique — "${node.key}" repeats.`)
    }
    keys.add(node.key)
    key = node.key
  }

  const base: WorkflowNodeBase = {
    id: typeof node.id === 'string' && node.id ? node.id : crypto.randomUUID(),
    key,
    name: (node.name as string).trim(),
    position: validatePosition(node.position),
    parentId: typeof node.parentId === 'string' && node.parentId ? node.parentId : null,
    join: node.join === 'any' ? 'any' : 'all',
  }

  switch (kind as WorkflowNodeKind) {
    case 'start':
      return { ...base, kind: 'start', inputSchema: validateJsonSchema(node.inputSchema) }

    case 'agent':
      return {
        ...base,
        kind: 'agent',
        prompt: validatePrompt(node.prompt),
        agent: validateAgentKey(node.agent),
        model: validateModel(node.model),
        freshSession: node.freshSession === true,
        outputSchema: validateJsonSchema(node.outputSchema),
        retries: validateRetries(node.retries),
      }

    case 'http':
      return { ...base, kind: 'http', http: validateHttp(node.http), retries: validateRetries(node.retries) }

    case 'branch':
      return { ...base, kind: 'branch', cases: validateBranchCases(node.cases) }

    case 'loop':
      return { ...base, kind: 'loop', ...validateLoop(node) }

    case 'transform':
      return { ...base, kind: 'transform', mapping: validateNodeMapping(node.mapping ?? EMPTY_MAPPING, true) }

    case 'state':
      return { ...base, kind: 'state', assignments: validateStateAssignments(node.assignments) }

    case 'approval':
      return { ...base, kind: 'approval', ...validateApproval(node) }

    case 'note':
      return { ...base, kind: 'note', body: validateNoteBody(node.body), size: validateNoteSize(node.size) }

    case 'end':
      return { ...base, kind: 'end', ...validateEnd(node) }
  }
}

function validatePosition(raw: unknown): { x: number; y: number } {
  const position = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const x = Number(position.x)
  const y = Number(position.y)
  /**
   *
   * Geometry is cosmetic, so a missing or nonsense position is normalized to
   * the origin rather than refused — a graph should never fail to save because
   * a client forgot to send coordinates.
   *
   **/
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

function validatePrompt(raw: unknown): string {
  const prompt = typeof raw === 'string' ? raw.trim() : ''
  if (prompt.length > MAX_PROMPT) {
    apiError(400, 'workflow.nodePromptLength', `A prompt must be at most ${MAX_PROMPT} characters.`, {
      max: MAX_PROMPT,
    })
  }
  return prompt
}

function validateAgentKey(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string' || !isConfigKey(raw)) {
    apiError(400, 'workflow.nodeAgentInvalid', 'The node agent must be a valid agent key.')
  }
  return raw
}

function validateModel(raw: unknown): { providerID: string; modelID: string } | null {
  if (raw == null) return null
  const model = raw as { providerID?: unknown; modelID?: unknown }
  if (
    typeof model.providerID !== 'string' ||
    !model.providerID ||
    typeof model.modelID !== 'string' ||
    !model.modelID
  ) {
    apiError(400, 'workflow.nodeModelInvalid', 'The node model must carry providerID and modelID.')
  }
  return { providerID: model.providerID as string, modelID: model.modelID as string }
}

function validateJsonSchema(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SCHEMA) {
    apiError(400, 'workflow.nodeSchemaLength', `A schema must be at most ${MAX_SCHEMA} characters.`, {
      max: MAX_SCHEMA,
    })
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
  } catch {
    apiError(400, 'workflow.nodeSchemaInvalid', 'The schema must be a valid JSON object.')
  }
  return raw.trim()
}

/** Shape only — the url is a template, so what it renders to can't be known
 *  until dispatch, and the http(s) check lives there (utils/workflow-http.ts). */
function validateHttp(raw: unknown): WorkflowHttpRequest {
  const http = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const method = typeof http.method === 'string' ? http.method.toUpperCase() : 'GET'
  if (!HTTP_METHODS.includes(method as WorkflowHttpRequest['method'])) {
    apiError(400, 'workflow.nodeHttpMethodInvalid', `The request method must be one of ${HTTP_METHODS.join(', ')}.`)
  }

  const url = typeof http.url === 'string' ? http.url.trim() : ''
  if (url.length > MAX_URL) {
    apiError(400, 'workflow.nodeHttpUrlLength', `A request URL must be at most ${MAX_URL} characters.`, {
      max: MAX_URL,
    })
  }

  const headers: Record<string, string> = {}
  const headersRaw = (http.headers && typeof http.headers === 'object' ? http.headers : {}) as Record<string, unknown>
  for (const [name, value] of Object.entries(headersRaw)) {
    /**
     *
     * RFC 7230 token, so a header name can never smuggle a second header.
     *
     **/
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) {
      apiError(400, 'workflow.nodeHttpHeaderInvalid', `"${name}" is not a valid header name/value pair.`)
    }
    headers[name] = value
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    apiError(400, 'workflow.nodeHttpHeaderCount', `A request can carry at most ${MAX_HEADERS} headers.`, {
      max: MAX_HEADERS,
    })
  }

  const body = typeof http.body === 'string' && http.body.length ? http.body : null
  if (body !== null && body.length > MAX_PROMPT) {
    apiError(400, 'workflow.nodeHttpBodyLength', `The request body must be at most ${MAX_PROMPT} characters.`, {
      max: MAX_PROMPT,
    })
  }

  return { method: method as WorkflowHttpRequest['method'], url, headers, body }
}

function validateRetries(raw: unknown): WorkflowRetries | null {
  if (raw == null) return null
  const policy = (typeof raw === 'object' ? raw : {}) as { count?: unknown; backoffSeconds?: unknown }
  const count = Number(policy.count)
  if (!Number.isInteger(count) || count < 0 || count > MAX_NODE_RETRIES) {
    apiError(400, 'workflow.nodeRetriesRange', `Retries must be 0–${MAX_NODE_RETRIES}.`, { max: MAX_NODE_RETRIES })
  }
  if (count === 0) return null

  const backoffSeconds = policy.backoffSeconds == null ? 30 : Number(policy.backoffSeconds)
  if (
    !Number.isInteger(backoffSeconds) ||
    backoffSeconds < MIN_RETRY_BACKOFF_SECONDS ||
    backoffSeconds > MAX_RETRY_BACKOFF_SECONDS
  ) {
    apiError(
      400,
      'workflow.nodeBackoffRange',
      `The retry backoff must be ${MIN_RETRY_BACKOFF_SECONDS}–${MAX_RETRY_BACKOFF_SECONDS} seconds.`,
      { min: MIN_RETRY_BACKOFF_SECONDS, max: MAX_RETRY_BACKOFF_SECONDS },
    )
  }
  return { count, backoffSeconds }
}

function validateBranchCases(raw: unknown): WorkflowBranchCase[] {
  const cases = Array.isArray(raw) ? raw : []
  if (cases.length < 1 || cases.length > MAX_BRANCH_CASES) {
    apiError(400, 'workflow.branchCases', `A branch needs 1–${MAX_BRANCH_CASES} cases.`, { max: MAX_BRANCH_CASES })
  }
  const ids = new Set<string>()
  return cases.map((entryRaw) => {
    const entry = (entryRaw && typeof entryRaw === 'object' ? entryRaw : {}) as Record<string, unknown>
    const id = typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID()
    if (ids.has(id)) apiError(400, 'workflow.branchCaseDuplicate', 'Two branch cases share an id.')
    ids.add(id)

    const when = typeof entry.when === 'string' ? entry.when.trim() : ''
    try {
      if (when) parseWorkflowCondition(when)
    } catch (error) {
      apiError(
        400,
        'workflow.branchCaseInvalid',
        `A branch condition is not valid: ${error instanceof WorkflowConditionError ? error.message : 'unrecognized expression'}`,
      )
    }

    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, MAX_NAME) : ''
    return { id, label, when }
  })
}

function validateLoop(node: Record<string, unknown>): Omit<WorkflowLoopNode, keyof WorkflowNodeBase | 'kind'> {
  const mode = node.mode === 'while' ? 'while' : 'foreach'

  const maxIterations = node.maxIterations == null ? MAX_LOOP_ITERATIONS : Number(node.maxIterations)
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_LOOP_ITERATIONS) {
    apiError(400, 'workflow.loopIterations', `A loop may run 1–${MAX_LOOP_ITERATIONS} iterations.`, {
      max: MAX_LOOP_ITERATIONS,
    })
  }

  if (mode === 'foreach') {
    return { mode, source: validateNodeMapping(node.source, false), while: null, maxIterations }
  }

  const whileSource = typeof node.while === 'string' ? node.while.trim() : ''
  try {
    if (whileSource) parseWorkflowCondition(whileSource)
  } catch (error) {
    apiError(
      400,
      'workflow.loopWhileInvalid',
      `The loop condition is not valid: ${error instanceof WorkflowConditionError ? error.message : 'unrecognized expression'}`,
    )
  }
  return { mode, source: null, while: whileSource, maxIterations }
}

function validateNodeMapping(raw: unknown, required: true): Mapping
function validateNodeMapping(raw: unknown, required: false): Mapping | null
function validateNodeMapping(raw: unknown, required: boolean): Mapping | null {
  if (raw == null) {
    if (!required) return null
    apiError(400, 'workflow.mappingInvalid', 'This node needs a value mapping.')
  }
  try {
    return validateMapping(raw)
  } catch (error) {
    apiError(
      400,
      'workflow.mappingInvalid',
      `The value mapping is not valid: ${error instanceof WorkflowMappingError ? error.message : 'unrecognized mapping'}`,
    )
  }
}

function validateStateAssignments(raw: unknown): WorkflowStateAssignment[] {
  const assignments = Array.isArray(raw) ? raw : []
  if (assignments.length > MAX_STATE_KEYS) {
    apiError(400, 'workflow.stateAssignments', `A state node may hold at most ${MAX_STATE_KEYS} variables.`, {
      max: MAX_STATE_KEYS,
    })
  }
  const keys = new Set<string>()
  return assignments.map((entryRaw) => {
    const entry = (entryRaw && typeof entryRaw === 'object' ? entryRaw : {}) as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    // State keys are addressed as `{{state.<key>}}`, so they take the same slug
    // shape node keys do — a template path never needs quoting.
    if (!NODE_KEY.test(key)) {
      apiError(400, 'workflow.stateKeyInvalid', 'Each state key must be lowercase letters, digits, "-" or "_".')
    }
    if (keys.has(key)) apiError(400, 'workflow.stateKeyDuplicate', `State keys must be unique — "${key}" repeats.`)
    keys.add(key)
    return { key, value: validateNodeMapping(entry.value, true) }
  })
}

function validateApproval(node: Record<string, unknown>): Omit<WorkflowApprovalNode, keyof WorkflowNodeBase | 'kind'> {
  const title = typeof node.title === 'string' ? node.title.trim() : ''
  if (title.length > MAX_NAME) {
    apiError(400, 'workflow.approvalTitle', `An approval title must be at most ${MAX_NAME} characters.`, {
      max: MAX_NAME,
    })
  }

  const message = typeof node.message === 'string' ? node.message.trim() : ''
  if (message.length > MAX_PROMPT) {
    apiError(400, 'workflow.approvalMessage', `The approval message must be at most ${MAX_PROMPT} characters.`, {
      max: MAX_PROMPT,
    })
  }

  const timeoutSeconds = node.timeoutSeconds == null ? null : Number(node.timeoutSeconds)
  if (
    timeoutSeconds !== null &&
    (!Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < MIN_APPROVAL_TIMEOUT_SECONDS ||
      timeoutSeconds > MAX_APPROVAL_TIMEOUT_SECONDS)
  ) {
    apiError(
      400,
      'workflow.approvalTimeout',
      `An approval timeout must be ${MIN_APPROVAL_TIMEOUT_SECONDS}–${MAX_APPROVAL_TIMEOUT_SECONDS} seconds, or empty to wait indefinitely.`,
      { min: MIN_APPROVAL_TIMEOUT_SECONDS, max: MAX_APPROVAL_TIMEOUT_SECONDS },
    )
  }

  const onTimeout =
    node.onTimeout === 'approved' || node.onTimeout === 'rejected' || node.onTimeout === 'fail'
      ? node.onTimeout
      : 'fail'
  return { title, message, timeoutSeconds, onTimeout }
}

function validateNoteBody(raw: unknown): string {
  const body = typeof raw === 'string' ? raw : ''
  if (body.length > MAX_NOTE) {
    apiError(400, 'workflow.noteLength', `A note must be at most ${MAX_NOTE} characters.`, { max: MAX_NOTE })
  }
  return body
}

function validateNoteSize(raw: unknown): { width: number; height: number } {
  const size = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const width = Number(size.width)
  const height = Number(size.height)
  return {
    width: Number.isFinite(width) ? Math.min(Math.max(width, 120), 1_200) : 240,
    height: Number.isFinite(height) ? Math.min(Math.max(height, 80), 1_200) : 160,
  }
}

function validateEnd(node: Record<string, unknown>): Omit<WorkflowEndNode, keyof WorkflowNodeBase | 'kind'> {
  const outcome = node.outcome === 'error' ? 'error' : 'done'
  const message = typeof node.message === 'string' && node.message.trim() ? node.message.trim() : null
  if (message !== null && message.length > MAX_PROMPT) {
    apiError(400, 'workflow.endMessageLength', `The end message must be at most ${MAX_PROMPT} characters.`, {
      max: MAX_PROMPT,
    })
  }
  return { output: validateNodeMapping(node.output, false), outcome, message }
}
