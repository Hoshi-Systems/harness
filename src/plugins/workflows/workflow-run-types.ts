import type { WorkflowGraph } from './graph/index.js'
import type { WorkflowRunInput, WorkflowRunNodeRun } from './workflow-scheduler.js'

/**
 * ── What a run is ────────────────────────────────────────────────────────────
 *
 * The record shape, apart from the machinery that drives it. Its own module so
 * workflow-run-support.ts can describe what it operates on without importing
 * the state machine that operates on it — the alternative was a cycle, which
 * check-cycles.mjs refuses.
 *
 **/

export type { WorkflowRunNodeRun }

export type WorkflowRunSource = 'manual' | 'schedule' | 'webhook'
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  /** Every live node execution is parked on a human decision. Holds NO
   *  concurrency — see the note on `startNextRun`. */
  | 'waiting'
  | 'done'
  | 'error'
  | 'cancelled'

export interface WorkflowRun {
  id: string
  workflowId: string
  /** Denormalized so history rows survive the workflow being deleted. */
  workflowName: string
  /** Which published version ran, or null for a draft (builder) run. */
  version: number | null
  projectId: string | null
  directory: string | null
  source: WorkflowRunSource
  triggerId: string | null
  status: WorkflowRunStatus
  input: WorkflowRunInput | null
  /** The run's shared session. */
  sessionId: string | null
  /** The newest assistant message CONSUMED in the shared session. A graph node
   *  can have many predecessors, so "the previous step's reply" is not a thing
   *  that exists — this is the baseline crash recovery compares against. */
  sessionCursor: string | null
  /** Enqueue-time snapshot: a run is immune to later edits. */
  graph: WorkflowGraph
  /** Push-ordered; unique on (nodeId, path). The timeline AND the state machine. */
  nodeRuns: WorkflowRunNodeRun[]
  state: Record<string, unknown>
  /** Produced by the `end` node that settled the run. */
  output: unknown
  error: string | null
  warnings: string[]
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface WorkflowRunStore {
  runs: WorkflowRun[]
}
