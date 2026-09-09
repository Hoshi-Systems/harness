import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { getWorkflow } from './workflows.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const workflow = await getWorkflow(getRouterParam(event, 'id')!)
  if (!workflow) apiError(404, 'workflow.notFound', 'Workflow not found.')
  return { workflow }
})
