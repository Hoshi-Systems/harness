import { ports } from './host.js'
import { listActiveWorkflowRuns } from './workflow-run-queries.js'
import { graphOf, httpInFlight, runStore, trimRuns } from './workflow-run-state.js'
import {
  apiError,
  latestAssistantMessage,
  replyText,
  turnErrorSummary,
  type OcAssistantMessage,
  createCachedStore,
  publishMachineEvent,
  type MachineEvent,
} from '../../kernel/index.js'
import { compileGraph, outputPorts, retriesFor, type CompiledGraph, type WorkflowGraph } from './graph/index.js'
import { evaluateMapping } from './workflow-mapping.js'
import {
  ACTIVE_NODE_STATUSES,
  applyStateAssignments,
  buildRunContext,
  collectLoopIteration,
  deadlockedNodeRun,
  ensureNodeRun,
  promoteFinishedLoops,
  pickReadyNodeRun,
  pruneNodeRun,
  runIsIdle,
  settleNodeRun,
  spawnLoopIteration,
  suspends,
  type WorkflowRunInput,
  type WorkflowRunNodeRun,
} from './workflow-scheduler.js'
import {
  abortSession,
  createRunSession,
  extractJsonOutput,
  resolveRunDirectory,
  retryInstruction,
  schemaInstruction,
  sendNodePrompt,
} from './workflow-executor.js'
import { tryCondition } from './workflow-condition.js'
import { performHttpStep } from './workflow-http.js'
import { nodeSecretSources, redactSecrets, referencedSecretKeys, resolveSecrets } from './workflow-secrets.js'
import { renderTemplate } from './workflow-template.js'
export type { WorkflowRun, WorkflowRunSource, WorkflowRunStatus, WorkflowRunStore } from './workflow-run-types.js'
import type { WorkflowRun, WorkflowRunSource, WorkflowRunStatus, WorkflowRunStore } from './workflow-run-types.js'
import {
  MAX_DRAIN,
  MAX_LOOP_TEXT_RESULTS,
  MAX_NODE_RUNS,
  MAX_RETRY_DELAY_MS,
  MAX_RUNS,
  NODE_TEXT_MAX,
  NODE_TIMEOUT_MS,
  isSettled,
  noteMissing,
  noteWarning,
  retryDelayMs,
  stripText,
  truncate,
} from './workflow-run-support.js'
import type { Workflow } from './workflows.js'

/**
 * ── Workflow run queue + state machine ───────────────────────────────────────
 *
 * Execution history and live state for workflows (utils/workflows.ts) — the same
 * config-vs-history split as triggers.ts vs task-queue.ts, and the same queue
 * mechanics as task-queue.ts: a chained-promise advance gate holding concurrency
 * at 1, fire-and-forget persists, and a `workflow.run.updated` push on every
 * transition.
 *
 * This module owns the STORE and the SIDE EFFECTS. The graph algebra — which
 * node executions exist, which are ready, how a branch prunes the paths nobody
 * took — is utils/workflow-scheduler.ts, kept pure so it can be tested without
 * an OpenCode anywhere near it. The OpenCode mechanics are
 * utils/workflow-executor.ts, kept import-cycle-free the way task-queue.ts leans
 * on dispatch.ts.
 *
 * A run executes a SNAPSHOT of the graph taken at enqueue time, so editing a
 * workflow never changes a run already in flight. All agent nodes share one
 * session (the run reads as a single chat thread) unless a node opts into
 * isolation with `freshSession`.
 *
 * PARALLEL SHAPE, SERIAL EXECUTION. The graph can fan out, and the ready set can
 * hold several node executions at once, but exactly one is dispatched at a time
 * and one run is in flight machine-wide. The reason is the shared session: two
 * agent nodes prompting it concurrently makes "the newest assistant message"
 * ambiguous, and that single fact is what the whole completion mechanism rests
 * on. Real parallelism therefore needs a subsession per branch — a different
 * product, and a much larger token bill — so it is not smuggled in here.
 *
 * The one thing that does NOT hold the concurrency slot is a run parked on a
 * human approval. See `waiting`.
 *
 **/

/**
 * ── Enqueue ──────────────────────────────────────────────────────────────────
 *
 **/

export async function enqueueWorkflowRun(fields: {
  workflow: Workflow
  graph: WorkflowGraph
  version: number | null
  source: WorkflowRunSource
  triggerId: string | null
  input: WorkflowRunInput | null
}): Promise<WorkflowRun> {
  const store = await runStore.load()
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    workflowId: fields.workflow.id,
    workflowName: fields.workflow.name,
    version: fields.version,
    projectId: fields.workflow.projectId,
    directory: null,
    source: fields.source,
    triggerId: fields.triggerId,
    status: 'queued',
    input: fields.input,
    sessionId: null,
    sessionCursor: null,
    graph: structuredClone(fields.graph),
    nodeRuns: [],
    state: {},
    output: null,
    error: null,
    warnings: [],
    queuedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  }
  store.runs.push(run)
  store.runs = trimRuns(store.runs)
  publishRun(run)
  void processRunQueue()
  return run
}

/**
 *
 * Chained the same way task-queue.ts chains processQueue(): the "is anything
 * running?" check and the "mark one running" write always happen as one atomic
 * step per call, so two triggers firing at once can never both start a run.
 *
 **/
let advanceQueue: Promise<void> = Promise.resolve()

/** Vault values this node could interpolate — resolved from the NAMES its
 *  templated fields reference, whichever kind of node it is. */
async function nodeSecrets(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<Map<string, string>> {
  const node = graphOf(run).nodes.get(nodeRun.nodeId)
  if (!node) return new Map()
  return resolveSecrets(referencedSecretKeys(nodeSecretSources(node)))
}

/** Strip this node's secrets out of text on its way into the run record. Values
 *  are re-read from the vault by NAME, so nothing sensitive has to be held in
 *  memory between dispatch and reply — which is also why this still works after
 *  a restart. */
export async function redactNodeText(run: WorkflowRun, nodeRun: WorkflowRunNodeRun, text: string): Promise<string> {
  const secrets = await nodeSecrets(run, nodeRun)
  return secrets.size === 0 ? text : redactSecrets(text, secrets.values())
}

/** Persist + push one run's state — the single funnel every transition goes
 *  through, so clients never miss a flip. A settled run also leaves the machine
 *  here (job 05): runs execute unattended by construction, so their outcome has
 *  to reach someone with no client open. */
export function publishRun(run: WorkflowRun): void {
  runStore.persist()
  publishMachineEvent('workflow.run.updated', { run })
  /**
   *
   * The owner hears about a run that ENDED, on whatever channels they watch —
   * a run nobody was watching is exactly the one worth being told about.
   *
   **/
  void ports().notify?.({
    kind: run.status === 'done' ? 'complete' : 'error',
    detail: `${run.workflowName}${run.error ? ` — ${run.error}` : ''}`,
    dedupKey: `workflow-run:${run.id}:${run.status}`,
    projectId: run.projectId ?? null,
  })
}

export async function processRunQueue(): Promise<void> {
  advanceQueue = advanceQueue.then(startNextRun)
  await advanceQueue
}

/** The concurrency gate: at most one workflow run in flight at a time.
 *
 *  It counts `running` and nothing else. A run in `waiting` is parked on a human
 *  decision that may not come for days, and holding the machine's only slot
 *  meanwhile would freeze every other workflow, schedule and webhook on it. */
async function startNextRun(): Promise<void> {
  const store = await runStore.load()
  if (store.runs.some((run) => run.status === 'running')) return
  const run = store.runs.find((entry) => entry.status === 'queued')
  if (!run) return

  run.status = 'running'
  run.startedAt ??= new Date().toISOString()
  publishRun(run)

  try {
    /**
     *
     * A resumed run (an approval was answered) already has its frontier; only a
     * fresh one needs seeding. The SESSION is deliberately not created here —
     * see `runSession`.
     *
     **/
    if (run.nodeRuns.length === 0) {
      run.directory = await resolveRunDirectory(run.projectId)
      if (run.directory === null) {
        failRun(run, 'The bound project checkout is not available on this machine.')
        return
      }
      ensureNodeRun(run, graphOf(run), graphOf(run).start.id, '')
      publishRun(run)
    }
    await advanceRun(run)
  } catch (error) {
    failRun(run, String(error))
  }
}

/** The run's shared session, created on first use rather than at startup.
 *
 *  Lazily, because a graph of transforms, branches and HTTP requests never
 *  prompts a model — and creating a session for one would open an empty chat
 *  thread the user never asked for AND make a pure-data workflow fail outright
 *  on a machine whose runtime happens to be down. The session is what makes a
 *  run read as a single thread, so it is still shared by every agent node; it
 *  just doesn't exist until one of them needs it. */
async function runSession(run: WorkflowRun): Promise<string> {
  run.sessionId ??= await createRunSession(run.workflowName, run.directory, run.projectId)
  return run.sessionId
}

/**
 * ── The advance loop ─────────────────────────────────────────────────────────
 *
 **/

/** Drain the ready set until something suspends the run or nothing is left.
 *  Non-suspending kinds settle inside their own execution, so a graph of ten
 *  branches and transforms advances in milliseconds rather than ten ticks. */
export async function advanceRun(run: WorkflowRun): Promise<void> {
  const graph = graphOf(run)

  for (let drained = 0; drained < MAX_DRAIN; drained++) {
    if (run.nodeRuns.length > MAX_NODE_RUNS) {
      failRun(run, 'This run executed too many nodes — check its loops for a runaway.')
      return
    }

    promoteFinishedLoops(run)

    const next = pickReadyNodeRun(run)
    if (!next) {
      settleIdleRun(run)
      return
    }

    const node = graph.nodes.get(next.nodeId)
    /* c8 ignore next — every node run is created from a validated graph. */
    if (!node) {
      failRun(run, `The run referenced a node that is not in its graph.`)
      return
    }

    if (suspends(node)) {
      await dispatchSuspendingNode(run, next)
      return
    }
    await executeInlineNode(run, next)
    if (run.status !== 'running') return
  }
}

/** Nothing is ready and nothing is in flight — decide what that MEANS. */
function settleIdleRun(run: WorkflowRun): void {
  /**
   *
   * Everything live is parked on a person: release the machine's slot.
   *
   **/
  const parked = run.nodeRuns.some((entry) => entry.status === 'waiting')
  if (parked) {
    run.status = 'waiting'
    publishRun(run)
    void processRunQueue()
    return
  }

  const stuck = deadlockedNodeRun(run)
  if (stuck) {
    failRun(run, `The run stalled at "${stuck.key || stuck.kind}" — one of its inputs never arrived.`)
    return
  }
  if (!runIsIdle(run)) return

  /**
   *
   * No `end` node was reached: every path either pruned or stopped at a leaf.
   * That is a legitimate outcome, not a failure — but say so, because a graph
   * whose branches all dead-end is usually a graph missing an edge.
   *
   **/
  if (run.output === null && !run.nodeRuns.some((entry) => entry.kind === 'end' && entry.status === 'done')) {
    if (!run.warnings.includes('no-end-reached')) run.warnings.push('no-end-reached')
  }
  run.status = 'done'
  run.completedAt = new Date().toISOString()
  publishRun(run)
  void processRunQueue()
}

/**
 * ── Inline nodes ─────────────────────────────────────────────────────────────
 *
 * Everything that settles without waiting on a person or a model turn.
 *
 **/

async function executeInlineNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<void> {
  const graph = graphOf(run)
  const node = graph.nodes.get(nodeRun.nodeId)!
  nodeRun.status = 'running'
  nodeRun.startedAt = new Date().toISOString()

  const context = buildRunContext(run, graph, nodeRun.path)

  switch (node.kind) {
    case 'start':
      nodeRun.status = 'done'
      settleNodeRun(run, graph, nodeRun, 'out')
      break

    case 'branch': {
      let taken = 'else'
      for (const entry of node.cases) {
        const { value, error } = tryCondition(entry.when, context)
        if (error) noteWarning(nodeRun, `condition-parse-failed:${entry.id}`)
        if (value) {
          taken = `case:${entry.id}`
          break
        }
      }
      nodeRun.status = 'done'
      nodeRun.text = taken
      settleNodeRun(run, graph, nodeRun, taken)
      break
    }

    case 'transform': {
      const result = evaluateMapping(node.mapping, context)
      for (const warning of result.warnings) noteWarning(nodeRun, warning)
      nodeRun.output = result.value
      nodeRun.status = 'done'
      settleNodeRun(run, graph, nodeRun, 'out')
      break
    }

    case 'state': {
      for (const warning of applyStateAssignments(run, node.assignments, context)) noteWarning(nodeRun, warning)
      nodeRun.output = { ...run.state }
      nodeRun.status = 'done'
      settleNodeRun(run, graph, nodeRun, 'out')
      break
    }

    case 'http':
      await executeHttpNode(run, nodeRun)
      return

    case 'loop':
      advanceLoopNode(run, nodeRun)
      break

    case 'end': {
      if (node.output) {
        const result = evaluateMapping(node.output, context)
        for (const warning of result.warnings) noteWarning(nodeRun, warning)
        nodeRun.output = result.value
        run.output = result.value
      }
      nodeRun.status = 'done'
      nodeRun.completedAt = new Date().toISOString()
      /**
       *
       * An `end` terminates the whole run, not just its own path: anything still
       * in flight elsewhere is cancelled rather than left to finish into a run
       * that has already reported its outcome.
       *
       **/
      if (node.outcome === 'error') {
        const message = node.message ? renderTemplate(node.message, context).redacted : 'The workflow ended in failure.'
        failRun(run, message)
        return
      }
      finishRun(run)
      return
    }

    /* c8 ignore next 3 — a note never enters the ready set (nothing connects to it). */
    default:
      nodeRun.status = 'done'
      settleNodeRun(run, graph, nodeRun, 'out')
  }

  publishRun(run)
}

/** A loop node is visited repeatedly: once to start, then once per finished
 *  iteration. `loop.index` is the bookkeeping, and it lives on disk, so a
 *  restart mid-loop resumes on the right iteration. */
function advanceLoopNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): void {
  const graph = graphOf(run)
  const node = graph.nodes.get(nodeRun.nodeId)!
  /* c8 ignore next */
  if (node.kind !== 'loop') return

  if (!nodeRun.loop) {
    const context = buildRunContext(run, graph, nodeRun.path)
    let items: unknown[] | null = null
    if (node.mode === 'foreach') {
      const result = evaluateMapping(node.source!, context)
      for (const warning of result.warnings) noteWarning(nodeRun, warning)
      if (!Array.isArray(result.value)) {
        noteWarning(nodeRun, 'loop-source-not-array')
        items = []
      } else {
        items = result.value
      }
    }
    nodeRun.loop = { index: 0, total: items ? items.length : null, items, results: [] }
  } else {
    /**
     *
     * An iteration just finished — bank what it produced and step the counter.
     *
     **/
    const finished = nodeRun.loop.index
    const result = collectLoopIteration(run, nodeRun, finished)
    nodeRun.loop.results.push(finished < MAX_LOOP_TEXT_RESULTS ? result : stripText(result))
    nodeRun.loop.index++
  }

  const loop = nodeRun.loop
  const exhausted = loop.total !== null && loop.index >= loop.total
  const capped = loop.index >= node.maxIterations
  const whileHolds =
    node.mode !== 'while' ||
    (() => {
      const { value, error } = tryCondition(node.while!, buildRunContext(run, graph, nodeRun.path))
      if (error) noteWarning(nodeRun, 'condition-parse-failed:while')
      return value
    })()

  if (capped && !exhausted) noteWarning(nodeRun, 'loop-max-iterations')

  if (exhausted || capped || !whileHolds) {
    nodeRun.status = 'done'
    nodeRun.output = { count: loop.index, results: loop.results }
    settleNodeRun(run, graph, nodeRun, 'done')
    return
  }

  nodeRun.status = 'running'
  spawnLoopIteration(run, graph, nodeRun, loop.index)
}

async function executeHttpNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<void> {
  const graph = graphOf(run)
  const node = graph.nodes.get(nodeRun.nodeId)!
  /* c8 ignore next */
  if (node.kind !== 'http') return

  const secrets = await nodeSecrets(run, nodeRun)
  nodeRun.status = 'running'
  nodeRun.retryAt = null
  nodeRun.startedAt = new Date().toISOString()
  publishRun(run)

  httpInFlight.add(nodeRun.id)
  let result
  try {
    result = await performHttpStep(node.http, buildRunContext(run, graph, nodeRun.path), secrets)
  } finally {
    httpInFlight.delete(nodeRun.id)
  }

  noteMissing(nodeRun, result.missing)
  nodeRun.prompt = truncate(result.summary).text
  if (result.error) {
    await nodeErrored(run, nodeRun, `${result.summary} — ${result.error}`)
    return
  }

  /**
   *
   * performHttpStep already redacted its own render; this second pass catches a
   * secret the ENDPOINT echoed back at us.
   *
   **/
  const stored = truncate(redactSecrets(result.text, secrets.values()))
  nodeRun.status = 'done'
  nodeRun.text = stored.text
  nodeRun.truncated = stored.truncated
  nodeRun.output = JSON.parse(redactSecrets(JSON.stringify(result.output), secrets.values()))
  settleNodeRun(run, graph, nodeRun, 'out')
  publishRun(run)
  await advanceRun(run)
}

/**
 * ── Suspending nodes ─────────────────────────────────────────────────────────
 *
 **/

/** Re-run a node whose backoff has elapsed. Routed by KIND, because only
 *  `agent` and `http` carry a retry policy at all and they dispatch through
 *  completely different paths — an http node settles inside its own execution
 *  while an agent node suspends waiting for a turn. Sending both through the
 *  suspending path silently does nothing for http, which parks the run in
 *  `retrying` forever. */
export async function redispatchNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<void> {
  if (nodeRun.kind === 'http') {
    await executeHttpNode(run, nodeRun)
    return
  }
  await dispatchSuspendingNode(run, nodeRun)
}

/** The announcement that an approval is waiting on a person — built HERE and
 *  nowhere else, because it now has two senders: the moment the run parks, and
 *  the replay below for a client that connected afterwards. Two hand-written
 *  copies of this payload would agree until the day one of them gained a field. */
function approvalRequested(run: WorkflowRun, nodeRun: WorkflowRunNodeRun, title: string): MachineEvent {
  return {
    type: 'workflow.approval.requested',
    properties: {
      runId: run.id,
      nodeRunId: nodeRun.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      title,
      message: nodeRun.prompt,
      expiresAt: nodeRun.approval?.expiresAt ?? null,
      projectId: run.projectId,
    },
  }
}

/**
 *
 * Every approval still waiting on a person, re-announced to a client that has
 * just connected.
 *
 * Without this the announcement was a single push at the instant the run
 * parked, and anyone not already listening never heard it: a browser opened
 * after the fact, a tab that reconnected through a network blip, a phone woken
 * from the background. An approval can sit for days — the state most likely to
 * be discovered late is exactly the one this covers — and the only alternative
 * left to a client was to diff whole run payloads looking for a node that had
 * turned `waiting`, which is not an inbox, it is a poll wearing one.
 *
 * A client that connected just BEFORE the run parked can receive the same
 * approval twice: once live, once here. That is deliberate and cheap to absorb
 * — `nodeRunId` is stable, so an inbox keyed on it dedupes for free, and the
 * alternative (tracking which client has heard what) is state the machine has
 * no way to hold honestly across a reconnect.
 *
 **/
export async function replayPendingApprovals(push: (event: MachineEvent) => void): Promise<void> {
  for (const run of await listActiveWorkflowRuns(['waiting'])) {
    const graph = graphOf(run)
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.kind !== 'approval' || nodeRun.status !== 'waiting') continue
      const node = graph.nodes.get(nodeRun.nodeId)
      if (node?.kind !== 'approval') continue
      push(approvalRequested(run, nodeRun, node.title))
    }
  }
}

async function dispatchSuspendingNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<void> {
  const graph = graphOf(run)
  const node = graph.nodes.get(nodeRun.nodeId)!

  if (node.kind === 'approval') {
    const context = buildRunContext(run, graph, nodeRun.path)
    const rendered = renderTemplate(node.message, context)
    noteMissing(nodeRun, rendered.missing)
    nodeRun.prompt = truncate(rendered.redacted).text
    nodeRun.status = 'waiting'
    nodeRun.startedAt = new Date().toISOString()
    nodeRun.approval = {
      requestedAt: new Date().toISOString(),
      expiresAt: node.timeoutSeconds ? new Date(Date.now() + node.timeoutSeconds * 1_000).toISOString() : null,
      decision: null,
      decidedAt: null,
      decidedBy: null,
      comment: null,
    }
    publishRun(run)
    const asked = approvalRequested(run, nodeRun, node.title)
    publishMachineEvent(asked.type, asked.properties)
    settleIdleRun(run)
    return
  }

  await dispatchAgentNode(run, nodeRun)
}

/** Render and fire an agent node. The stored baseline `messageId` is the
 *  session's newest assistant message BEFORE our prompt, so the poll can tell
 *  the new turn apart from what was already there.
 *
 *  Secrets are resolved HERE and only here: the run record keeps the redacted
 *  render, the agent gets the real one. */
async function dispatchAgentNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun): Promise<void> {
  const graph = graphOf(run)
  const node = graph.nodes.get(nodeRun.nodeId)!
  /* c8 ignore next */
  if (node.kind !== 'agent') return

  const secrets = await nodeSecrets(run, nodeRun)
  const rendered = renderTemplate(node.prompt, buildRunContext(run, graph, nodeRun.path), secrets)
  noteMissing(nodeRun, rendered.missing)

  /**
   *
   * Attempt 2+ always gets its own session, even for a node that normally shares
   * the run's thread: retrying inside a session that already holds the failed
   * attempt tends to reproduce the failure.
   *
   **/
  const isolated = node.freshSession || nodeRun.attempt > 1
  /**
   *
   * The shared session is materialized even for an isolated node: an isolated
   * one is a SUBSESSION of the run's thread, so the parent has to exist.
   *
   **/
  const shared = await runSession(run)
  if (isolated && !nodeRun.sessionId) {
    nodeRun.sessionId = await createRunSession(
      nodeRun.attempt > 1
        ? `${run.workflowName} · ${node.name} (${nodeRun.attempt})`
        : `${run.workflowName} · ${node.name}`,
      run.directory,
      run.projectId,
      shared,
    )
  }
  const sessionId = nodeRun.sessionId ?? shared

  nodeRun.messageId = (await latestAssistantMessage(sessionId, run.directory))?.info.id ?? null
  nodeRun.status = 'running'
  nodeRun.retryAt = null
  nodeRun.prompt = truncate(rendered.redacted).text
  nodeRun.startedAt = new Date().toISOString()
  publishRun(run)

  const prompt = node.outputSchema ? `${rendered.text}${schemaInstruction(node.outputSchema)}` : rendered.text
  await sendNodePrompt(sessionId, run.directory, node, prompt)
}

/**
 * ── Approvals ────────────────────────────────────────────────────────────────
 *
 **/

export async function decideWorkflowApproval(fields: {
  runId: string
  nodeRunId: string
  decision: 'approved' | 'rejected'
  decidedBy: string | null
  comment: string | null
}): Promise<WorkflowRun> {
  const store = await runStore.load()
  const run = store.runs.find((entry) => entry.id === fields.runId)
  if (!run) apiError(404, 'workflowRun.notFound', 'Workflow run not found.')

  const nodeRun = run.nodeRuns.find((entry) => entry.id === fields.nodeRunId)
  if (!nodeRun || !nodeRun.approval) {
    apiError(404, 'workflowRun.approvalNotFound', 'That approval is not part of this run.')
  }
  /**
   *
   * Idempotency: a second click, or two people answering at once, must not
   * re-decide a settled gate.
   *
   **/
  if (nodeRun.status !== 'waiting' || nodeRun.approval.decision !== null) {
    apiError(409, 'workflowRun.approvalSettled', 'That approval has already been answered.')
  }

  nodeRun.approval.decision = fields.decision
  nodeRun.approval.decidedAt = new Date().toISOString()
  nodeRun.approval.decidedBy = fields.decidedBy
  nodeRun.approval.comment = fields.comment
  nodeRun.status = 'done'
  settleNodeRun(run, graphOf(run), nodeRun, fields.decision)

  publishMachineEvent('workflow.approval.decided', {
    runId: run.id,
    nodeRunId: nodeRun.id,
    decision: fields.decision,
    decidedBy: fields.decidedBy,
  })
  resumeParkedRun(run)
  return run
}

/** Put a parked run back in the queue. `queuedAt` is deliberately left alone, so
 *  FIFO puts a just-answered run ahead of anything enqueued while it waited —
 *  which is the right priority when a person is on the other end of it. */
function resumeParkedRun(run: WorkflowRun): void {
  run.status = 'queued'
  publishRun(run)
  void processRunQueue()
}

/** Apply the `onTimeout` policy to any approval whose deadline has passed. */
export async function sweepApprovals(run: WorkflowRun): Promise<void> {
  const graph = graphOf(run)
  let changed = false

  for (const nodeRun of run.nodeRuns) {
    if (nodeRun.status !== 'waiting' || !nodeRun.approval?.expiresAt) continue
    if (Date.parse(nodeRun.approval.expiresAt) > Date.now()) continue

    const node = graph.nodes.get(nodeRun.nodeId)!
    /* c8 ignore next */
    if (node.kind !== 'approval') continue

    if (node.onTimeout === 'fail') {
      failRun(run, `The approval "${node.title}" expired.`)
      return
    }
    noteWarning(nodeRun, 'approval-timed-out')
    nodeRun.approval.decision = node.onTimeout
    nodeRun.approval.decidedAt = new Date().toISOString()
    nodeRun.status = 'done'
    settleNodeRun(run, graph, nodeRun, node.onTimeout)
    changed = true
  }

  if (changed) resumeParkedRun(run)
}

/**
 * ── Errors and settling ──────────────────────────────────────────────────────
 *
 **/

/** A node ERRORED — it timed out, the turn came back with a runtime error, or
 *  the dispatch threw. That is the retryable class: nothing about the answer was
 *  wrong, the attempt never produced one.
 *
 *  A node that FAILED is a different thing and deliberately does not come here:
 *  a schema-bearing node whose reply still doesn't parse after its correction
 *  turn records `output-parse-failed` and carries on, because re-asking in a
 *  fresh session reproduces it. Retries exist to survive transient breakage,
 *  never to grind at a bad answer. */
export async function nodeErrored(run: WorkflowRun, nodeRun: WorkflowRunNodeRun, rawMessage: string): Promise<void> {
  const message = await redactNodeText(run, nodeRun, rawMessage)
  nodeRun.attempts.push({
    attempt: nodeRun.attempt,
    sessionId: nodeRun.sessionId,
    error: message,
    startedAt: nodeRun.startedAt,
    failedAt: new Date().toISOString(),
  })

  const node = graphOf(run).nodes.get(nodeRun.nodeId)!
  const policy = retriesFor(node)
  if (nodeRun.attempt > (policy?.count ?? 0)) {
    failRun(run, message)
    return
  }

  nodeRun.error = message
  nodeRun.retryAt = new Date(Date.now() + retryDelayMs(policy!.backoffSeconds, nodeRun.attempt)).toISOString()
  nodeRun.attempt++
  nodeRun.status = 'retrying'
  /**
   *
   * Force a fresh session for the next attempt.
   *
   **/
  nodeRun.sessionId = null
  nodeRun.messageId = null
  nodeRun.retried = false
  nodeRun.startedAt = null
  publishRun(run)
}

/** Settle a run as failed. Unfinished executions are `cancelled`, NOT `pruned` —
 *  the graph never decided against them, the run just ended first. */
function failRun(run: WorkflowRun, message: string): void {
  for (const nodeRun of run.nodeRuns) {
    if (nodeRun.status === 'running' || nodeRun.status === 'retrying') {
      nodeRun.status = 'error'
      nodeRun.error = message
      nodeRun.retryAt = null
      nodeRun.completedAt = new Date().toISOString()
    } else if (ACTIVE_NODE_STATUSES.has(nodeRun.status)) {
      nodeRun.status = 'cancelled'
      nodeRun.retryAt = null
    }
  }
  run.status = 'error'
  run.error = message
  run.completedAt = new Date().toISOString()
  publishRun(run)
  void processRunQueue()
}

function finishRun(run: WorkflowRun): void {
  for (const nodeRun of run.nodeRuns) {
    if (ACTIVE_NODE_STATUSES.has(nodeRun.status)) nodeRun.status = 'cancelled'
  }
  run.status = 'done'
  run.completedAt = new Date().toISOString()
  publishRun(run)
  void processRunQueue()
}

/**
 * ── The tick ─────────────────────────────────────────────────────────────────
 *
 **/

/**
 * ── Cancellation and recovery ────────────────────────────────────────────────
 *
 **/
