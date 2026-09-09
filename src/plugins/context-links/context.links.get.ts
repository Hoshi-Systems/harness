import { defineEventHandler, getQuery } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { linksForSession } from './links.js'

/** Every link touching a session, from either end — what it was given, and what
 *  has been taken out of it. One question rather than two, because "where did
 *  this come from" and "what came of this" are the same edge read from
 *  different sides. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = String(getQuery(event).session ?? '')
  if (!sessionId) apiError(400, 'link.sessionRequired', 'session is required.')
  return { links: await linksForSession(sessionId) }
})
