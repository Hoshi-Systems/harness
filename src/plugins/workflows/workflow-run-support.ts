import { publishMachineEvent } from '../../kernel/index.js'
import { compileGraph, type CompiledGraph } from './graph/index.js'
import { nodeSecretSources, redactSecrets, referencedSecretKeys, resolveSecrets } from './workflow-secrets.js'
import type { WorkflowRun, WorkflowRunNodeRun } from './workflow-run-types.js'

/**
 * ── The parts of a run that are not the state machine ────────────────────────
 *
 * workflow-runs.ts was 1,176 lines carrying eight banner-separated concerns, and
 * the obvious move was to give each banner a file. Mapping the call graph said
 * otherwise — but it said something narrower than what was written here, which
 * claimed "the queue, the executors, approvals, settling and the tick all call
 * each other in a ring".
 *
 * Measured group by group, the ring is THREE: execute ↔ settling ↔ queue. The
 * tick, cancellation, recovery and the reads only ever call INTO the machine,
 * and nothing in it calls back out to them. What kept them in the file anyway
 * was the state — the store was a `const` in the middle of the machine, so
 * anything that read a run had to live beside the code that writes one. It is
 * `workflow-run-state.ts` now, and they left: `workflow-run-poll.ts`,
 * `workflow-run-lifecycle.ts`, `workflow-run-queries.ts`.
 *
 * These are the pieces that called nothing back at all. Limits, text handling,
 * the retry curve, secret resolution and redaction: a genuine leaf, extractable
 * without inventing a cycle.
 *
 **/

export const MAX_RUNS = 100
/** Per-node stored reply/prompt cap — a node's session holds the full text, the
 *  run history only needs enough to render and template from. */
export const NODE_TEXT_MAX = 32_768
export const NODE_TIMEOUT_MS = 30 * 60_000
export const MAX_RETRY_DELAY_MS = 30 * 60_000
/** How many node executions one run may produce before it is treated as a
 *  runaway. Loops multiply, so this is a backstop on the FILE, not on the graph
 *  (which utils/workflow-graph.ts already caps at 60 nodes). */
export const MAX_NODE_RUNS = 2_000
/** Non-suspending nodes drained in one advance before yielding to the tick. */
export const MAX_DRAIN = 500
/** Iterations whose per-node text is kept; past this only structured `output`
 *  is retained, so a 100-iteration loop can't fill the run file with prose. */
export const MAX_LOOP_TEXT_RESULTS = 20

export function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= NODE_TEXT_MAX) return { text, truncated: false }
  return { text: text.slice(0, NODE_TEXT_MAX), truncated: true }
}

export function isSettled(run: WorkflowRun): boolean {
  return run.status === 'done' || run.status === 'error' || run.status === 'cancelled'
}

export function stripText(
  result: Record<string, { text: string; output: unknown }>,
): Record<string, { text: string; output: unknown }> {
  const stripped: Record<string, { text: string; output: unknown }> = {}
  for (const [key, value] of Object.entries(result)) stripped[key] = { text: '', output: value.output }
  return stripped
}

export function retryDelayMs(backoffSeconds: number, attempt: number): number {
  return Math.min(backoffSeconds * 1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

export function noteWarning(nodeRun: WorkflowRunNodeRun, warning: string): void {
  if (!nodeRun.warnings.includes(warning)) nodeRun.warnings.push(warning)
}

/** Record every `{{path}}` that resolved to nothing. Deduped: a retry re-renders
 *  the same templates and would otherwise stack one warning per attempt. */
export function noteMissing(nodeRun: WorkflowRunNodeRun, missing: string[]): void {
  for (const path of missing) {
    noteWarning(
      nodeRun,
      path.startsWith('secrets.') ? `missing-secret:${path.slice('secrets.'.length)}` : `missing-path:${path}`,
    )
  }
}
