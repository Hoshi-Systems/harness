import { unattended } from './context.js'
import { defineEventHandler } from 'h3'
import { apiError, requireAuth, optionalProjectId, readJsonBody } from '../../kernel/index.js'
import { createWebhookTrigger, resolveTriggerAction, validateTriggerName } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    name?: unknown
    prompt?: unknown
    workflowId?: unknown
    projectId?: unknown
  }>(event)

  const name = validateTriggerName(body.name)
  const { prompt, workflowId } = resolveTriggerAction(body.prompt, body.workflowId)
  if (workflowId && !unattended().startWorkflow) {
    apiError(400, 'trigger.workflowNotFound', 'The referenced workflow does not exist.')
  }

  const projectId = optionalProjectId(body.projectId)

  return { webhook: await createWebhookTrigger({ name, prompt, workflowId, projectId }) }
})
