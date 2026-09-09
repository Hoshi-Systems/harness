import { defineEventHandler, getRouterParam } from 'h3'
import {
  apiError,
  requireAuth,
  readJsonBody,
  getSession,
  forkSession,
  TimelineAnchorError,
  TimelineBusyError,
} from '../kernel/index.js'

/** Branch a new session that keeps this one's history — the whole of it, or
 *  everything before `messageId`. Copies the model's memory as well as the
 *  transcript; the original is never touched. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(sessionId))) apiError(404, 'session.notFound', 'No such session on this machine.')
  const body = await readJsonBody<{ messageId?: unknown }>(event)
  try {
    const session = await forkSession(sessionId, typeof body.messageId === 'string' ? body.messageId : undefined)
    return { session }
  } catch (error) {
    if (error instanceof TimelineBusyError) apiError(409, 'session.busy', error.message)
    if (error instanceof TimelineAnchorError) apiError(404, 'fork.messageNotFound', error.message)
    throw error
  }
})
