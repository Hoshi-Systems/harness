import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowStartNode } from './types.js'

/**
 * ── Compiled view ────────────────────────────────────────────────────────────
 *
 * The graph turned inside out for the scheduler: edges indexed by the node they
 * leave and the node they reach, and members indexed by their container. Built
 * once per run rather than walked per step — every question the engine asks of
 * a graph ("what comes after this?", "is this loop body finished?") is a map
 * lookup here.
 *
 **/

export interface CompiledGraph {
  nodes: Map<string, WorkflowNode>
  /** Edges leaving a node, in definition order. */
  outbound: Map<string, WorkflowEdge[]>
  /** Edges arriving at a node, in definition order. */
  inbound: Map<string, WorkflowEdge[]>
  /** Container id (a loop's id, or '' for the top level) → its member nodes. */
  containers: Map<string, WorkflowNode[]>
  start: WorkflowStartNode
}

/** Index a validated graph once so the engine never rescans arrays per tick. */
export function compileGraph(graph: WorkflowGraph): CompiledGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const outbound = new Map<string, WorkflowEdge[]>()
  const inbound = new Map<string, WorkflowEdge[]>()
  const containers = new Map<string, WorkflowNode[]>()

  for (const edge of graph.edges) {
    if (!outbound.has(edge.source)) outbound.set(edge.source, [])
    outbound.get(edge.source)!.push(edge)
    if (!inbound.has(edge.target)) inbound.set(edge.target, [])
    inbound.get(edge.target)!.push(edge)
  }
  for (const node of graph.nodes) {
    const container = node.parentId ?? ''
    if (!containers.has(container)) containers.set(container, [])
    containers.get(container)!.push(node)
  }

  const start = graph.nodes.find((node): node is WorkflowStartNode => node.kind === 'start')
  /* c8 ignore next — validateWorkflowGraph guarantees exactly one. */
  if (!start) throw new Error('compileGraph called on an unvalidated graph')
  return { nodes, outbound, inbound, containers, start }
}
