import type { WorkflowGraph, WorkflowNode } from './types.js'
import { apiError } from '../../../kernel/index.js'

/**
 * ── Completeness ─────────────────────────────────────────────────────────────
 *
 * SHAPE and COMPLETENESS are different questions, and conflating them is what
 * made a half-built canvas impossible to save. Shape — is this a node at all,
 * does that edge name a real port, is that condition parseable — is checked on
 * every write and can never be relaxed: a malformed graph is corruption.
 * Completeness — does the agent node actually have a prompt yet — is checked
 * only when the graph is about to RUN.
 *
 * So a draft saves with an empty prompt (you were mid-thought; come back
 * tomorrow), and Publish or Run refuses it by name. The builder reads the same
 * rules to highlight the node while you type, which is why they live in one
 * exported function rather than scattered through the validators.
 *
 **/

export interface WorkflowNodeProblem {
  nodeId: string
  /** Which inspector field to point at. */
  field: string
  /** Stable code the client maps to a localized string. */
  code: string
  message: string
}

/** What still has to be filled in before this node could run. */
export function nodeProblems(node: WorkflowNode): WorkflowNodeProblem[] {
  const problems: WorkflowNodeProblem[] = []
  const add = (field: string, code: string, message: string) => problems.push({ nodeId: node.id, field, code, message })

  switch (node.kind) {
    case 'agent':
      if (!node.prompt) add('prompt', 'promptRequired', 'This agent node has no prompt yet.')
      break
    case 'http':
      if (!node.http.url) add('url', 'urlRequired', 'This request node has no URL yet.')
      break
    case 'branch':
      for (const entry of node.cases) {
        if (!entry.when) add(`case:${entry.id}`, 'caseRequired', 'A branch case has no condition yet.')
      }
      break
    case 'loop':
      if (node.mode === 'foreach' && !node.source)
        add('source', 'loopSourceRequired', 'This loop has nothing to iterate yet.')
      if (node.mode === 'while' && !node.while) add('while', 'loopWhileRequired', 'This loop has no condition yet.')
      break
    case 'state':
      if (node.assignments.length === 0) add('assignments', 'stateRequired', 'This node sets no variables yet.')
      break
    case 'approval':
      if (!node.title) add('title', 'approvalTitleRequired', 'This approval has no title yet.')
      break
    default:
      break
  }
  return problems
}

/** Every unfinished node in a graph, in node order. */
export function graphProblems(graph: WorkflowGraph): WorkflowNodeProblem[] {
  return graph.nodes.flatMap(nodeProblems)
}

/** Refuse a graph that isn't finished enough to run. Called by publish and by
 *  the run route — never by a draft save. The offending node is named in the
 *  error params so a client can select it rather than just showing a toast. */
export function requireRunnableGraph(graph: WorkflowGraph): void {
  const [problem] = graphProblems(graph)
  if (!problem) return
  const node = graph.nodes.find((entry) => entry.id === problem.nodeId)
  apiError(400, 'workflow.nodeIncomplete', `"${node?.name ?? 'A node'}" is not finished: ${problem.message}`, {
    nodeId: problem.nodeId,
    nodeKey: node?.key ?? '',
    nodeName: node?.name ?? '',
    field: problem.field,
    reason: problem.code,
  })
}
