import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { getWorkflowRun } from './workflow-run-queries.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const run = await getWorkflowRun(getRouterParam(event, 'runId')!)
  if (!run) apiError(404, 'workflowRun.notFound', 'Workflow run not found.')
  return { run }
})
