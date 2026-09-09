import { latestAssistantMessage, replyText, turnErrorSummary } from '../../kernel/index.js'
import { ports } from './host.js'
import { advanceRun, nodeErrored, publishRun, redactNodeText, redispatchNode, sweepApprovals } from './workflow-runs.js'
import { graphOf, httpInFlight, runStore } from './workflow-run-state.js'
import { NODE_TEXT_MAX, NODE_TIMEOUT_MS, noteWarning, truncate } from './workflow-run-support.js'
import { abortSession, extractJsonOutput, retryInstruction, sendNodePrompt } from './workflow-executor.js'
import { pickReadyNodeRun, settleNodeRun } from './workflow-scheduler.js'
import type { CompiledGraph } from './graph/index.js'
import type { WorkflowRun, WorkflowRunNodeRun } from './workflow-run-types.js'

/**
 * ── Catching up with what the machine did while nobody looked ────────────────
 *
 * The five-second tick, and everything it reaches: whether a dispatched node's
 * session has finished, whether a turn started before a restart can be adopted
 * rather than re-run, whether a node has been out longer than it is allowed.
 *
 * It is a one-way caller. The state machine never polls — polling asks the
 * machine to advance, and the machine advances on its own when a node settles
 * in front of it. That is what lets this be its own module while the queue, the
 * executors and settling stay in one file, which they must: measured, those
 * three call each other in a ring (execute ↔ settling ↔ queue), and splitting a
 * ring produces modules importing each other.
 *
 * The tick is deliberately forgiving. One run's failure to poll must not stop
 * the others, so every run is tried and a read failure is left for the next
 * pass — a machine that stops polling is a machine whose workflows silently
 * stop finishing.
 *
 **/

/** Poll every live run; called by plugins/workflow-runner.ts. Best-effort per
 *  run — a read failure leaves it for the next tick. Sweeps `waiting` runs too,
 *  which is how an approval timeout is noticed. */
export async function checkRunningWorkflowRuns(): Promise<void> {
  const store = await runStore.load()
  for (const run of store.runs.filter((entry) => entry.status === 'running' || entry.status === 'waiting')) {
    try {
      if (run.status === 'waiting') await sweepApprovals(run)
      else await pollRun(run)
    } catch (error) {
      console.error(`[workflow-runs] poll failed for run ${run.id} (${run.workflowName}):`, error)
    }
  }
}

async function pollRun(run: WorkflowRun): Promise<void> {
  await sweepApprovals(run)
  if (run.status !== 'running') return

  const graph = graphOf(run)

  for (const nodeRun of [...run.nodeRuns]) {
    if (nodeRun.status === 'retrying') {
      if (nodeRun.retryAt && Date.parse(nodeRun.retryAt) > Date.now()) continue
      try {
        await redispatchNode(run, nodeRun)
      } catch (error) {
        await nodeErrored(run, nodeRun, String(error))
      }
      return
    }

    if (nodeRun.status !== 'running') continue

    /**
     *
     * An HTTP node settles inside its own execution. Seeing one `running` here
     * means either it still is (this process holds the request) or the sidecar
     * died mid-request. The latter is NOT re-issued blind: a workflow can POST,
     * and replaying a POST nobody knows the outcome of is worse than failing.
     *
     **/
    if (nodeRun.kind === 'http') {
      if (httpInFlight.has(nodeRun.id)) return
      await nodeErrored(run, nodeRun, 'The machine restarted while this request was in flight.')
      return
    }
    if (nodeRun.kind !== 'agent') continue

    if (nodeRun.startedAt && Date.now() - Date.parse(nodeRun.startedAt) > NODE_TIMEOUT_MS) {
      await abortSession(nodeRun.sessionId ?? run.sessionId!, run.directory)
      await nodeErrored(run, nodeRun, `"${nodeRun.key}" timed out.`)
      return
    }

    await pollAgentNode(run, nodeRun, graph)
    return
  }

  /**
   *
   * Nothing running. Before dispatching whatever is ready, check the crash
   * window: persists are fire-and-forget, so the file can say "never
   * dispatched" while the prompt actually went out. If the shared session
   * already holds a turn newer than the run's cursor, that turn IS this node's
   * — adopt it rather than sending a second prompt, which would pay for the
   * work twice and let the agent act twice.
   *
   **/
  if (await adoptInFlightTurn(run, graph)) return

  await advanceRun(run)
}

/** True when a ready agent node was adopted instead of dispatched. */
async function adoptInFlightTurn(run: WorkflowRun, graph: CompiledGraph): Promise<boolean> {
  if (!run.sessionId) return false
  const ready = pickReadyNodeRun(run)
  if (!ready || ready.kind !== 'agent') return false

  const node = graph.nodes.get(ready.nodeId)
  /* c8 ignore next */
  if (!node || node.kind !== 'agent') return false

  /**
   *
   * An isolated node prompts a session of its own, so the shared session's
   * cursor says nothing about it — there is only something to adopt once that
   * subsession exists.
   *
   **/
  const isolated = node.freshSession || ready.attempt > 1
  const sessionId = ready.sessionId ?? (isolated ? null : run.sessionId)
  if (!sessionId) return false

  const baseline = isolated ? null : run.sessionCursor
  const last = await latestAssistantMessage(sessionId, run.directory)
  if (!last || last.info.id === baseline) return false

  ready.messageId = baseline
  ready.status = 'running'
  ready.startedAt = new Date().toISOString()
  publishRun(run)
  return true
}

async function pollAgentNode(run: WorkflowRun, nodeRun: WorkflowRunNodeRun, graph: CompiledGraph): Promise<void> {
  const node = graph.nodes.get(nodeRun.nodeId)!
  /* c8 ignore next */
  if (node.kind !== 'agent') return

  const sessionId = nodeRun.sessionId ?? run.sessionId!
  const last = await latestAssistantMessage(sessionId, run.directory)
  if (!last || last.info.id === nodeRun.messageId || !last.info.time?.completed) return

  if (last.info.error) {
    await nodeErrored(run, nodeRun, turnErrorSummary(last.info.error))
    return
  }

  /**
   *
   * Redacted before anything else touches it: the agent can quote back what it
   * was handed, and everything below stores this text, parses structured output
   * out of it, or feeds it to the next node's template.
   *
   **/
  const reply = await redactNodeText(run, nodeRun, replyText(last))

  if (node.outputSchema) {
    const output = extractJsonOutput(reply)
    if (output === undefined) {
      if (!nodeRun.retried) {
        /**
         *
         * One correction turn: consume this reply and ask again for the JSON.
         *
         **/
        nodeRun.retried = true
        nodeRun.messageId = last.info.id
        publishRun(run)
        await sendNodePrompt(sessionId, run.directory, node, retryInstruction(node.outputSchema))
        return
      }
      noteWarning(nodeRun, 'output-parse-failed')
      nodeRun.output = null
    } else {
      nodeRun.output = output
    }
  }

  const stored = truncate(reply)
  nodeRun.status = 'done'
  nodeRun.text = stored.text
  nodeRun.truncated = stored.truncated
  nodeRun.messageId = last.info.id
  /**
   *
   * Only the SHARED session advances the run's cursor; an isolated node's
   * session is nobody else's baseline.
   *
   **/
  if (!nodeRun.sessionId) run.sessionCursor = last.info.id
  settleNodeRun(run, graph, nodeRun, 'out')
  publishRun(run)

  await advanceRun(run)
}
