import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { restoreWorkflowVersion } from './workflows.js'

/** Copy an old version's graph back onto the draft. Does NOT change what
 *  triggers run: a rollback lands in the builder to be looked at, and goes live
 *  through the same Publish as any other edit. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const version = Number(getRouterParam(event, 'version'))
  if (!Number.isInteger(version) || version < 1) {
    apiError(400, 'workflow.versionInvalid', 'That is not a version number.')
  }

  const workflow = await restoreWorkflowVersion(getRouterParam(event, 'id')!, version)
  if (!workflow) apiError(404, 'workflow.notFound', 'Workflow not found.')
  return { workflow }
})
