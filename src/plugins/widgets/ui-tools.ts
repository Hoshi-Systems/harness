import { HGL_ACTION_VERBS, HGL_BINDABLE_COMPONENTS, HGL_COMPONENT_NAMES, HGL_REQUIRED_PROPS } from '../../hgl.js'
import crypto from 'node:crypto'
import { defineHoshiTool, z, type HoshiToolContext, type HoshiToolFactories } from '../define-tool.js'
import { listCheckoutMeta } from '../../kernel/index.js'

/**
 *
 * Hoshi's generative UI tools (`openspec/specs/machine-generative-ui/spec.md`): the
 * model emits HGL — a flat-node JSON document — and the client's
 * DynamicUiTranslator renders it from the design system. `ui_render` is
 * display-only; `ui_ask` BLOCKS inside execute() until the user answers from
 * the rendered surface (`POST /widgets/:id/respond` on the machine resolves it
 * — see the in-process bridge below); `ui_html` embeds model-authored HTML in a
 * sandboxed stateless iframe.
 *
 * The HGL catalog knowledge here (types + required props) intentionally mirrors
 * @hoshi/ui's lib/hgl — the client parser stays tolerant, so drift degrades
 * instead of breaking.
 *
 **/

type WidgetResolution = { status: 'answered'; response: Record<string, unknown> } | { status: 'cancelled' }

interface PendingWidget {
  kind: string
  sessionId: string
  resolve: (resolution: WidgetResolution) => void
}

/**
 * ── Waiting for the user, in-process ─────────────────────────────────────────
 *
 * This used to be an HTTP server. The tools ran inside another process, so a
 * widget waiting for an answer had no way to be reached: the plugin bound
 * 127.0.0.1:4097 and the sidecar proxied POST /widgets/:id/respond to it. That
 * brought its own failure mode — two OpenCode processes sharing the developer's
 * global plugin config would fight over the port, and `ui_ask` degraded to
 * "ask in plain text instead".
 *
 * In-process, answering is a function call. The map below IS the bridge.
 *
 **/
const pending = new Map<string, PendingWidget>()
const answered = new Set<string>()

/** Remember an id as answered so a late duplicate submit can be told apart
 *  from an unknown one, without growing without bound. */
function markAnswered(id: string) {
  answered.add(id)
  if (answered.size > 200) {
    const oldest = answered.values().next().value
    if (oldest) answered.delete(oldest)
  }
}

export interface PendingWidgetSummary {
  id: string
  kind: string
  sessionId: string
}

/** Every widget currently waiting for an answer. The client hydrates from this
 *  after a reload, exactly like a permission ask. */
export function listPendingWidgets(): PendingWidgetSummary[] {
  return [...pending.entries()].map(([id, entry]) => ({ id, kind: entry.kind, sessionId: entry.sessionId }))
}

export type WidgetReplyOutcome = 'answered' | 'already-answered' | 'unknown'

/** Answer a waiting widget. Called directly by the sidecar's route — no
 *  loopback, no proxy, no port. */
export function respondToWidget(id: string, response: Record<string, unknown>): WidgetReplyOutcome {
  const entry = pending.get(id)
  if (!entry) return answered.has(id) ? 'already-answered' : 'unknown'
  pending.delete(id)
  markAnswered(id)
  entry.resolve({ status: 'answered', response })
  return 'answered'
}

/** The blocking core of `ui_ask`: announce the widget so every connected
 *  client can render it, then wait until somebody answers or the turn stops.
 *
 *  The announcement is a bus event rather than tool metadata. Metadata on a
 *  running tool part was a known no-op for plugin tools, so the client had to
 *  discover the id by polling a pending list — a workaround for living in
 *  another process. The event carries the id the moment the widget exists.
 *
 *  Abort is watched, not assumed: a turn stopped while a widget is on screen
 *  must release the tool, or the session hangs on a question whose card the
 *  user has already dismissed. */
async function awaitWidgetResponse(
  title: string,
  document: unknown,
  context: HoshiToolContext,
): Promise<{ id: string; resolution: WidgetResolution }> {
  const id = crypto.randomUUID()

  const resolution = await new Promise<WidgetResolution>((resolve) => {
    pending.set(id, { kind: 'ask', sessionId: context.sessionId, resolve })
    context.publish('asked', { id, kind: 'ask', title, sessionId: context.sessionId, document })
    const onAbort = () => {
      if (pending.delete(id)) {
        context.publish('cancelled', { id, sessionId: context.sessionId })
        resolve({ status: 'cancelled' })
      }
    }
    if (context.signal.aborted) onAbort()
    else context.signal.addEventListener('abort', onAbort, { once: true })
  })

  return { id, resolution }
}

/**
 * ── HGL document validation ──────────────────────────────────────────────────
 *
 * The zod args stay a loose structural envelope (tool schemas ride in every
 * request — a full per-type discriminated union would burn tokens on every
 * turn). Semantic validation happens here instead, and its errors are written
 * FOR the model: name the node, say what's missing, say what to do.
 *
 **/

interface HglNodeWire {
  type: string
  props?: Record<string, unknown>
  children?: string[]
  action?: Record<string, unknown>
  fallback?: string
  visibleIf?: unknown
  computedProps?: Record<string, unknown>
}

interface HglDocumentWire {
  v?: number
  surface?: { id?: string; title?: string }
  root: string[]
  nodes: Record<string, HglNodeWire>
  state?: Record<string, unknown>
  computed?: Record<string, unknown>
}

const ACTION_VERBS: ReadonlySet<string> = new Set(HGL_ACTION_VERBS)

/** The client's sentinel for "the workspace root, no checkout" (never a real
 *  Platform project id, never returned by the projects list below) —
 *  apps/app/app/composables/useProjects.ts's PERSONAL_SCOPE, mirrored here for
 *  the same reason the UI component allowlist is mirrored: this file can't
 *  import the app. */
const PERSONAL_SCOPE = 'personal'

/** type → required prop names (the client normalizer's hard requirements). */
const CATALOG = HGL_REQUIRED_PROPS

/** The design-system components a `component` node may name. The list is
 *  `@hoshi/shared`'s, which @hoshi/ui types its own name→component map
 *  against — so the set this validates and the set the client can render
 *  cannot drift. The client parser is tolerant (an unknown name renders the
 *  node's fallback), but validating here teaches the model the real list. */
const UI_COMPONENT_NAMES: ReadonlySet<string> = new Set(HGL_COMPONENT_NAMES)

/** Names in UI_COMPONENT_NAMES that may carry `props.bind`. */
const BINDABLE_COMPONENT_NAMES: ReadonlySet<string> = new Set(HGL_BINDABLE_COMPONENTS)

const INPUT_TYPES = new Set(['form', 'choice', 'confirm'])

/**
 * ── HGL expression validation ────────────────────────────────────────────────
 *
 * Mirrors @hoshi/ui's lib/hgl/expr.ts (this file ships standalone into
 * OpenCode and cannot import it — keep the two in step, together). Only the
 * validation half is needed here; the plugin never evaluates an expression,
 * only rejects a document whose visibleIf/computedProps/computed shapes are
 * malformed, oversized, or cyclic before the tool call succeeds.
 *
 **/

const HGL_EXPR_OPS = new Set([
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'truthy',
  'falsy',
  'not',
  'and',
  'or',
  'add',
  'multiply',
  'concat',
  'subtract',
  'divide',
  'round',
  'cond',
])
const HGL_MAX_EXPR_DEPTH = 6
const HGL_MAX_EXPR_NODES = 64

function isExprRef(value: unknown): value is { ref: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { ref?: unknown }).ref === 'string'
  )
}

function isExprScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isValidHglExpr(value: unknown, depth = 0): boolean {
  if (depth > HGL_MAX_EXPR_DEPTH) return false
  if (isExprScalar(value) || isExprRef(value)) return true
  if (typeof value !== 'object' || Array.isArray(value) || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.op !== 'string' || !HGL_EXPR_OPS.has(v.op)) return false
  const d = depth + 1
  switch (v.op) {
    case 'equals':
    case 'notEquals':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return isValidHglExpr(v.left, d) && isValidHglExpr(v.right, d)
    case 'truthy':
    case 'falsy':
    case 'not':
      return isValidHglExpr(v.value, d)
    case 'and':
    case 'or':
    case 'add':
    case 'multiply':
    case 'concat':
      return Array.isArray(v.values) && v.values.length > 0 && v.values.every((x) => isValidHglExpr(x, d))
    case 'subtract':
    case 'divide':
      return isValidHglExpr(v.a, d) && isValidHglExpr(v.b, d)
    case 'round':
      return isValidHglExpr(v.value, d) && (v.decimals === undefined || typeof v.decimals === 'number')
    case 'cond':
      return isValidHglExpr(v.if, d) && isValidHglExpr(v.then, d) && isValidHglExpr(v.else, d)
    default:
      return false
  }
}

function countHglExprNodes(value: unknown): number {
  if (isExprScalar(value) || isExprRef(value)) return 1
  if (typeof value !== 'object' || value === null) return 1
  const v = value as Record<string, unknown>
  let count = 1
  for (const [key, val] of Object.entries(v)) {
    if (key === 'op' || key === 'decimals') continue
    if (Array.isArray(val)) for (const item of val) count += countHglExprNodes(item)
    else count += countHglExprNodes(val)
  }
  return count
}

function collectExprRefs(expr: unknown, out: Set<string>): void {
  if (isExprRef(expr)) {
    out.add(expr.ref)
    return
  }
  if (isExprScalar(expr) || typeof expr !== 'object' || expr === null) return
  const v = expr as Record<string, unknown>
  for (const [key, val] of Object.entries(v)) {
    if (key === 'op' || key === 'decimals') continue
    if (Array.isArray(val)) val.forEach((item) => collectExprRefs(item, out))
    else collectExprRefs(val, out)
  }
}

/** White/grey/black DFS over the named `computed` entries — returns the
 *  first cycle found (an ordered chain of names, for a readable error), or
 *  null when the dependency graph is acyclic. */
function findHglComputedCycle(computed: Record<string, unknown>): string[] | null {
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map<string, number>(Object.keys(computed).map((k) => [k, WHITE]))
  const stack: string[] = []

  function visit(name: string): string[] | null {
    color.set(name, GREY)
    stack.push(name)
    const refs = new Set<string>()
    collectExprRefs(computed[name], refs)
    for (const dep of refs) {
      if (!(dep in computed)) continue
      if (color.get(dep) === GREY) return [...stack.slice(stack.indexOf(dep)), dep]
      if (color.get(dep) === WHITE) {
        const found = visit(dep)
        if (found) return found
      }
    }
    stack.pop()
    color.set(name, BLACK)
    return null
  }

  for (const name of Object.keys(computed)) {
    if (color.get(name) === WHITE) {
      const found = visit(name)
      if (found) return found
    }
  }
  return null
}

/** `state`/`computed` shape + size checks, plus the cycle check — everything
 *  that only needs the document's own `state`/`computed` maps, independent of
 *  any single node. Node-level `visibleIf`/`computedProps` are validated in
 *  validateDocument() itself (they need the full ref-name allowlist this
 *  function computes: every declared state key ∪ every declared computed
 *  name). */
/** Total expression-node budget across the WHOLE document — the per-expression
 *  cap (HGL_MAX_EXPR_NODES) bounds any one visibleIf/computedProps/computed
 *  entry, but a document with many small-but-legal expressions (dozens of
 *  computedProps, each just under the per-expression cap) could still add up
 *  to something disproportionate. This is defense in depth, checked once
 *  across everything validateHglBindings + validateNodeExpressions counted. */
const HGL_MAX_TOTAL_EXPR_NODES = 512

function validateHglBindings(doc: HglDocumentWire): { errors: string[]; refNames: Set<string>; nodeCount: number } {
  const errors: string[] = []
  const state = doc.state ?? {}
  const computedMap = (doc.computed ?? {}) as Record<string, unknown>
  let nodeCount = 0

  for (const [key, value] of Object.entries(state)) {
    if (!isExprScalar(value)) errors.push(`surface.state.${key}: must be a string, number, boolean, or null`)
  }
  for (const [name, expr] of Object.entries(computedMap)) {
    if (!isValidHglExpr(expr)) {
      errors.push(`surface.computed.${name}: invalid expression shape (or exceeds depth ${HGL_MAX_EXPR_DEPTH})`)
      continue
    }
    const count = countHglExprNodes(expr)
    if (count > HGL_MAX_EXPR_NODES) {
      errors.push(`surface.computed.${name}: expression too large (max ${HGL_MAX_EXPR_NODES} nodes)`)
      continue
    }
    nodeCount += count
  }
  const cycle = findHglComputedCycle(computedMap as Record<string, never>)
  if (cycle) errors.push(`surface.computed has a circular dependency: ${cycle.join(' → ')}`)

  return { errors, refNames: new Set([...Object.keys(state), ...Object.keys(computedMap)]), nodeCount }
}

/** Validates one node's `visibleIf`/`computedProps` against the document's
 *  known state/computed names (`refNames`, from validateHglBindings). */
function validateNodeExpressions(
  id: string,
  node: HglNodeWire,
  refNames: Set<string>,
): { errors: string[]; nodeCount: number } {
  const errors: string[] = []
  let nodeCount = 0
  const checks: Array<[label: string, expr: unknown]> = []
  if (node.visibleIf !== undefined) checks.push([`node "${id}".visibleIf`, node.visibleIf])
  for (const [prop, expr] of Object.entries(node.computedProps ?? {})) {
    checks.push([`node "${id}".computedProps.${prop}`, expr])
  }
  for (const [label, expr] of checks) {
    if (!isValidHglExpr(expr)) {
      errors.push(`${label}: invalid expression shape (or exceeds depth ${HGL_MAX_EXPR_DEPTH})`)
      continue
    }
    const count = countHglExprNodes(expr)
    if (count > HGL_MAX_EXPR_NODES) {
      errors.push(`${label}: expression too large (max ${HGL_MAX_EXPR_NODES} nodes)`)
      continue
    }
    nodeCount += count
    const refs = new Set<string>()
    collectExprRefs(expr, refs)
    for (const ref of refs) {
      if (!refNames.has(ref)) {
        errors.push(
          `${label}: unknown reference "${ref}" — declare it in surface.state or surface.computed first (known: ${[...refNames].join(', ') || 'none'})`,
        )
      }
    }
  }
  return { errors, nodeCount }
}

/**
 * ── createSession project validation ────────────────────────────────────────
 *
 * The projects a session can open in are the checkouts THIS MACHINE has, and
 * the kernel keeps that manifest (kernel/checkouts.ts) — whoever provisions a
 * checkout writes it there. So the answer is a local read, and the error can
 * say exactly what it means: "not a real project on this machine".
 *
 * It used to ask the Platform for the owner's project list on every render
 * that named one, which was the only Platform call in this plugin and the one
 * thing keeping it from running on a machine with nobody behind it.
 *
 **/

/** The checkout ids on this machine. Never throws: a manifest that cannot be
 *  read must degrade the check, not block an otherwise-valid document. */
async function validProjectIds(): Promise<Set<string> | null> {
  try {
    return new Set((await listCheckoutMeta()).map((checkout) => checkout.id))
  } catch {
    return null
  }
}

/** Every `project` value a createSession action in this document names,
 *  deduped — usually 0 or 1, but a document can carry several buttons. */
function collectCreateSessionProjects(doc: HglDocumentWire): string[] {
  const projects = new Set<string>()
  for (const node of Object.values(doc.nodes)) {
    if (node.action?.verb === 'createSession' && typeof node.action.project === 'string') {
      projects.add(node.action.project)
    }
  }
  return [...projects]
}

/** Async half of document validation — separate from validateDocument()
 *  because everything else there is synchronous shape-checking. Only ever
 *  does network I/O when the document actually names a createSession project,
 *  so the other 99% of ui_render/ui_ask calls pay nothing extra. */
async function validateCreateSessionProjects(doc: HglDocumentWire): Promise<string[]> {
  const projects = collectCreateSessionProjects(doc).filter((p) => p !== PERSONAL_SCOPE)
  if (!projects.length) return []
  const validIds = await validProjectIds()
  if (!validIds) return [] // can't verify right now — fail open
  const unknown = projects.filter((p) => !validIds.has(p))
  if (!unknown.length) return []
  const known = [...validIds, PERSONAL_SCOPE].join(', ') || PERSONAL_SCOPE
  return unknown.map(
    (p) => `action.project "${p}" is not a real project on this machine — available: ${known}. Use the exact id.`,
  )
}

function validateDocument(doc: HglDocumentWire): string[] {
  const errors: string[] = []
  const ids = new Set(Object.keys(doc.nodes))

  for (const id of doc.root) {
    if (!ids.has(id)) errors.push(`root references node "${id}" which is not in nodes`)
  }

  const bindings = validateHglBindings(doc)
  errors.push(...bindings.errors)
  let totalExprNodes = bindings.nodeCount

  for (const [id, node] of Object.entries(doc.nodes)) {
    const nodeExprs = validateNodeExpressions(id, node, bindings.refNames)
    errors.push(...nodeExprs.errors)
    totalExprNodes += nodeExprs.nodeCount
    /**
     *
     * Case-folded before the lookup, and written back into the document so the
     * client sees the catalog's own spelling. Small models write `MARKDOWN` and
     * `Form`, and rejecting those — or letting them through to render as a
     * property dump — is the machine being pedantic about capitalisation while
     * a person watches their form fail to appear.
     *
     **/
    if (typeof node.type === 'string') node.type = node.type.trim().toLowerCase()
    const required = CATALOG[node.type]
    if (!required) {
      if (!node.fallback) {
        errors.push(
          `node "${id}": unknown type "${node.type}" needs a fallback (another node id or "drop") so older clients degrade; catalog types: ${Object.keys(CATALOG).join(', ')}`,
        )
      }
    } else {
      for (const prop of required) {
        if (node.props?.[prop] === undefined) errors.push(`node "${id}" (${node.type}): missing props.${prop}`)
      }
      errors.push(...validateInputShape(id, node))
      if (node.type === 'component') {
        const name = node.props?.component
        if (typeof name !== 'string' || !UI_COMPONENT_NAMES.has(name)) {
          errors.push(
            `node "${id}": unknown design-system component "${String(name)}" — available: ${[...UI_COMPONENT_NAMES].join(', ')}`,
          )
        } else if (node.props?.bind !== undefined) {
          if (typeof node.props.bind !== 'string' || !node.props.bind) {
            errors.push(`node "${id}": component.bind must be a non-empty state/computed key name`)
          } else if (!BINDABLE_COMPONENT_NAMES.has(name)) {
            errors.push(
              `node "${id}": "${name}" can't take a bind prop — only ${[...BINDABLE_COMPONENT_NAMES].join(', ')} can`,
            )
          }
        }
      }
    }
    for (const child of node.children ?? []) {
      if (!ids.has(child)) errors.push(`node "${id}": child "${child}" is not in nodes`)
      if (child === id) errors.push(`node "${id}": references itself as a child`)
    }
    if (node.action) {
      const verb = node.action.verb
      if (!ACTION_VERBS.has(verb as string)) {
        errors.push(
          `node "${id}": unknown action verb "${String(verb)}" (use submit | prompt | intent | link | copy | createSession)`,
        )
      } else if (verb === 'createSession') {
        const project = node.action.project
        if (typeof project !== 'string' || !project) {
          errors.push(`node "${id}": createSession action needs a non-empty "project" (a checkout id, or "personal")`)
        }
        if (node.action.prompt !== undefined && typeof node.action.prompt !== 'string') {
          errors.push(`node "${id}": createSession action's "prompt", if given, must be a string`)
        }
      }
    }
  }
  if (totalExprNodes > HGL_MAX_TOTAL_EXPR_NODES) {
    errors.push(
      `document has ${totalExprNodes} total expression nodes across all visibleIf/computedProps/computed — max ${HGL_MAX_TOTAL_EXPR_NODES}. Split this into fewer/smaller expressions or multiple surfaces.`,
    )
  }
  return errors
}

/** The inside of a form or a choice, checked HERE rather than left to the
 *  client.
 *
 *  Because the client's alternative is silence. A field it cannot identify is
 *  dropped, a form with no fields left cannot be parsed, and an unparseable node
 *  renders as a dashed box listing its own props — which reads, to the person
 *  who asked for a form, as an agent that cannot make one. Nothing errors, so
 *  the model never learns to write it differently.
 *
 *  Saying it here turns that into a message the model can act on, in the one
 *  place it is still holding the document. */
function validateInputShape(id: string, node: HglNodeWire): string[] {
  const errors: string[] = []
  if (node.type === 'form') {
    const fields = Array.isArray(node.props?.fields) ? node.props.fields : []
    if (fields.length === 0) errors.push(`node "${id}" (form): props.fields must have at least one field`)
    fields.forEach((raw, index) => {
      const field = (raw ?? {}) as Record<string, unknown>
      const named = ['id', 'name', 'key'].some((key) => typeof field[key] === 'string' && field[key])
      if (!named)
        errors.push(`node "${id}" (form): field ${index + 1} needs an "id" (the key its answer is returned under)`)
      if (typeof field.label !== 'string' || !field.label) {
        errors.push(`node "${id}" (form): field ${index + 1} needs a "label" (what the person reads)`)
      }
    })
  }
  if (node.type === 'choice') {
    const options = Array.isArray(node.props?.options) ? node.props.options : []
    if (options.length === 0) errors.push(`node "${id}" (choice): props.options must have at least one option`)
    options.forEach((raw, index) => {
      const option = (raw ?? {}) as Record<string, unknown>
      const labelled = ['label', 'id', 'value'].some((key) => typeof option[key] === 'string' && option[key])
      if (!labelled) errors.push(`node "${id}" (choice): option ${index + 1} needs a "label"`)
    })
  }
  return errors
}

function submitCapable(doc: HglDocumentWire): boolean {
  return Object.values(doc.nodes).some((node) => INPUT_TYPES.has(node.type) || node.action?.verb === 'submit')
}

function inputNodes(doc: HglDocumentWire): string[] {
  return Object.entries(doc.nodes)
    .filter(([, node]) => INPUT_TYPES.has(node.type) || node.action?.verb === 'submit')
    .map(([id]) => id)
}

function surfaceTitle(doc: HglDocumentWire): string {
  if (doc.surface?.title) return doc.surface.title
  for (const node of Object.values(doc.nodes)) {
    const text = node.props?.title ?? node.props?.text
    if ((node.type === 'heading' || node.type === 'form' || node.type === 'choice') && typeof text === 'string') {
      return text
    }
  }
  return 'Generated UI'
}

function fail(errors: string[]): never {
  throw new Error(`Invalid HGL document — fix and retry:\n- ${errors.join('\n- ')}`)
}

/**
 * ── Shared args envelope ─────────────────────────────────────────────────────
 *
 **/

const nodeSchema = z.object({
  /**
   *
   * The catalog is listed HERE, in the schema, and not only in the hgl skill.
   *
   * The skill is loaded on demand, and a model that never loads it invents a
   * type — `TEXT_INPUT` was the one seen in the wild, smuggled past validation
   * by the fallback field, which then rendered as a dashed box with the word
   * TEXT_INPUT in it. The person's read of that is "the agent cannot make a
   * form". Naming the types in the one place the model always sees costs a line
   * of schema and removes the guess; the skill still holds the props and the
   * examples, which is the part worth loading on demand.
   *
   **/
  type: z
    .string()
    .describe(
      `Catalog node type — one of: ${Object.keys(CATALOG).join(', ')}. ` +
        'Inputs are `form` (fields), `choice` (options) and `confirm`; there is no free-standing text input. ' +
        "Load the `hgl` skill for each type's props and examples.",
    ),
  props: z.record(z.string(), z.unknown()).optional().describe('Props for this type'),
  children: z.array(z.string()).optional().describe('Child node ids (containers only)'),
  action: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Action for button nodes, e.g. {"verb":"submit","data":{...}} or {"verb":"prompt","text":"..."}'),
  fallback: z
    .string()
    .optional()
    .describe('Node id to render instead when a client does not know this type, or "drop"'),
})

const documentArgs = {
  v: z.number().optional().describe('HGL catalog version (default 1)'),
  surface: z
    .object({
      id: z.string().optional().describe('Stable surface id — reuse it to update this surface later'),
      title: z.string().optional().describe('Surface heading'),
    })
    .optional(),
  root: z.array(z.string()).min(1).describe('Top-level node ids, in display order'),
  nodes: z
    .record(z.string(), nodeSchema)
    .describe('The flat node map: every node keyed by its id; children reference ids, never inline objects'),
}

/**
 * ── Tools ────────────────────────────────────────────────────────────────────
 *
 **/

const uiRender = defineHoshiTool({
  description: [
    "Render a rich UI surface (HGL document) inline in the user's chat.",
    'Use this instead of markdown tables/lists whenever structured data IS the answer. Display-only: returns immediately.',
    'Do not put form/choice nodes or submit buttons here — use ui_ask when you need an answer.',
    'The hgl skill is the only authoritative reference for the document format (node catalog, props, design-system component nodes).',
    'Read it before your first HGL document in a session, and re-read it whenever you are unsure — never emit HGL from memory of an older format.',
  ].join(' '),
  args: documentArgs,
  async execute(args) {
    const doc = args as unknown as HglDocumentWire
    const errors = validateDocument(doc)
    const inputs = inputNodes(doc)
    if (inputs.length) {
      errors.push(
        `display surface must not contain input nodes or submit buttons (${inputs.join(', ')}) — use ui_ask instead`,
      )
    }
    errors.push(...(await validateCreateSessionProjects(doc)))
    if (errors.length) fail(errors)
    const count = Object.keys(doc.nodes).length
    return {
      title: surfaceTitle(doc),
      output: `Rendered a UI surface (${count} node${count === 1 ? '' : 's'}) for the user. They can see it in the chat — don't repeat its content in text.`,
    }
  },
})

const uiAsk = defineHoshiTool({
  description: [
    'Render an interactive UI surface (HGL document) and WAIT for the user to answer.',
    'Use this for structured input instead of asking in prose: a form node (several values), a choice node (pick options), or submit buttons (one-tap decisions).',
    'The call blocks until the user submits or dismisses; the result carries their response.',
    'The hgl skill is the only authoritative reference for the document format — read it before first use, and re-read it whenever you are unsure; never emit HGL from memory of an older format.',
  ].join(' '),
  args: documentArgs,
  async execute(args, context) {
    const doc = args as unknown as HglDocumentWire
    const errors = validateDocument(doc)
    if (!submitCapable(doc)) {
      errors.push('an ask surface needs at least one form node, choice node, or button with a submit action')
    }
    errors.push(...(await validateCreateSessionProjects(doc)))
    if (errors.length) fail(errors)

    const { id, resolution } = await awaitWidgetResponse(surfaceTitle(doc), doc, context)
    return {
      title: surfaceTitle(doc),
      output:
        resolution.status === 'answered'
          ? `The user responded:\n${JSON.stringify(resolution.response, null, 2)}`
          : 'The user dismissed the surface without answering. Do not re-ask with a widget; continue in plain text.',
      metadata: {
        hoshi: {
          widget: {
            id,
            kind: 'ask',
            status: resolution.status,
            ...(resolution.status === 'answered' ? { response: resolution.response } : {}),
          },
        },
      },
    }
  },
})

const uiHtml = defineHoshiTool({
  description: [
    "Render a self-contained HTML fragment in a sandboxed iframe in the user's chat — the escape hatch for visuals the ui_render catalog can't express (custom SVG, animations, bespoke layouts). Prefer ui_render whenever the catalog covers the need.",
    'No network access at all: inline styles/scripts and data: images only. Theme with the injected CSS variables (var(--foreground), var(--card), var(--chart-1)…) — never hardcode colors.',
    "window.hoshi.action({verb:'prompt', text:'...'}) sends a message to the chat when the user interacts.",
  ].join(' '),
  args: {
    html: z
      .string()
      .min(1)
      .max(65536)
      .describe('The HTML body fragment (no <html>/<head> — they are added by the sandbox)'),
    title: z.string().optional().describe('Surface heading'),
    height: z.number().int().min(120).max(640).optional().describe('Iframe height in px (default 320)'),
  },
  async execute(args) {
    return {
      title: args.title ?? 'HTML view',
      output: `Rendered an HTML view (${args.html.length} chars, sandboxed, no network) for the user. They can see it in the chat.`,
    }
  },
})

export const uiTools: HoshiToolFactories = {
  ui_render: uiRender,
  ui_ask: uiAsk,
  ui_html: uiHtml,
}
