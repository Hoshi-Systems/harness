import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, getSession, abortTurn } from '../kernel/index.js'

/** Stop the running turn. Aborting when nothing is running is success, not an
 *  error: two clients watching the same session will both press stop, and the
 *  second one is not wrong. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(id))) apiError(404, 'session.notFound', 'No such session on this machine.')
  return { aborted: abortTurn(id) }
})
