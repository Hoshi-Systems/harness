import { unattended } from './context.js'
import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody, parseModel } from '../../kernel/index.js'
import { resolveCadence, resolveTriggerAction, updateSchedule, validateTriggerName } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!

  const body = await readJsonBody<{
    name?: unknown
    prompt?: unknown
    workflowId?: unknown
    intervalMinutes?: unknown
    cronExpression?: unknown
    timezone?: unknown
    enabled?: unknown
    model?: unknown
  }>(event)
  const fields: Parameters<typeof updateSchedule>[1] = {}

  if (body.name !== undefined) fields.name = validateTriggerName(body.name)
  /**
   *
   * Only touch the action when the request sent one of its two fields — same
   * leave-it-alone posture as the cadence below. Sending either re-resolves
   * the pair, so switching modes always clears the other side.
   *
   **/
  if (body.prompt !== undefined || body.workflowId !== undefined) {
    const action = resolveTriggerAction(body.prompt, body.workflowId)
    /**
     *
     * Whether that workflow exists is not this plugin's to know — asking to
     * start it is the only question it can ask, and a schedule pointing at a
     * workflow that has since gone away is caught when it fires.
     *
     **/
    if (action.workflowId && !unattended().startWorkflow) {
      apiError(501, 'workflow.unsupported', 'This machine does not run workflows.')
    }
    fields.prompt = action.prompt
    fields.workflowId = action.workflowId
  }
  /**
   *
   * Only touch the cadence at all when the request actually sent one of the
   * two fields — a bare `{ enabled }` toggle must leave whichever mode is
   * already active (and its nextRunAt) completely alone.
   *
   **/
  if (body.intervalMinutes !== undefined || body.cronExpression !== undefined) {
    const cadence = resolveCadence(body.intervalMinutes, body.cronExpression, body.timezone)
    fields.intervalMinutes = cadence.intervalMinutes
    fields.cronExpression = cadence.cronExpression
    /**
     *
     * The zone belongs to the cron's wall clock, so it moves with the cadence:
     * switching to interval mode clears it, and re-sending a cron without one
     * means machine-local, exactly as at create time.
     *
     **/
    fields.timezone = cadence.timezone
  }
  if (typeof body.enabled === 'boolean') fields.enabled = body.enabled
  /**
   *
   * Same "only touch what was sent" rule as cadence above — but unlike
   * cadence, an explicit `model: null` is itself a meaningful, valid update
   * (clear the override back to the machine's default), so the gate is
   * presence-of-key rather than truthiness.
   *
   **/
  if (body.model !== undefined) fields.model = parseModel(body.model, 'model')

  const updated = await updateSchedule(id, fields)
  if (!updated) apiError(404, 'schedule.notFound', 'Schedule not found.')
  return { schedule: updated }
})
