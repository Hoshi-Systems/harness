import type { WorkflowBranchCase, WorkflowEdge } from '../../../wire/index.js'
import type { Mapping } from '../workflow-mapping.js'
import { HTTP_METHODS, MAX_NODE_RETRIES } from './limits.js'

/**
 * ── Node and edge types ──────────────────────────────────────────────────────
 *
 * The vocabulary a graph is written in. Apart from validation on purpose: these
 * say what a workflow IS, and the rules for accepting one are a separate
 * question that changes on its own schedule.
 *
 **/

export const WORKFLOW_NODE_KINDS = [
  'start',
  'agent',
  'http',
  'branch',
  'loop',
  'transform',
  'state',
  'approval',
  'note',
  'end',
] as const
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number]

/** How a node with several inbound edges waits. 'all' (the default): run once
 *  every inbound edge has resolved to satisfied-or-pruned, and at least one is
 *  satisfied — so a diamond runs its join exactly once. 'any': run on the first
 *  satisfied edge and prune the rest, for a "whichever path got here" merge. */
export type WorkflowJoin = 'all' | 'any'

export interface WorkflowNodeBase {
  id: string
  key: string
  name: string
  /** Canvas geometry. Round-tripped, never read by the engine. */
  position: { x: number; y: number }
  /** The `loop` node whose body this node lives in, or null at the top level. */
  parentId: string | null
  join: WorkflowJoin
}

export interface WorkflowRetries {
  /** Extra attempts after the first, 1–MAX_NODE_RETRIES. */
  count: number
  /** Delay before attempt 2; doubles per further attempt. */
  backoffSeconds: number
}

/** One HTTP request. Every field is a TEMPLATE rendered against the run context
 *  (and the vault) at send time, which is what makes
 *  `Authorization: Bearer {{secrets.API_TOKEN}}` the intended way to
 *  authenticate one. Egress is unrestricted, deliberately — see the long note in
 *  utils/workflow-http.ts, which still owns the scheme/timeout/size limits. */
export interface WorkflowHttpRequest {
  method: (typeof HTTP_METHODS)[number]
  url: string
  headers: Record<string, string>
  body: string | null
}

/** The wire shape (@hoshi/shared, machine-events.ts). `id` is stable — edges
 *  address a case as `case:<id>`, so relabelling never silently re-points its
 *  edge; `when` is workflow-condition source, evaluated against the run
 *  context. */
export type { WorkflowBranchCase }

export interface WorkflowStateAssignment {
  /** Reachable afterwards as `{{state.<key>}}`. */
  key: string
  value: Mapping
}

export interface WorkflowStartNode extends WorkflowNodeBase {
  kind: 'start'
  /** Optional JSON Schema (stringified) describing the expected trigger body.
   *  Drives the manual-run form; never enforced — a webhook sends what it sends. */
  inputSchema: string | null
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  kind: 'agent'
  prompt: string
  agent: string | null
  model: { providerID: string; modelID: string } | null
  /** Run in its own fresh session instead of the run's shared thread. */
  freshSession: boolean
  /** JSON Schema (stringified) the reply must end with as a fenced ```json
   *  block; parsed into the node's structured `output`. */
  outputSchema: string | null
  retries: WorkflowRetries | null
}

export interface WorkflowHttpNode extends WorkflowNodeBase {
  kind: 'http'
  http: WorkflowHttpRequest
  retries: WorkflowRetries | null
}

export interface WorkflowBranchNode extends WorkflowNodeBase {
  kind: 'branch'
  /** Evaluated in order; the FIRST true case wins. Falling off the end takes
   *  the `else` port. */
  cases: WorkflowBranchCase[]
}

export interface WorkflowLoopNode extends WorkflowNodeBase {
  kind: 'loop'
  mode: 'foreach' | 'while'
  /** foreach only — a mapping that must evaluate to an array. */
  source: Mapping | null
  /** while only — re-evaluated against the live context before each pass, so a
   *  `state` node in the body is the loop variable. */
  while: string | null
  /** Hard stop. Reaching it warns on the node rather than failing the run — a
   *  capped loop is a bounded loop, not a broken one. */
  maxIterations: number
}

export interface WorkflowTransformNode extends WorkflowNodeBase {
  kind: 'transform'
  /** Pure data reshaping: no model call, no I/O, no session. */
  mapping: Mapping
}

export interface WorkflowStateNode extends WorkflowNodeBase {
  kind: 'state'
  assignments: WorkflowStateAssignment[]
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  kind: 'approval'
  title: string
  /** Template rendered against the run context — what the human is shown. */
  message: string
  /** null parks indefinitely, which is the default and the honest one: a
   *  human-in-the-loop gate that silently self-approves at 3am is a footgun. */
  timeoutSeconds: number | null
  onTimeout: 'approved' | 'rejected' | 'fail'
}

export interface WorkflowNoteNode extends WorkflowNodeBase {
  kind: 'note'
  body: string
  size: { width: number; height: number }
}

export interface WorkflowEndNode extends WorkflowNodeBase {
  kind: 'end'
  /** The run's output. */
  output: Mapping | null
  /** An `end` may settle the run as a failure — a graph that detected a bad
   *  outcome shouldn't have to throw to say so. */
  outcome: 'done' | 'error'
  /** Template used as the run's error when `outcome` is 'error'. */
  message: string | null
}

export type WorkflowNode =
  | WorkflowStartNode
  | WorkflowAgentNode
  | WorkflowHttpNode
  | WorkflowBranchNode
  | WorkflowLoopNode
  | WorkflowTransformNode
  | WorkflowStateNode
  | WorkflowApprovalNode
  | WorkflowNoteNode
  | WorkflowEndNode

/** The wire shape (@hoshi/shared). `sourcePort` is the source node's OUTPUT
 *  port — what makes branch/loop/approval expressible and what the engine
 *  prunes on; `targetPort` is one inbound port today, on the wire so a future
 *  named-leg join doesn't need a schema break. */
export type { WorkflowEdge }

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** A transform whose mapping hasn't been written yet. */
/** A transform with nothing mapped yet — what a node saves as while it is
 *  still being drawn. */
export const EMPTY_MAPPING: Mapping = { op: 'object', entries: [] }
