import { runStore } from './workflow-run-state.js'
import type { WorkflowRun, WorkflowRunStatus } from './workflow-run-types.js'

/**
 * ── Reading runs ─────────────────────────────────────────────────────────────
 *
 * Four reads, and they belong outside the state machine for the reason the
 * machine's own support module gives for what CAN leave it: they call nothing
 * back. The routes ask these; so does the approvals path, which is the only
 * caller inside the machine and only ever reads.
 *
 * They were in `workflow-runs.ts` because the store was, and the store is its
 * own module now (`workflow-run-state.ts`).
 *
 **/

export async function listWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]> {
  const runs = [...(await runStore.load()).runs].reverse()
  return workflowId ? runs.filter((run) => run.workflowId === workflowId) : runs
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRun | undefined> {
  return (await runStore.load()).runs.find((run) => run.id === runId)
}

/** Runs whose sessions the permission watcher must protect and whose
 *  directories it must watch. Callers say which statuses they mean, because the
 *  three of them mean different things: an unattended-permission check wants
 *  `running`, a directory watch wants parked runs too. */
export async function listActiveWorkflowRuns(
  statuses: readonly WorkflowRunStatus[] = ['running'],
): Promise<WorkflowRun[]> {
  return (await runStore.load()).runs.filter((run) => statuses.includes(run.status))
}

/** Every session id a run is using, across all its node executions. */
export function runSessionIds(run: WorkflowRun): string[] {
  const ids = run.sessionId ? [run.sessionId] : []
  for (const nodeRun of run.nodeRuns) if (nodeRun.sessionId) ids.push(nodeRun.sessionId)
  return ids
}
