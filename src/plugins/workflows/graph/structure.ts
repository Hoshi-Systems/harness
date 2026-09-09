import { apiError } from '../../../kernel/index.js'
import { MAX_LOOP_DEPTH, MAX_NAME } from './limits.js'
import { acceptsInbound, outputPorts } from './ports.js'
import type { WorkflowEdge, WorkflowNode } from './types.js'

/**
 * ── Structural validation ────────────────────────────────────────────────────
 *
 * The rules about the graph rather than about any one node: containment depth,
 * where an edge may point, whether every node is reachable, whether a container
 * is acyclic. Apart from the per-field validators next door because they answer
 * a different question — those ask "is this a node", these ask "is this a
 * graph" — and because nothing here needs to know what an `http` node's headers
 * look like.
 *
 **/

export function validateContainment(nodes: WorkflowNode[], byId: Map<string, WorkflowNode>): void {
  for (const node of nodes) {
    if (node.parentId === null) continue
    const parent = byId.get(node.parentId)
    if (!parent) apiError(400, 'workflow.parentMissing', `"${node.name}" sits inside a loop that doesn't exist.`)
    if (parent.kind !== 'loop') {
      apiError(400, 'workflow.parentNotLoop', `Only a loop can contain other nodes — "${parent.name}" cannot.`)
    }
  }

  // Depth doubles as the containment-cycle check: a `parentId` ring never
  // terminates, so the walk trips the depth guard instead of looping forever.
  for (const node of nodes) {
    let depth = 0
    let cursor = node.parentId
    while (cursor !== null) {
      if (++depth > MAX_LOOP_DEPTH) {
        apiError(400, 'workflow.loopDepth', `Loops may nest at most ${MAX_LOOP_DEPTH} deep.`, { max: MAX_LOOP_DEPTH })
      }
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }
}

export function validateEdge(raw: unknown, byId: Map<string, WorkflowNode>): WorkflowEdge {
  const edge = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const source = typeof edge.source === 'string' ? edge.source : ''
  const target = typeof edge.target === 'string' ? edge.target : ''

  const sourceNode = byId.get(source)
  const targetNode = byId.get(target)
  if (!sourceNode || !targetNode) apiError(400, 'workflow.edgeDangling', 'An edge points at a node that was removed.')
  if (source === target) apiError(400, 'workflow.edgeSelf', `"${sourceNode.name}" cannot connect to itself.`)

  const sourcePort = typeof edge.sourcePort === 'string' ? edge.sourcePort : 'out'
  if (!outputPorts(sourceNode).includes(sourcePort)) {
    apiError(400, 'workflow.edgePortUnknown', `"${sourceNode.name}" has no "${sourcePort}" output.`)
  }
  if (!acceptsInbound(targetNode)) {
    apiError(400, 'workflow.edgeTargetClosed', `Nothing can connect into "${targetNode.name}".`)
  }

  const label = typeof edge.label === 'string' && edge.label.trim() ? edge.label.trim().slice(0, MAX_NAME) : null
  return {
    id: typeof edge.id === 'string' && edge.id ? edge.id : crypto.randomUUID(),
    source,
    sourcePort,
    target,
    targetPort: 'in',
    label,
  }
}

export function validateStructure(nodes: WorkflowNode[], edges: WorkflowEdge[], byId: Map<string, WorkflowNode>): void {
  const starts = nodes.filter((node) => node.kind === 'start')
  if (starts.length === 0) apiError(400, 'workflow.startMissing', 'A workflow needs a start node.')
  if (starts.length > 1) apiError(400, 'workflow.startDuplicate', 'A workflow can only have one start node.')
  if (starts[0].parentId !== null) apiError(400, 'workflow.startNested', 'The start node cannot sit inside a loop.')

  const ends = nodes.filter((node) => node.kind === 'end')
  if (ends.length === 0) apiError(400, 'workflow.endMissing', 'A workflow needs at least one end node.')
  for (const end of ends) {
    if (end.parentId !== null) apiError(400, 'workflow.endNested', 'An end node cannot sit inside a loop.')
  }

  const seen = new Set<string>()
  for (const edge of edges) {
    const signature = JSON.stringify([edge.source, edge.sourcePort, edge.target])
    if (seen.has(signature)) {
      apiError(400, 'workflow.edgeDuplicate', 'The same two nodes are connected twice from one output.')
    }
    seen.add(signature)

    // Containment is what keeps every level acyclic, so it is the one rule an
    // edge can break in a way validation can't recover from. A loop's `body`
    // port is the sole way into a container; everything else stays home.
    const sourceNode = byId.get(edge.source)!
    const targetNode = byId.get(edge.target)!
    if (sourceNode.kind === 'loop' && edge.sourcePort === 'body') {
      if (targetNode.parentId !== sourceNode.id) {
        apiError(
          400,
          'workflow.edgeCrossesContainer',
          `"${targetNode.name}" must sit inside the loop to be its body.`,
          { nodeId: targetNode.id, nodeName: targetNode.name },
        )
      }
    } else if (targetNode.parentId !== sourceNode.parentId) {
      apiError(
        400,
        'workflow.edgeCrossesContainer',
        `"${sourceNode.name}" and "${targetNode.name}" are not connectable.`,
        { nodeId: sourceNode.id, nodeName: sourceNode.name },
      )
    }
  }

  for (const loop of nodes) {
    if (loop.kind !== 'loop') continue
    const body = edges.filter((edge) => edge.source === loop.id && edge.sourcePort === 'body')
    if (body.length === 0) {
      apiError(400, 'workflow.loopEmpty', `"${loop.name}" has no body to repeat.`, {
        nodeId: loop.id,
        nodeName: loop.name,
      })
    }
  }

  validateContainerFlow(nodes, edges)
}

/** Per container: the edges that stay inside it must form a DAG, and every node
 *  in it must be reachable from that container's entry. Because a loop's body is
 *  entered through containment rather than a back-edge, "is this cycle legal?"
 *  never comes up — any cycle at all is a bug.
 *
 *  Reachability is the ONLY connectivity check, and deliberately so. A separate
 *  "every node has an inbound edge" rule reads like it catches a different
 *  mistake, but it cannot: a node that is unreachable yet has an inbound edge
 *  needs its inbound chain to trace back to either a node with no inbound edge
 *  or a cycle, and both are already rejected. Two checks where one fires is one
 *  check plus dead code. */
function validateContainerFlow(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  const containers = new Map<string, WorkflowNode[]>()
  for (const node of nodes) {
    const container = node.parentId ?? ''
    if (!containers.has(container)) containers.set(container, [])
    containers.get(container)!.push(node)
  }

  for (const [container, members] of containers) {
    const ids = new Set(members.map((node) => node.id))
    const internal = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))

    const indegree = new Map<string, number>(members.map((node) => [node.id, 0]))
    for (const edge of internal) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)

    const queue = members.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
    let settled = 0
    while (queue.length) {
      const id = queue.shift()!
      settled++
      for (const edge of internal.filter((candidate) => candidate.source === id)) {
        const next = (indegree.get(edge.target) ?? 0) - 1
        indegree.set(edge.target, next)
        if (next === 0) queue.push(edge.target)
      }
    }
    if (settled !== members.length) {
      apiError(400, 'workflow.cycle', 'These nodes loop back on each other — use a loop node to repeat work.')
    }

    // Entry points: the start node at the top level, or whatever the owning
    // loop's `body` port points at.
    const roots = container
      ? edges.filter((edge) => edge.source === container && edge.sourcePort === 'body').map((edge) => edge.target)
      : members.filter((node) => node.kind === 'start').map((node) => node.id)

    const reached = new Set<string>(roots)
    const frontier = [...roots]
    while (frontier.length) {
      const id = frontier.shift()!
      for (const edge of internal.filter((candidate) => candidate.source === id)) {
        if (reached.has(edge.target)) continue
        reached.add(edge.target)
        frontier.push(edge.target)
      }
    }
    for (const node of members) {
      // A note is canvas furniture: unreachable by definition, and that's fine.
      if (node.kind === 'note' || reached.has(node.id)) continue
      apiError(400, 'workflow.unreachable', `"${node.name}" can never run — nothing leads to it.`, {
        nodeId: node.id,
        nodeName: node.name,
      })
    }
  }
}
