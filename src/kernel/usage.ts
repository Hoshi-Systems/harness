import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'

/**
 * ── Usage store ──────────────────────────────────────────────────────────────
 *
 * Token/cost usage analytics (CYB-79): one row per completed assistant turn,
 * written by the ENGINE as the turn ends (engine/turns.ts). It used to be
 * reported by the browser once the answer landed, which meant spend was only
 * counted while somebody was watching: a closed tab, a dropped stream, a
 * scheduled run or a goal working overnight all cost real money and appeared
 * in no total. The machine already computes the figure to stamp on the
 * message, so the client was never the source of it — only its courier. Lives
 * on the machine, in ~/.hoshi/usage.json (see ./store.ts) — this is
 * inherently a machine-wide OpenCode concept (every session run here,
 * regardless of which Platform project, or the personal scope), not a
 * Platform-account concept, so it isn't scoped by project ownership the way
 * the first cut of this feature tried to on the Platform API. Same in-memory-
 * cache + serialized-persist shape as utils/triggers.ts. A fully separate
 * concept from the simulated machine-uptime billing meter on the Platform's
 * `machines` table (plugins/usage-meter.ts) — this is real per-turn token/cost
 * data, purely for the owner's own visibility (Settings -> Usage), not billing.
 * The machine remains the system of record for its own turns; job 04 adds a
 * periodic push of DAILY AGGREGATES (getDailyBuckets below → utils/usage-push.ts)
 * to the Platform so an org admin can see fleet-wide spend, which is still not
 * billing — the rollup is visibility plus the budgets built on top of it.
 *
 **/

const usageFile = () => hoshiFile('usage.json')

export interface UsageEvent {
  id: string
  ocSessionId: string
  messageId: string
  model: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** False when nobody published a price for the model this turn ran on, so
   *  `cost: 0` here means "not known" rather than "free". Summing the two
   *  together would report a machine running unpriced models as spending
   *  nothing at all — the one number a spend total must never get wrong.
   *  Absent on rows written before this existed, which were all priced. */
  priced?: boolean
  createdAt: string
}

interface UsageStore {
  events: UsageEvent[]
}

let cache: UsageStore | null = null
let seenMessageIds: Set<string> | null = null

async function ensureLoaded(): Promise<UsageStore> {
  if (cache) return cache
  const stored = await readHoshiJson<UsageStore>(usageFile())
  cache = stored && Array.isArray(stored.events) ? stored : { events: [] }
  seenMessageIds = new Set(cache.events.map((event) => event.messageId))
  return cache
}

/**
 *
 * Chained so overlapping fire-and-forget persists can't interleave on the same
 * tmp file — see utils/triggers.ts for the identical rationale.
 *
 **/
let persistQueue: Promise<void> = Promise.resolve()

function persist(): void {
  const snapshot = cache
  if (!snapshot) return
  persistQueue = persistQueue
    .then(() => writeHoshiJson(usageFile(), snapshot))
    .catch((error) => console.error('[usage] failed to persist usage events:', error))
}

/** Resolve once every queued write has landed. Nothing in a request path wants
 *  this — the whole point of a fire-and-forget persist is not waiting — but a
 *  TEST that tears down the scratch HOME this store writes into does: without
 *  it the last write races the teardown and logs after the run has ended, which
 *  vitest reports as an unhandled error and CI reads as a failing suite.
 *  Mirrors CachedJsonStore.flush() in utils/json-store.ts. */
export function flushUsage(): Promise<void> {
  return persistQueue
}

export interface UsageEventInput {
  ocSessionId: string
  messageId: string
  model: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Null when the model has no published price — recorded as an unpriced
   *  turn rather than a free one. */
  cost: number | null
}

/** Record one completed assistant turn's token/cost usage. Deduped on
 *  messageId so a client retry or SSE reconnect replay can't double-count. */
export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  const store = await ensureLoaded()
  if (seenMessageIds!.has(input.messageId)) return
  seenMessageIds!.add(input.messageId)
  store.events.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
    cost: input.cost ?? 0,
    priced: input.cost !== null,
  })
  persist()
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** How many of the turns in this total ran on a model with no published
   *  price. Non-zero means `cost` is a floor, not the bill — which is what
   *  lets a client say so instead of showing a confident wrong number. */
  unpricedTurns: number
}

export interface UsageModelBreakdown extends UsageTotals {
  model: string
}

export interface UsageSummary {
  totals: UsageTotals
  byModel: UsageModelBreakdown[]
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    unpricedTurns: 0,
  }
}

function addInto(totals: UsageTotals, event: UsageEvent): void {
  totals.inputTokens += event.inputTokens
  totals.outputTokens += event.outputTokens
  totals.reasoningTokens += event.reasoningTokens
  totals.cacheReadTokens += event.cacheReadTokens
  totals.cacheWriteTokens += event.cacheWriteTokens
  totals.cost += event.cost
  if (event.priced === false) totals.unpricedTurns += 1
}

/** Sum tokens/cost across every OpenCode session this machine has ever run,
 *  plus a per-model breakdown. There's no per-project or per-user scoping here
 *  — a machine belongs to exactly one owner, and this counts all of it. */
export async function getUsageSummary(): Promise<UsageSummary> {
  const store = await ensureLoaded()
  const totals = emptyTotals()
  const byModel = new Map<string, UsageModelBreakdown>()

  for (const event of store.events) {
    addInto(totals, event)
    const model = event.model ?? 'unknown'
    let row = byModel.get(model)
    if (!row) {
      row = { model, ...emptyTotals() }
      byModel.set(model, row)
    }
    addInto(row, event)
  }

  return {
    totals,
    byModel: Array.from(byModel.values()).sort((a, b) => b.cost - a.cost || b.inputTokens - a.inputTokens),
  }
}

/** What one conversation has cost so far. */
export interface SessionSpend {
  cost: number
  /** Turns in it whose model has no published price — `cost` is then a floor. */
  unpricedTurns: number
}

/** Spend per session, for every session this machine has run.
 *
 *  Derived from the event log rather than kept on the session record: a session
 *  is a small record read on every listing, and a running total on it would be
 *  a second copy of a number that already exists — one that a crash between the
 *  two writes could leave disagreeing with the turns it claims to sum. */
export async function getSpendBySession(): Promise<Record<string, SessionSpend>> {
  const store = await ensureLoaded()
  const spend: Record<string, SessionSpend> = {}
  for (const event of store.events) {
    const row = (spend[event.ocSessionId] ??= { cost: 0, unpricedTurns: 0 })
    row.cost += event.cost
    if (event.priced === false) row.unpricedTurns += 1
  }
  return spend
}

/** One (UTC day, model) aggregate — the unit the Platform rollup stores, and
 *  the only shape of usage that ever leaves this machine. */
export interface UsageDayBucket extends UsageTotals {
  /** 'YYYY-MM-DD', UTC. */
  periodStart: string
  model: string
  turns: number
}

/** Every completed turn this machine has recorded, folded into (UTC day, model)
 *  buckets — the input to the Platform push (utils/usage-push.ts).
 *
 *  Recomputed from the full event log each time rather than kept as a running
 *  counter: that's what makes the push idempotent and self-healing. A day's
 *  bucket is always the whole truth about that day, so re-sending it overwrites
 *  rather than accumulates, and a machine that was stopped for three days comes
 *  back knowing exactly what each of those days holds.
 *
 *  UTC, deliberately — the Platform buckets, budgets and every other machine
 *  in the org use the same clock, so one turn can't land in two different
 *  "months" depending on who's reading. */
export async function getDailyBuckets(): Promise<UsageDayBucket[]> {
  const store = await ensureLoaded()
  const buckets = new Map<string, UsageDayBucket>()
  for (const event of store.events) {
    const periodStart = event.createdAt.slice(0, 10)
    const model = event.model ?? 'unknown'
    const key = `${periodStart}\0${model}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { periodStart, model, turns: 0, ...emptyTotals() }
      buckets.set(key, bucket)
    }
    addInto(bucket, event)
    bucket.turns += 1
  }
  return Array.from(buckets.values()).sort(
    (a, b) => a.periodStart.localeCompare(b.periodStart) || a.model.localeCompare(b.model),
  )
}
