import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { deleteSchedule } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  if (!(await deleteSchedule(id))) {
    apiError(404, 'schedule.notFound', 'Schedule not found.')
  }
  return { ok: true }
})
