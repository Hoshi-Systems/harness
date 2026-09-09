import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, deleteSession } from '../kernel/index.js'

/** Delete a session. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const removed = await deleteSession(getRouterParam(event, 'id') ?? '')
  if (!removed) apiError(404, 'session.notFound', 'No such session on this machine.')
  return { ok: true }
})
