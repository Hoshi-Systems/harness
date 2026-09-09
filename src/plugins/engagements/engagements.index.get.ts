import { defineEventHandler, getQuery } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listEngagements } from './engagements.js'

/** Every engagement on this machine, newest first — or one session's, which is
 *  what the transcript's team card asks for. The client hydrates from here once
 *  and then follows `engagement.updated` on the machine's event stream, so this
 *  answers exactly once per session per page life. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getQuery(event).sessionId
  return { engagements: await listEngagements(typeof sessionId === 'string' ? sessionId : undefined) }
})
