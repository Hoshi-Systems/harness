import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, getSession } from '../kernel/index.js'

/** One session. A 404 for an id this machine has never held is an ordinary
 *  answer, not a fault: clients hold ids they may no longer own (a stale tab, a
 *  link opened after a delete). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const session = await getSession(getRouterParam(event, 'id') ?? '')
  if (!session) apiError(404, 'session.notFound', 'No such session on this machine.')
  return { session }
})
