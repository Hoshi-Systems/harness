import { defineEventHandler, getQuery } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { getCurrentGoalForSession, listGoals } from './goals.js'

/** Every goal on this machine, or (the common case) one session's own current
 *  goal via `?sessionId=` — the composer/status-strip poll. A session ever
 *  has at most one active (running/paused) goal; its most recent settled one
 *  is kept around too (getCurrentGoalForSession) so the status strip survives
 *  a reload until the client dismisses it — the client reads `goals[0]`. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sessionId = getQuery(event).sessionId
  if (typeof sessionId !== 'string') return { goals: await listGoals() }
  const current = await getCurrentGoalForSession(sessionId)
  return { goals: current ? [current] : [] }
})
