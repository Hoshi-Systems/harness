import { defineEventHandler, getQuery } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listWorkflowRuns } from './workflow-run-queries.js'

/** Run history, most-recent-first; `?workflowId=` scopes it to one workflow —
 *  same flat shape as GET /tasks?triggerId=. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const workflowId = getQuery(event).workflowId
  return { runs: await listWorkflowRuns(typeof workflowId === 'string' && workflowId ? workflowId : undefined) }
})
