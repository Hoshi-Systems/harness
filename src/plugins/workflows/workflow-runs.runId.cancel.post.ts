import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { cancelWorkflowRun } from './workflow-run-lifecycle.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { run: await cancelWorkflowRun(getRouterParam(event, 'runId')!) }
})
