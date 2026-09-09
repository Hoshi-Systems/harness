import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, removeSkillSource } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const removed = await removeSkillSource(getRouterParam(event, 'id') ?? '')
  if (!removed) apiError(404, 'skillSource.notFound', 'No such source on this machine.')
  return { ok: true }
})
