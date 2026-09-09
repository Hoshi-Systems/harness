import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, collectActivity, resolveTimeZone } from '../kernel/index.js'

/** Daily activity histogram for the dashboard's contribution grid: prompts
 *  sent and sessions started per calendar day, aggregated machine-side from
 *  OpenCode's session/message listings (the client would otherwise need one
 *  heavy call per session over the network). `tz` buckets days in the caller's
 *  timezone; `days` bounds the window (default 53 weeks). A specific route, so
 *  it's served directly rather than falling through to the OpenCode proxy. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = getQuery(event)
  const requested = Number(query.days)
  const days = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 7), 400) : 371
  const timeZone = resolveTimeZone(query.tz)
  const since = Date.now() - days * 86_400_000
  return { days: await collectActivity(since, timeZone) }
})
