import { apiError } from '../../kernel/index.js'
import { abortSession } from './workflow-executor.js'
import { processRunQueue, publishRun } from './workflow-runs.js'
import { runStore } from './workflow-run-state.js'
import { isSettled } from './workflow-run-support.js'
import { ACTIVE_NODE_STATUSES } from './workflow-scheduler.js'
import type { WorkflowRun } from './workflow-run-types.js'

/**
 * ── Ending a run, and picking one back up after a restart ────────────────────
 *
 * Cancellation and recovery: the two ways a run's life is decided from OUTSIDE
 * the state machine. A person presses cancel, or the daemon comes back up and
 * finds runs that were mid-flight when it went down.
 *
 * Both are one-way callers — they ask the queue to move and the funnel to
 * publish, and nothing in the machine asks them anything. That is why they can
 * live here while the queue, the executors and settling stay in one file: those
 * three call each other in a ring, and splitting a ring produces modules that
 * import each other.
 *
 **/

export async function cancelWorkflowRun(runId: string): Promise<WorkflowRun> {
  const store = await runStore.load()
  const run = store.runs.find((entry) => entry.id === runId)
  if (!run) apiError(404, 'workflowRun.notFound', 'Workflow run not found.')
  if (isSettled(run)) apiError(400, 'workflowRun.notActive', 'Only a live run can be cancelled.')

  /**
   *
   * Nothing to abort for an HTTP node — its request either already returned or
   * times out on its own; there is no turn burning tokens meanwhile.
   *
   **/
  const active = run.nodeRuns.find((entry) => entry.status === 'running' && entry.kind === 'agent')
  const activeSession = active?.sessionId ?? run.sessionId
  if (active && activeSession) await abortSession(activeSession, run.directory)

  for (const nodeRun of run.nodeRuns) {
    if (!ACTIVE_NODE_STATUSES.has(nodeRun.status)) continue
    nodeRun.status = 'cancelled'
    nodeRun.retryAt = null
    if (nodeRun.startedAt && !nodeRun.completedAt) nodeRun.completedAt = new Date().toISOString()
  }
  run.status = 'cancelled'
  run.completedAt = new Date().toISOString()
  publishRun(run)
  void processRunQueue()
  return run
}

export async function cancelRunsForWorkflow(workflowId: string): Promise<number> {
  const store = await runStore.load()
  const active = store.runs.filter((run) => run.workflowId === workflowId && !isSettled(run))
  for (const run of active) await cancelWorkflowRun(run.id)
  return active.length
}

/** Boot recovery. A `running` run that never got its session re-queues from
 *  scratch; one with a session stays running and the tick picks it up. A
 *  `waiting` run is left exactly alone — the whole decision state is already on
 *  disk, so an approval parked for a week costs one JSON object and no timer. */
export async function recoverWorkflowRuns(): Promise<void> {
  const store = await runStore.load()
  /**
   *
   * A `running` run that never got past seeding restarts from scratch; one that
   * already has a frontier stays running and the tick picks it up. The session
   * is no longer the signal for this — it may legitimately never exist.
   *
   **/
  for (const run of store.runs.filter((entry) => entry.status === 'running' && entry.nodeRuns.length === 0)) {
    run.status = 'queued'
    run.startedAt = null
    publishRun(run)
  }
  void processRunQueue()
}
