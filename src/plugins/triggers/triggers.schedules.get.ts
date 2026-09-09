import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listSchedules } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { schedules: await listSchedules() }
})
