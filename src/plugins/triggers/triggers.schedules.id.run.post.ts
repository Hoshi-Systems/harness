import { unattended } from './context.js'
import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { getSchedule } from './triggers.js'

/** Manual "run now" / test-fire (CYB-91): enqueues the schedule's action
 *  immediately through the same lane a real tick uses — but, unlike a real
 *  tick, never calls markScheduleRun. A test run is a side-run: it must not
 *  consume the schedule's actual due slot or disturb its lastRunAt/nextRunAt
 *  bookkeeping, so the real cadence keeps firing exactly on time. Being an
 *  explicit click, a workflow-mode test-fire runs even a disabled workflow —
 *  same posture as POST /workflows/:id/run. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const schedule = await getSchedule(id)
  if (!schedule) apiError(404, 'schedule.notFound', 'Schedule not found.')

  if (schedule.workflowId) {
    /**
     *
     * Test-firing a trigger has to exercise what the trigger would actually
     * run — the PUBLISHED graph, even though this is a manual click. Whoever
     * owns workflows enforces that; here it is one call either way.
     *
     **/
    const fired = await unattended().startWorkflow?.({
      workflowId: schedule.workflowId,
      source: 'schedule',
      triggerId: schedule.id,
    })
    if (!fired) apiError(501, 'workflow.unsupported', 'This machine does not run workflows.')
    if (!fired.started) apiError(400, 'workflow.notRunnable', fired.reason ?? 'This workflow cannot run.')
    return { started: true }
  }

  const dispatch = unattended().dispatch
  if (!dispatch) apiError(501, 'dispatch.unsupported', 'This machine cannot start unattended work.')
  const task = await dispatch({
    source: 'schedule',
    triggerId: schedule.id,
    triggerName: schedule.name,
    prompt: schedule.prompt,
    projectId: schedule.projectId,
    model: schedule.model,
  })
  return { task }
})
