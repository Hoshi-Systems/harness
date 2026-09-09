import { unattended } from './context.js'
import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { resolveTriggerAction, updateWebhookTrigger, validateTriggerName } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!

  const body = await readJsonBody<{ name?: unknown; prompt?: unknown; workflowId?: unknown; enabled?: unknown }>(event)
  const fields: Parameters<typeof updateWebhookTrigger>[1] = {}

  if (body.name !== undefined) fields.name = validateTriggerName(body.name)
  /**
   *
   * Re-resolve the action pair whenever either field is sent, so switching
   * between prompt and workflow modes always clears the other side.
   *
   **/
  if (body.prompt !== undefined || body.workflowId !== undefined) {
    const action = resolveTriggerAction(body.prompt, body.workflowId)
    if (action.workflowId && !unattended().startWorkflow) {
      apiError(400, 'trigger.workflowNotFound', 'The referenced workflow does not exist.')
    }
    fields.prompt = action.prompt
    fields.workflowId = action.workflowId
  }
  if (typeof body.enabled === 'boolean') fields.enabled = body.enabled

  const updated = await updateWebhookTrigger(id, fields)
  if (!updated) apiError(404, 'webhook.notFound', 'Webhook not found.')
  return { webhook: updated }
})
