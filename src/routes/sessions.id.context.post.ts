import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody, addContext, getSession } from '../kernel/index.js'

/** Tell the model something without asking it anything.
 *
 *  The gap `POST /messages` cannot fill: every message starts a turn. A button
 *  pressed in a generative-UI card is a fact the agent should have next time it
 *  thinks — not a question worth a whole reply, and certainly not one per click.
 *
 *  `deferred: true` means a turn was running and this is queued behind it. That
 *  is the honest answer rather than a failure: the running turn read its history
 *  when it started, so nothing added now could have reached it either way.
 *
 *  It goes to the model's memory, not the transcript. Rendering it as a chat
 *  bubble would put words in the user's mouth that they never typed. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(sessionId))) apiError(404, 'session.notFound', 'No such session on this machine.')

  const body = await readJsonBody<{ text?: unknown }>(event)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) apiError(400, 'context.textRequired', 'text is required.')

  return addContext(sessionId, text)
})
