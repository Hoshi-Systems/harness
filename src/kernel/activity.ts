import { readMessages } from './messages.js'
import { listSessions, type Session } from './sessions.js'

/** One calendar day of agent activity on this machine: how many prompts the
 *  user sent and how many sessions they started. `date` is a local calendar day
 *  (YYYY-MM-DD) in the requested timezone — the dashboard's contribution grid is
 *  a calendar, so bucketing has to happen where the timezone is known, not in
 *  UTC. */
export interface ActivityDay {
  date: string
  prompts: number
  sessions: number
}

/** Per-session prompt timestamps, keyed by the session's `updatedAt` so a
 *  session is only re-read after it has actually been used. Raw epoch ms rather
 *  than day buckets — the same cache then serves any timezone. Transcripts are
 *  append-mostly, so this makes every dashboard load after the first cheap. */
const promptCache = new Map<string, { updated: string; promptTimes: number[] }>()

/** Daily prompt/session counts for sessions touched since `sinceMs`, bucketed
 *  into calendar days of `timeZone`. Best-effort per session: one unreadable
 *  transcript skips rather than failing the whole histogram. */
export async function collectActivity(sinceMs: number, timeZone: string): Promise<ActivityDay[]> {
  const sessions = await listSessions()

  /**
   *
   * Only sessions used inside the window can contribute prompts — `updatedAt`
   * moves on every send, so anything older is out of range.
   *
   **/
  const active = sessions.filter((session) => Date.parse(session.updatedAt) >= sinceMs)
  await refreshPromptTimes(active)
  prune(new Set(sessions.map((session) => session.id)))

  const dayOf = dayFormatter(timeZone)
  const buckets = new Map<string, { prompts: number; sessions: number }>()
  const bucket = (ts: number) => {
    const key = dayOf(ts)
    let entry = buckets.get(key)
    if (!entry) buckets.set(key, (entry = { prompts: 0, sessions: 0 }))
    return entry
  }

  for (const session of sessions) {
    const created = Date.parse(session.createdAt)
    if (created >= sinceMs) bucket(created).sessions++
  }
  for (const session of active) {
    for (const ts of promptCache.get(session.id)?.promptTimes ?? []) {
      if (ts >= sinceMs) bucket(ts).prompts++
    }
  }

  return [...buckets.entries()]
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Fill the prompt-time cache for every session used since we last read it (or
 *  that we have never read). Sequential: these are local file reads, and the
 *  concurrency pool this used to need was for HTTP calls carrying full message
 *  bodies over the wire. */
async function refreshPromptTimes(sessions: Session[]): Promise<void> {
  for (const session of sessions) {
    if (promptCache.get(session.id)?.updated === session.updatedAt) continue
    try {
      const messages = await readMessages(session.id)
      const promptTimes = messages
        .filter((message) => message.role === 'user')
        .map((message) => Date.parse(message.createdAt))
        .filter((ts) => Number.isFinite(ts))
      promptCache.set(session.id, { updated: session.updatedAt, promptTimes })
    } catch {
      /**
       *
       * Unreadable transcript (deleted mid-scan) — leave any previous cache
       * entry in place and move on.
       *
       **/
    }
  }
}

/** Drop cache entries for sessions that no longer exist on the machine. */
function prune(alive: Set<string>): void {
  for (const id of promptCache.keys()) {
    if (!alive.has(id)) promptCache.delete(id)
  }
}

/** Epoch ms → YYYY-MM-DD in the given timezone (en-CA renders ISO order). */
function dayFormatter(timeZone: string): (ts: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ts) => format.format(ts)
}

/** The requested IANA timezone if the runtime knows it, else UTC — a bad name
 *  must degrade the bucketing, never 500 the dashboard. */
export function resolveTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}
