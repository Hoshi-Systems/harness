import { defineEventHandler, getRouterParam } from 'h3'
import {
  apiError,
  requireAuth,
  ModelUnavailableError,
  getSession,
  compactSession,
  TurnBusyError,
} from '../kernel/index.js'

/** Fold the session's past into a summary now, ahead of the automatic
 *  compaction the engine runs at the context cliff. `compacted: false` means
 *  there was nothing worth folding — an honest no-op, not a failure. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(sessionId))) apiError(404, 'session.notFound', 'No such session on this machine.')
  try {
    return await compactSession(sessionId)
  } catch (error) {
    if (error instanceof TurnBusyError) apiError(409, 'session.busy', error.message)
    if (error instanceof ModelUnavailableError) apiError(400, 'model.needs-key', error.message)
    throw error
  }
})
