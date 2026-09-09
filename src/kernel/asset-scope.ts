import { getQuery, type H3Event } from 'h3'
import { getSession } from './sessions.js'

/**
 *
 * Which project a catalogue request is being asked from.
 *
 * Commands, agents and skills are machine-wide UNTIL a caller says which
 * session (or directory) it is asking about — a checkout brings its own, and
 * they beat the machine's. Two ways to say it because two kinds of caller
 * exist: a client with a session open passes `?session=`, and something acting
 * on a path passes `?directory=`.
 *
 * A session id that no longer resolves is treated as no session at all rather
 * than as an error: the answer is still a valid catalogue, just the machine's
 * own, and refusing to list anything because a stale tab asked would be a worse
 * failure than the one being avoided.
 *
 **/
export async function requestedDirectory(event: H3Event): Promise<string | undefined> {
  const query = getQuery(event)
  const sessionId = typeof query.session === 'string' ? query.session : ''
  if (sessionId) {
    const session = await getSession(sessionId)
    if (session) return session.directory
  }
  const directory = typeof query.directory === 'string' ? query.directory : ''
  return directory || undefined
}
