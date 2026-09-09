import { createCachedStore } from '../../kernel/index.js'
import { compileGraph, type CompiledGraph } from './graph/index.js'
import { isSettled, MAX_RUNS } from './workflow-run-support.js'
import type { WorkflowRun, WorkflowRunStore } from './workflow-run-types.js'

/**
 * ── Where runs live ──────────────────────────────────────────────────────────
 *
 * The durable store and the compiled-graph memo, in a module of their own so
 * that reading a run does not require importing the state machine that writes
 * one.
 *
 * `workflow-runs.ts` is a ring by call graph — the queue, the executors,
 * settling and the tick call each other, which is why its support module says
 * shredding it into five files would produce five files importing each other.
 * Measured, that ring is three groups (execute ↔ settling ↔ queue), not five:
 * queries, cancellation, recovery and polling only ever call INTO it. What kept
 * them there anyway was this — the state they read was a `const` in the middle
 * of the machine, so anything reading it had to be in the same file.
 *
 * It is not in the machine's file any more, and the one-way callers can leave.
 *
 **/

export const runStore = createCachedStore<WorkflowRunStore>('workflow-runs.json', (stored) => {
  const parsed = stored as WorkflowRunStore | null
  const store = parsed && Array.isArray(parsed.runs) ? parsed : { runs: [] }
  store.runs = store.runs.filter((run) => run && Array.isArray(run.nodeRuns) && run.graph)
  return store
})

/** Compiled graphs, keyed by run id. A run's graph never changes, so this is a
 *  pure memo — rebuilt on demand after a restart. */
const compiled = new Map<string, CompiledGraph>()

export function graphOf(run: WorkflowRun): CompiledGraph {
  let entry = compiled.get(run.id)
  if (!entry) {
    entry = compileGraph(run.graph)
    compiled.set(run.id, entry)
  }
  return entry
}

/**
 *
 * Drop the oldest SETTLED runs past the cap, and forget their graphs.
 *
 * Never evicts a run that is still queued, running or waiting: a run parked on
 * an approval for a week is old by arrival order, and deleting it would strand
 * the person who owes it a decision. That is why this is not the plain
 * `keepLatest` other stores use.
 *
 **/
export function trimRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const live = runs.filter((run) => !isSettled(run))
  const settled = runs.filter(isSettled)
  const keep = Math.max(0, MAX_RUNS - live.length)
  const kept = new Set(settled.slice(-keep))
  for (const run of settled) if (!kept.has(run)) compiled.delete(run.id)
  return runs.filter((run) => !isSettled(run) || kept.has(run))
}

/** HTTP node executions in flight IN THIS PROCESS, keyed by node-run id. A
 *  request is not a session, so there is nothing to poll it back from after a
 *  restart — this set is how the poll tells "still going" from "the sidecar died
 *  mid-request". Keyed by the EXECUTION, so two iterations of the same node
 *  inside a loop never collide. */
export const httpInFlight = new Set<string>()
