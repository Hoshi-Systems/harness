import { unattended } from './context.js'
import { defineEventHandler } from 'h3'
import { apiError, requireAuth, optionalProjectId, readJsonBody, parseModel } from '../../kernel/index.js'
import { createSchedule, resolveCadence, resolveTriggerAction, validateTriggerName } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    name?: unknown
    prompt?: unknown
    workflowId?: unknown
    intervalMinutes?: unknown
    cronExpression?: unknown
    timezone?: unknown
    projectId?: unknown
    model?: unknown
  }>(event)

  const name = validateTriggerName(body.name)
  const { prompt, workflowId } = resolveTriggerAction(body.prompt, body.workflowId)
  if (workflowId && !unattended().startWorkflow) {
    apiError(400, 'trigger.workflowNotFound', 'The referenced workflow does not exist.')
  }
  const { intervalMinutes, cronExpression, timezone } = resolveCadence(
    body.intervalMinutes,
    body.cronExpression,
    body.timezone,
  )

  const projectId = optionalProjectId(body.projectId)
  const model = parseModel(body.model, 'model')

  return {
    schedule: await createSchedule({
      name,
      prompt,
      workflowId,
      intervalMinutes,
      cronExpression,
      timezone,
      projectId,
      model,
    }),
  }
})
