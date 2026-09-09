import type { WorkflowRunApproval, WorkflowRunAttempt } from '../../wire/index.js'
/**
 * ── Workflow run scheduling ──────────────────────────────────────────────────
 *
 * The graph algebra behind a v3 run: which node executions exist, which are
 * ready, how a decision at one node prunes the paths nobody took, and what
 * context a node's templates see. Everything here is PURE — it mutates the run
 * object it is handed and touches nothing else. No OpenCode, no disk, no clock
 * beyond timestamps. That is what makes the hard part testable
 * (utils/workflow-scheduler.test.ts); utils/workflow-runs.ts owns the store, the
 * queue and the side effects.
 *
 * THERE IS NO CURSOR. v2 tracked `currentStepIndex`, a second source of truth
 * its own poll already had to defend against ("an index past the end means every
 * step settled"). A graph would need one cursor per live path and they would
 * drift on every crash. Here the frontier is DERIVED — the ready set is just the
 * node runs whose status is `pending` — so the file on disk is literally the
 * resume point, with nothing to reconcile after a restart.
 *
 * The whole control-flow model is one rule, in `resolveJoin`:
 *
 *   an edge is SATISFIED when its source settled on that edge's port, and
 *   PRUNED when it settled on another (or was itself pruned). A node runs once
 *   every inbound edge has resolved and at least one is satisfied; it is pruned
 *   when they have all resolved and none is.
 *
 * Branches, diamonds, joins and "skip this node but carry on" all fall out of
 * that one rule with no special cases anywhere — which is what lets the graph
 * carry every kind of control flow as plain edges.
 *
 **/

import { evaluateMapping } from './workflow-mapping.js'
import type { CompiledGraph, WorkflowEdge, WorkflowNode, WorkflowNodeKind } from './graph/index.js'

/** Per-iteration outputs a finished loop exposes as its own `output.results`. */
export type LoopIterationResult = Record<string, { text: string; output: unknown }>

export type WorkflowNodeRunStatus =
  /** Some inbound edge hasn't resolved yet. */
  | 'blocked'
  /** Ready to execute — this IS the frontier. */
  | 'pending'
  | 'running'
  /** Errored, waiting out its backoff before the next attempt. */
  | 'retrying'
  /** Parked on a human decision. Holds no concurrency. */
  | 'waiting'
  | 'done'
  | 'error'
  /** The graph decided against this path: a branch went the other way, or every
   *  node feeding this one was itself pruned. */
  | 'pruned'
  /** The RUN ended before this could execute — deliberately distinct from
   *  `pruned`: one is a decision, the other an interruption. */
  | 'cancelled'

/** Statuses that mean "this run still has work in flight". */
export const ACTIVE_NODE_STATUSES: ReadonlySet<WorkflowNodeRunStatus> = new Set<WorkflowNodeRunStatus>([
  'blocked',
  'pending',
  'running',
  'retrying',
  'waiting',
])

/** Wire shapes (@hoshi/shared, machine-events.ts). `attempt` is 1-based;
 *  `decidedBy` is the authenticated user who answered. */
export type { WorkflowRunApproval, WorkflowRunAttempt }

export interface WorkflowRunLoop {
  index: number
  /** null for a `while` loop, whose length isn't known up front. */
  total: number | null
  /** foreach only: the resolved source array. Persisted rather than
   *  re-evaluated because an iteration resuming after a restart must still know
   *  its own item — and because re-evaluating a source mid-loop would let the
   *  collection shift under an iteration already in flight. */
  items: unknown[] | null
  results: LoopIterationResult[]
}

/** ONE EXECUTION of one node. A node inside a loop has one per iteration; a node
 *  outside every loop has exactly one. `(nodeId, path)` is its identity. */
export interface WorkflowRunNodeRun {
  /** Stable id — how a route addresses one execution (an approval decision) and
   *  how the runs panel keys its timeline rows. */
  id: string
  nodeId: string
  /** Denormalized so the run file and the pushed payload read on their own. */
  key: string
  kind: WorkflowNodeKind
  /** Iteration context: '' at the top level, otherwise '/'-joined segments of
   *  `<loopNodeId>#<index>`. */
  path: string
  /** Creation order within the run — the frontier's tie-break, stable across a
   *  reload because it is persisted rather than recomputed. */
  seq: number
  status: WorkflowNodeRunStatus
  /** Per inbound EDGE id, how it resolved. The join bookkeeping, on disk. */
  inbound: Record<string, 'satisfied' | 'pruned'>
  /** The output port this execution resolved to. Null until settled, and null
   *  forever for a pruned or cancelled one. RECORDED, never recomputed: recovery
   *  must replay a branch's decision, not re-derive it against a context that
   *  has moved on. */
  port: string | null

  /** Redacted and truncated: an agent prompt, an HTTP summary, an approval
   *  message. Never the raw render — that would put secrets on disk. */
  prompt: string | null
  text: string | null
  truncated: boolean
  output: unknown
  error: string | null
  warnings: string[]

  sessionId: string | null
  messageId: string | null
  retried: boolean
  attempt: number
  attempts: WorkflowRunAttempt[]
  retryAt: string | null
  startedAt: string | null
  completedAt: string | null

  loop: WorkflowRunLoop | null
  approval: WorkflowRunApproval | null
}

export interface WorkflowRunInput {
  body: unknown
  headers: Record<string, string>
  query: Record<string, string>
}

/** The slice of a run the scheduler reads and writes. `WorkflowRun` satisfies
 *  it structurally, so the store keeps its own richer type without this module
 *  having to know about sessions, triggers or history. */
export interface SchedulerRun {
  nodeRuns: WorkflowRunNodeRun[]
  /** Run-level variables written by `state` nodes. */
  state: Record<string, unknown>
  input: WorkflowRunInput | null
}

/**
 * ── Iteration paths ──────────────────────────────────────────────────────────
 *
 **/

/** The path a loop's body nodes carry on iteration `index`. */
export function loopBodyPath(loopRun: WorkflowRunNodeRun, index: number): string {
  const segment = `${loopRun.nodeId}#${index}`
  return loopRun.path ? `${loopRun.path}/${segment}` : segment
}

/** A path and every enclosing scope, innermost first: 'a#0/b#1' → ['a#0/b#1',
 *  'a#0', '']. How a loop body sees its own iteration's nodes AND the outer
 *  graph's, with one syntax. */
export function pathChain(path: string): string[] {
  const scopes: string[] = []
  const segments = path ? path.split('/') : []
  for (let depth = segments.length; depth > 0; depth--) scopes.push(segments.slice(0, depth).join('/'))
  scopes.push('')
  return scopes
}

/** Whether `path` is inside `prefix` (or is it). */
function pathWithin(path: string, prefix: string): boolean {
  if (!prefix) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * ── Node runs ────────────────────────────────────────────────────────────────
 *
 **/

export function findNodeRun(run: SchedulerRun, nodeId: string, path: string): WorkflowRunNodeRun | undefined {
  return run.nodeRuns.find((entry) => entry.nodeId === nodeId && entry.path === path)
}

/** Get or create the execution of `nodeId` in scope `path`. Lazy on purpose: a
 *  graph of 40 nodes with one taken path stores 6 node runs, not 40. */
export function ensureNodeRun(
  run: SchedulerRun,
  graph: CompiledGraph,
  nodeId: string,
  path: string,
): WorkflowRunNodeRun {
  const existing = findNodeRun(run, nodeId, path)
  if (existing) return existing

  const node = graph.nodes.get(nodeId)
  /* c8 ignore next — every caller walks an edge of the validated graph. */
  if (!node) throw new Error(`unknown node ${nodeId}`)

  const nodeRun: WorkflowRunNodeRun = {
    id: crypto.randomUUID(),
    nodeId,
    key: node.key,
    kind: node.kind,
    path,
    seq: run.nodeRuns.length,
    /**
     *
     * A node with no inbound edges (only `start`) is ready the moment it
     * exists; everything else waits for resolveJoin to say so.
     *
     **/
    status: (graph.inbound.get(nodeId)?.length ?? 0) === 0 ? 'pending' : 'blocked',
    inbound: {},
    port: null,
    prompt: null,
    text: null,
    truncated: false,
    output: null,
    error: null,
    warnings: [],
    sessionId: null,
    messageId: null,
    retried: false,
    attempt: 1,
    attempts: [],
    retryAt: null,
    startedAt: null,
    completedAt: null,
    loop: null,
    approval: null,
  }
  run.nodeRuns.push(nodeRun)
  return nodeRun
}

/** Edges leaving a node that carry flow onward. A loop's `body` port is excluded
 *  everywhere: the loop spawns its body itself, once per iteration, rather than
 *  settling into it. */
function forwardEdges(graph: CompiledGraph, nodeId: string): WorkflowEdge[] {
  return (graph.outbound.get(nodeId) ?? []).filter((edge) => edge.sourcePort !== 'body')
}

/** Settle one execution on `port` and resolve every successor it feeds. A null
 *  port means "this path died" and prunes them all. */
export function settleNodeRun(
  run: SchedulerRun,
  graph: CompiledGraph,
  nodeRun: WorkflowRunNodeRun,
  port: string | null,
): void {
  nodeRun.port = port
  if (!nodeRun.completedAt) nodeRun.completedAt = new Date().toISOString()

  for (const edge of forwardEdges(graph, nodeRun.nodeId)) {
    const target = ensureNodeRun(run, graph, edge.target, nodeRun.path)
    /**
     *
     * Already resolved by an earlier settle (a `join: 'any'` merge prunes its
     * losers up front) — never overwrite a decision.
     *
     **/
    if (target.inbound[edge.id] !== undefined) continue
    target.inbound[edge.id] = port !== null && edge.sourcePort === port ? 'satisfied' : 'pruned'
    resolveJoin(run, graph, target)
  }
}

/** Mark an execution as never-to-run and cascade the consequence forward. */
export function pruneNodeRun(run: SchedulerRun, graph: CompiledGraph, nodeRun: WorkflowRunNodeRun): void {
  if (nodeRun.status === 'pruned') return
  nodeRun.status = 'pruned'
  settleNodeRun(run, graph, nodeRun, null)
}

/** THE rule. See the module header. */
function resolveJoin(run: SchedulerRun, graph: CompiledGraph, target: WorkflowRunNodeRun): void {
  if (target.status !== 'blocked') return

  const incoming = graph.inbound.get(target.nodeId) ?? []
  const satisfied = incoming.some((edge) => target.inbound[edge.id] === 'satisfied')
  const resolved = incoming.every((edge) => target.inbound[edge.id] !== undefined)

  const node = graph.nodes.get(target.nodeId)
  if (node?.join === 'any' && satisfied) {
    /**
     *
     * First one home wins; the rest can never change the outcome, so record
     * them now rather than leaving the node waiting on paths it doesn't need.
     *
     **/
    for (const edge of incoming) target.inbound[edge.id] ??= 'pruned'
    target.status = 'pending'
    return
  }

  if (!resolved) return
  if (satisfied) target.status = 'pending'
  else pruneNodeRun(run, graph, target)
}

/** Spawn iteration `index` of a loop's body: every node its `body` port points
 *  at starts a fresh execution in the iteration's own scope. */
export function spawnLoopIteration(
  run: SchedulerRun,
  graph: CompiledGraph,
  loopRun: WorkflowRunNodeRun,
  index: number,
): WorkflowRunNodeRun[] {
  const path = loopBodyPath(loopRun, index)
  const spawned: WorkflowRunNodeRun[] = []
  for (const edge of graph.outbound.get(loopRun.nodeId) ?? []) {
    if (edge.sourcePort !== 'body') continue
    const bodyRun = ensureNodeRun(run, graph, edge.target, path)
    bodyRun.inbound[edge.id] = 'satisfied'
    resolveJoin(run, graph, bodyRun)
    spawned.push(bodyRun)
  }
  return spawned
}

/** Whether anything in this iteration's scope is still going. */
export function loopIterationActive(run: SchedulerRun, loopRun: WorkflowRunNodeRun, index: number): boolean {
  const prefix = loopBodyPath(loopRun, index)
  return run.nodeRuns.some((entry) => pathWithin(entry.path, prefix) && ACTIVE_NODE_STATUSES.has(entry.status))
}

/** A loop sits `running` while its body executes, so it is NOT in the ready set
 *  and nothing would otherwise ever come back to it. This closes the circle:
 *  once an iteration has no live executions left, its loop becomes ready again
 *  so the caller can bank the results and decide whether to spawn another pass.
 *
 *  Without this a loop hangs forever after its first iteration — the run has
 *  nothing ready, nothing running that will finish, and no deadlock either.
 *  Innermost-first (longest path), so a nested loop closes its own iteration
 *  before the outer one is told anything happened. */
export function promoteFinishedLoops(run: SchedulerRun): WorkflowRunNodeRun[] {
  const promoted: WorkflowRunNodeRun[] = []
  const loops = run.nodeRuns
    .filter((entry) => entry.kind === 'loop' && entry.status === 'running' && entry.loop)
    .sort((a, b) => b.path.length - a.path.length)

  for (const loopRun of loops) {
    if (loopIterationActive(run, loopRun, loopRun.loop!.index)) continue
    loopRun.status = 'pending'
    promoted.push(loopRun)
  }
  return promoted
}

/** What one finished iteration contributed, in the same shape `nodes.<key>`
 *  exposes — so `{{nodes.each.output.results.0.fetch.output}}` reads naturally. */
export function collectLoopIteration(
  run: SchedulerRun,
  loopRun: WorkflowRunNodeRun,
  index: number,
): LoopIterationResult {
  const prefix = loopBodyPath(loopRun, index)
  const result: LoopIterationResult = {}
  for (const entry of run.nodeRuns) {
    if (entry.status !== 'done' || !pathWithin(entry.path, prefix) || !entry.key) continue
    result[entry.key] = { text: entry.text ?? '', output: entry.output }
  }
  return result
}

/**
 * ── The frontier ─────────────────────────────────────────────────────────────
 *
 **/

export function readyNodeRuns(run: SchedulerRun): WorkflowRunNodeRun[] {
  return run.nodeRuns.filter((entry) => entry.status === 'pending')
}

/** The next execution to run. Ordered by creation, which follows the graph's own
 *  edge order — deterministic for a given graph and a given set of decisions, and
 *  stable across a restart because `seq` is persisted rather than recomputed. */
export function pickReadyNodeRun(run: SchedulerRun): WorkflowRunNodeRun | undefined {
  let best: WorkflowRunNodeRun | undefined
  for (const entry of run.nodeRuns) {
    if (entry.status !== 'pending') continue
    if (!best || entry.seq < best.seq) best = entry
  }
  return best
}

/** No execution is ready and none is in flight — the run has nothing left to do. */
export function runIsIdle(run: SchedulerRun): boolean {
  return !run.nodeRuns.some((entry) => ACTIVE_NODE_STATUSES.has(entry.status))
}

/** A run with nothing runnable but something still `blocked` is DEADLOCKED: an
 *  inbound edge never resolved. The tempting alternative is to treat "nothing
 *  ready" as "everything finished" and close the run `done` — but that reports a
 *  broken join as a success, which is the difference between a bug you find and
 *  a run that silently did half its work. */
export function deadlockedNodeRun(run: SchedulerRun): WorkflowRunNodeRun | undefined {
  const live = run.nodeRuns.some((entry) => entry.status !== 'blocked' && ACTIVE_NODE_STATUSES.has(entry.status))
  if (live) return undefined
  return run.nodeRuns.find((entry) => entry.status === 'blocked')
}

/**
 * ── Context ──────────────────────────────────────────────────────────────────
 *
 **/

/** Node outputs visible from `path`: this iteration's first, then each enclosing
 *  scope's. Only `done` executions enter — a pruned node is ABSENT, so a template
 *  reading one gets the usual `missing-path` warning rather than stale data. */
function visibleNodes(run: SchedulerRun, path: string): Record<string, { text: string; output: unknown }> {
  const visible: Record<string, { text: string; output: unknown }> = {}
  for (const scope of pathChain(path)) {
    for (const entry of run.nodeRuns) {
      if (entry.path !== scope || entry.status !== 'done' || !entry.key) continue
      /**
       *
       * Innermost scope wins: a body node shadows an outer node of the same key.
       *
       **/
      if (!(entry.key in visible)) visible[entry.key] = { text: entry.text ?? '', output: entry.output }
    }
  }
  return visible
}

/** Loop variables in scope at `path`, keyed by the loop's node key, plus `loop`
 *  as an alias for the innermost one — so a single-level body just says
 *  `{{loop.item}}`. */
function loopFrames(
  run: SchedulerRun,
  graph: CompiledGraph,
  path: string,
): { frames: Record<string, unknown>; innermost: unknown } {
  const frames: Record<string, unknown> = {}
  let innermost: unknown
  const segments = path ? path.split('/') : []
  /**
   *
   * Each segment names a loop that is enclosing us; the loop node run itself
   * lives in the scope OUTSIDE that segment, which is everything before it.
   *
   **/
  for (let depth = 0; depth < segments.length; depth++) {
    const [nodeId = '', rawIndex = '0'] = segments[depth]!.split('#')
    const loopRun = findNodeRun(run, nodeId, segments.slice(0, depth).join('/'))
    const node = graph.nodes.get(nodeId)
    if (!loopRun || !node) continue

    const index = Number(rawIndex)
    const total = loopRun.loop?.total ?? null
    const frame = {
      index,
      item: loopRun.loop?.items?.[index] ?? null,
      count: total,
      first: index === 0,
      last: total === null ? false : index === total - 1,
    }
    frames[node.key] = frame
    innermost = frame
  }
  return { frames, innermost }
}

/** The context every template, condition and mapping in a run evaluates over.
 *  `extra` carries what only the caller knows — a loop's current `item` while
 *  its source array is still in hand. */
export function buildRunContext(
  run: SchedulerRun,
  graph: CompiledGraph,
  path: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { frames, innermost } = loopFrames(run, graph, path)
  return {
    trigger: run.input ?? { body: null, headers: {}, query: {} },
    input: run.input?.body ?? null,
    nodes: visibleNodes(run, path),
    state: run.state,
    loops: frames,
    ...(innermost === undefined ? {} : { loop: innermost }),
    ...extra,
  }
}

/** Apply a `state` node's assignments, returning the warnings they raised. */
export function applyStateAssignments(
  run: SchedulerRun,
  assignments: ReadonlyArray<{ key: string; value: import('./workflow-mapping.js').Mapping }>,
  context: Record<string, unknown>,
): string[] {
  const warnings: string[] = []
  for (const assignment of assignments) {
    const result = evaluateMapping(assignment.value, context)
    run.state[assignment.key] = result.value
    for (const warning of result.warnings) if (!warnings.includes(warning)) warnings.push(warning)
  }
  return warnings
}

/** Which node kinds suspend the run rather than settling inside their own
 *  dispatch. Everything else drains in one pass, so a graph of ten branches and
 *  transforms advances in milliseconds instead of ten five-second ticks. */
export function suspends(node: WorkflowNode): boolean {
  return node.kind === 'agent' || node.kind === 'approval'
}
