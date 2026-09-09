import type { WorkflowNode, WorkflowRetries } from './types.js'

/**
 * ── Port table ───────────────────────────────────────────────────────────────
 *
 * The single source of truth for which edges are legal and for what the engine
 * prunes. `parallel` is deliberately NOT a node kind: fan-out is N edges off one
 * port and fan-in is a node with N inbound edges, so a node kind for it would
 * give the engine two ways to say the same thing.
 *
 **/

export function outputPorts(node: WorkflowNode): string[] {
  switch (node.kind) {
    case 'note':
    case 'end':
      return []
    case 'branch':
      return [...node.cases.map((entry) => `case:${entry.id}`), 'else']
    case 'loop':
      return ['body', 'done']
    case 'approval':
      return ['approved', 'rejected']
    default:
      return ['out']
  }
}

/** A `start` has nothing upstream; a `note` is canvas furniture and never
 *  executes, so nothing may point at either. */
export function acceptsInbound(node: WorkflowNode): boolean {
  return node.kind !== 'start' && node.kind !== 'note'
}

/** Only these kinds can error transiently and therefore carry a retry policy.
 *  A transform is deterministic — re-running it reproduces the same answer. */
export function retriesFor(node: WorkflowNode): WorkflowRetries | null {
  return node.kind === 'agent' || node.kind === 'http' ? node.retries : null
}
