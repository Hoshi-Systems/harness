import { defineEventHandler, getRouterParam } from 'h3'
import {
  apiError,
  requireAuth,
  readJsonBody,
  getSession,
  rewindSession,
  TimelineAnchorError,
  TimelineBusyError,
} from '../kernel/index.js'

/** Roll the session back to before a message was sent. Cuts the transcript AND
 *  the model's memory at the same stamped point (engine/timeline.ts) — an undo
 *  the agent still remembers is worse than no undo at all. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(sessionId))) apiError(404, 'session.notFound', 'No such session on this machine.')
  const body = await readJsonBody<{ messageId?: unknown }>(event)
  const messageId = typeof body.messageId === 'string' ? body.messageId : ''
  if (!messageId) apiError(400, 'rewind.messageRequired', 'messageId is required.')
  try {
    await rewindSession(sessionId, messageId)
  } catch (error) {
    if (error instanceof TimelineBusyError) apiError(409, 'session.busy', error.message)
    if (error instanceof TimelineAnchorError) apiError(404, 'rewind.messageNotFound', error.message)
    throw error
  }
  return { ok: true }
})
