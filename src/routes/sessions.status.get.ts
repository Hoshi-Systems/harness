import { defineEventHandler } from 'h3'
import { requireAuth, sessionProgressSnapshot, sessionStatuses } from '../kernel/index.js'

/** What every session is doing right now, idle included. Machine-wide with no
 *  parameter: a caller cannot ask a narrower question than they meant, which is
 *  the whole class of bug this replaced (docs/APP_REVIEW.md F1).
 *
 *  `progress` is the same answer one level deeper — the newest plan and the
 *  call in flight, for the sessions that have either. It rides on this route so
 *  a client hydrates both in ONE request and then only listens; the stream
 *  carries every change after that. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { statuses: await sessionStatuses(), progress: sessionProgressSnapshot() }
})
