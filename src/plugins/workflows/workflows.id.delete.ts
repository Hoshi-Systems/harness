import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { ports } from './host.js'
import { cancelRunsForWorkflow } from './workflow-run-lifecycle.js'
import { deleteWorkflow } from './workflows.js'

/** Deleting a workflow settles everything hanging off it: queued/running runs
 *  are cancelled (history rows survive via the denormalized workflowName) and
 *  every trigger bound to it is detached AND disabled — a trigger with no
 *  action must never stay armed. Triggers publish no machine events, so the
 *  detach counts ride the response for the client to refresh off. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!

  const cancelledRuns = await cancelRunsForWorkflow(id)
  const detached = (await ports().detachTriggersForWorkflow?.(id)) ?? { schedules: 0, webhooks: 0 }
  const deleted = await deleteWorkflow(id)
  if (!deleted) apiError(404, 'workflow.notFound', 'Workflow not found.')

  return { ok: true, cancelledRuns, detachedSchedules: detached.schedules, detachedWebhooks: detached.webhooks }
})
