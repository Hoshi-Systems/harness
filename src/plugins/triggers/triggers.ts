import { CronExpressionParser } from 'cron-parser'
import { timingSafeEqual } from 'node:crypto'
import { apiError, createCachedStore, writeHoshiJson } from '../../kernel/index.js'
import { generateSigningSecret } from './webhook-signature.js'

/**
 * ── Trigger store ────────────────────────────────────────────────────────────
 *
 * Schedules live on the machine, in ~/.hoshi/schedules.json (see kernel/store.ts
 * for why OpenCode's global config can't hold them: ≥1.17.13 rejects the
 * foreign key — boot error from the file, silent drop on PATCH). The scheduler
 * reads the in-memory store every tick (json-store.ts owns the caching and
 * persistence mechanics).
 *
 **/

/** Where schedules lived before ~/.hoshi (< OpenCode 1.17.13): one JSON-encoded
 *  string in the global config. Checked once at first load so a brownfield
 *  machine keeps its schedules — and gets the now-boot-breaking key scrubbed
 *  from its config file. */

/** A schedule's cadence is driven by exactly one of two modes: `intervalMinutes`
 *  (the original "every N minutes" cadence) or `cronExpression` (CYB-91's
 *  fine-grained "every weekday at 9am" cadence, parsed with cron-parser). The
 *  unused side is always null — never both, never neither — enforced by
 *  `resolveCadence` at the request boundary. Brownfield schedules on disk
 *  predate `cronExpression` and simply lack the key; the revive step normalizes
 *  it to null on load so every in-memory Schedule has both fields.
 *
 *  A trigger's ACTION is likewise exactly one of two modes: its own `prompt`
 *  (the original temporary-agent dispatch) or `workflowId` (fire a workflow —
 *  utils/workflows.ts — as a multi-step run). `resolveTriggerAction` enforces
 *  the exclusivity; workflow mode stores `prompt: ''`. Brownfield rows predate
 *  `workflowId` the same way they predate `cronExpression`. */
export interface Schedule {
  id: string
  projectId: string | null
  name: string
  prompt: string
  workflowId: string | null
  intervalMinutes: number | null
  cronExpression: string | null
  /** IANA zone the cron expression's wall-clock time is written in, e.g.
   *  `Europe/Kyiv`. A cron says "at 9:00" and means nothing until a zone says
   *  which 9:00; without one, cron-parser resolves against the MACHINE's local
   *  time, which is a container detail (UTC) the user never sees — so "every
   *  weekday at 9am" fired three hours late for a Kyiv user. The client sends
   *  its own zone at create time.
   *
   *  Storing the zone rather than pre-converting to UTC is what makes DST work:
   *  09:00 Europe/Kyiv stays 09:00 across the March and October shifts, where a
   *  baked-in UTC offset would drift by an hour twice a year.
   *
   *  Null for interval-mode schedules (no wall clock to anchor) and for
   *  brownfield rows, which keep resolving against machine-local time exactly
   *  as they did before this field existed. */
  timezone: string | null
  /** Model this schedule's runs dispatch on, as `providerID/modelID` — null
   *  falls back to the machine's default model (Preferences), same convention
   *  as Preferences.model. Brownfield rows predate this field and simply lack
   *  the key; the revive step below normalizes it to null. */
  model: string | null
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string
  createdAt: string
}

/** Event-driven counterpart to Schedule (CYB-77): fires immediately when its
 *  unique, secret-bearing URL is called, instead of on a timer. `secret` is
 *  opaque and unguessable — it's part of the invocation URL, never a value the
 *  owner types in themselves. */
export interface WebhookTrigger {
  id: string
  projectId: string | null
  name: string
  prompt: string
  workflowId: string | null
  enabled: boolean
  secret: string
  /** Optional HMAC shared secret (utils/webhook-signature.ts). Null = the URL
   *  secret is the only auth, which is how every webhook worked before v2.
   *  Set → a fire must carry a valid `X-Hoshi-Signature`/`X-Hoshi-Timestamp`
   *  pair or it is rejected before the body is even parsed.
   *
   *  Unlike a vault secret this one IS returned to the owner's client: it is
   *  useless without the invocation URL (which the same response already
   *  carries in full), and the owner has to paste it into the sending system. */
  signingSecret: string | null
  lastFiredAt: string | null
  createdAt: string
}

interface TriggerStore {
  schedules: Schedule[]
  webhooks: WebhookTrigger[]
}

/** Revive whatever the file held, migrating a legacy config-key store when the
 *  file doesn't exist yet. Nothing anywhere → start empty and persist on the
 *  first mutation. `webhooks` defaults to [] for a store written before it
 *  existed, so a brownfield machine loads cleanly. */
const triggerStore = createCachedStore<TriggerStore>('schedules.json', async (stored) => {
  const parsed = stored as TriggerStore | null
  const store =
    parsed && Array.isArray(parsed.schedules)
      ? { schedules: parsed.schedules, webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : [] }
      : { schedules: [], webhooks: [] }
  /**
   *
   * Brownfield schedules (pre-CYB-91) have no cronExpression key at all —
   * normalize it to null so every in-memory Schedule has both cadence fields.
   * Same treatment for `model` and `workflowId`, both added later still; same
   * for `workflowId` on webhooks (it predates the workflows module).
   *
   **/
  for (const schedule of store.schedules) {
    if (schedule.cronExpression === undefined) schedule.cronExpression = null
    if (schedule.model === undefined) schedule.model = null
    if (schedule.workflowId === undefined) schedule.workflowId = null
    if (schedule.timezone === undefined) schedule.timezone = null
  }
  for (const webhook of store.webhooks) {
    if (webhook.workflowId === undefined) webhook.workflowId = null
    if (webhook.signingSecret === undefined) webhook.signingSecret = null
  }
  return store
})

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/** The cron expression's next occurrence from now — validated already (either
 *  at request time via `resolveCadence`, or implicitly, since it's never
 *  written to disk without passing that gate first). */
function nextCronRun(expression: string, timezone: string | null): string {
  /**
   *
   * No zone → machine-local, which is what every schedule written before
   * `timezone` existed has always resolved against. Keeping that as the null
   * behaviour means brownfield rows don't silently jump hours on upgrade.
   *
   **/
  const options = timezone ? { tz: timezone } : undefined
  return CronExpressionParser.parse(expression, options).next().toDate().toISOString()
}

/** A schedule's next run, picking whichever cadence mode currently drives it —
 *  cron takes priority when set, otherwise the interval math. Shared by
 *  create, update, and markScheduleRun so all three roll forward identically. */
function computeNextRun(schedule: Pick<Schedule, 'intervalMinutes' | 'cronExpression' | 'timezone'>): string {
  if (schedule.cronExpression) return nextCronRun(schedule.cronExpression, schedule.timezone ?? null)
  return minutesFromNow(schedule.intervalMinutes ?? MIN_INTERVAL_MINUTES)
}

/**
 * ── Schedules ────────────────────────────────────────────────────────────────
 *
 **/

export async function listSchedules(): Promise<Schedule[]> {
  return (await triggerStore.load()).schedules
}

export async function createSchedule(fields: {
  name: string
  prompt: string
  workflowId: string | null
  intervalMinutes: number | null
  cronExpression: string | null
  timezone: string | null
  projectId: string | null
  model: string | null
}): Promise<Schedule> {
  const store = await triggerStore.load()
  const schedule: Schedule = {
    id: crypto.randomUUID(),
    projectId: fields.projectId,
    name: fields.name,
    prompt: fields.prompt,
    workflowId: fields.workflowId,
    intervalMinutes: fields.intervalMinutes,
    cronExpression: fields.cronExpression,
    timezone: fields.timezone,
    model: fields.model,
    enabled: true,
    lastRunAt: null,
    nextRunAt: computeNextRun(fields),
    createdAt: new Date().toISOString(),
  }
  store.schedules.push(schedule)
  triggerStore.persist()
  return schedule
}

export async function updateSchedule(
  id: string,
  fields: Partial<
    Pick<
      Schedule,
      'name' | 'prompt' | 'workflowId' | 'intervalMinutes' | 'cronExpression' | 'timezone' | 'enabled' | 'model'
    >
  >,
): Promise<Schedule | undefined> {
  const store = await triggerStore.load()
  const schedule = store.schedules.find((s) => s.id === id)
  if (!schedule) return undefined
  Object.assign(schedule, fields)
  /**
   *
   * A new cadence takes effect from now — otherwise the change waits out the
   * old (possibly far-future) nextRunAt before it bites.
   *
   **/
  if (fields.intervalMinutes !== undefined || fields.cronExpression !== undefined || fields.timezone !== undefined) {
    schedule.nextRunAt = computeNextRun(schedule)
  }
  triggerStore.persist()
  return schedule
}

/** Look up a single schedule — the "run now" test-fire route's lookup (CYB-91),
 *  doesn't need the whole list. */
export async function getSchedule(id: string): Promise<Schedule | undefined> {
  return (await triggerStore.load()).schedules.find((s) => s.id === id)
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const store = await triggerStore.load()
  const before = store.schedules.length
  store.schedules = store.schedules.filter((s) => s.id !== id)
  if (store.schedules.length === before) return false
  triggerStore.persist()
  return true
}

/** Enabled schedules whose next run is due — the scheduler's work list. */
export async function listDueSchedules(): Promise<Schedule[]> {
  const now = new Date().toISOString()
  return (await triggerStore.load()).schedules.filter((s) => s.enabled && s.nextRunAt <= now)
}

/** Stamp a run and roll next_run forward from now (not the missed slot, so a
 *  backlog never bursts into catch-up runs) — via the cron expression when
 *  the schedule is cron-mode, via interval math otherwise. */
export async function markScheduleRun(id: string): Promise<void> {
  const store = await triggerStore.load()
  const schedule = store.schedules.find((s) => s.id === id)
  if (!schedule) return
  schedule.lastRunAt = new Date().toISOString()
  schedule.nextRunAt = computeNextRun(schedule)
  triggerStore.persist()
}

/**
 * ── Webhooks ─────────────────────────────────────────────────────────────────
 *
 **/

export async function listWebhooks(): Promise<WebhookTrigger[]> {
  return (await triggerStore.load()).webhooks
}

export async function createWebhookTrigger(fields: {
  name: string
  prompt: string
  workflowId: string | null
  projectId: string | null
}): Promise<WebhookTrigger> {
  const store = await triggerStore.load()
  const webhook: WebhookTrigger = {
    id: crypto.randomUUID(),
    projectId: fields.projectId,
    name: fields.name,
    prompt: fields.prompt,
    workflowId: fields.workflowId,
    enabled: true,
    secret: crypto.randomUUID(),
    signingSecret: null,
    lastFiredAt: null,
    createdAt: new Date().toISOString(),
  }
  store.webhooks.push(webhook)
  triggerStore.persist()
  return webhook
}

export async function updateWebhookTrigger(
  id: string,
  fields: Partial<Pick<WebhookTrigger, 'name' | 'prompt' | 'workflowId' | 'enabled'>>,
): Promise<WebhookTrigger | undefined> {
  const store = await triggerStore.load()
  const webhook = store.webhooks.find((w) => w.id === id)
  if (!webhook) return undefined
  Object.assign(webhook, fields)
  triggerStore.persist()
  return webhook
}

export async function deleteWebhookTrigger(id: string): Promise<boolean> {
  const store = await triggerStore.load()
  const before = store.webhooks.length
  store.webhooks = store.webhooks.filter((w) => w.id !== id)
  if (store.webhooks.length === before) return false
  triggerStore.persist()
  return true
}

/** Rotate a webhook's secret — the old invocation URL stops working the
 *  instant this persists. */
export async function regenerateWebhookSecret(id: string): Promise<WebhookTrigger | undefined> {
  const store = await triggerStore.load()
  const webhook = store.webhooks.find((w) => w.id === id)
  if (!webhook) return undefined
  webhook.secret = crypto.randomUUID()
  triggerStore.persist()
  return webhook
}

/** Turn signing on, or rotate the secret of a webhook that already signs — one
 *  action, the same shape as regenerateWebhookSecret: whatever the sender was
 *  configured with stops working the instant this persists. */
export async function setWebhookSigningSecret(id: string): Promise<WebhookTrigger | undefined> {
  const store = await triggerStore.load()
  const webhook = store.webhooks.find((w) => w.id === id)
  if (!webhook) return undefined
  webhook.signingSecret = generateSigningSecret()
  triggerStore.persist()
  return webhook
}

/** Turn signing back off — unsigned fires to the invocation URL are accepted
 *  again. */
export async function clearWebhookSigningSecret(id: string): Promise<WebhookTrigger | undefined> {
  const store = await triggerStore.load()
  const webhook = store.webhooks.find((w) => w.id === id)
  if (!webhook) return undefined
  webhook.signingSecret = null
  triggerStore.persist()
  return webhook
}

/**
 *
 * Resolve a webhook for the public firing route. Matches only when the id AND
 * secret AND enabled all agree — returns undefined on any mismatch so the route
 * can answer a uniform 404 without leaking which part was wrong.
 *
 * The secret compare is constant-time (security/SECURITY_AUDIT.md L9). `!==` on
 * two strings returns at the first differing byte, so how long it takes is a
 * function of how much of the secret the caller already has — the classic
 * byte-at-a-time recovery. It is not a practical attack against 122 bits of
 * UUID over a network, which is why this was Low; it is also two lines to
 * remove, and `equalSecret` is then the one place the question is settled
 * rather than a judgement re-made at every comparison.
 *
 **/
export async function findWebhookForFire(id: string, secret: string): Promise<WebhookTrigger | undefined> {
  const webhook = (await triggerStore.load()).webhooks.find((w) => w.id === id)
  if (!webhook || !webhook.enabled) return undefined
  return equalSecret(webhook.secret, secret) ? webhook : undefined
}

/**
 *
 * Compare two secrets without leaking where they diverge.
 *
 * `timingSafeEqual` throws on a length mismatch — which is itself a comparison,
 * but the LENGTH of a webhook secret is not the secret: every one is a UUID
 * this file mints, so a caller learns nothing from it that the format already
 * tells them.
 *
 **/
function equalSecret(stored: string, given: string): boolean {
  const left = Buffer.from(stored)
  const right = Buffer.from(given)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function markWebhookFired(id: string): Promise<void> {
  const store = await triggerStore.load()
  const webhook = store.webhooks.find((w) => w.id === id)
  if (!webhook) return
  webhook.lastFiredAt = new Date().toISOString()
  triggerStore.persist()
}

/**
 * ── Validation ───────────────────────────────────────────────────────────────
 *
 **/

/** Schedule cadence bounds (minutes): floor 5 minutes, ceiling 30 days. */
const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 60 * 24 * 30

/** Length caps for the editable trigger fields — create and patch validate
 *  identically (over-long input is rejected, never silently truncated). */
const MAX_TRIGGER_NAME = 120
const MAX_TRIGGER_PROMPT = 4000

export function validateTriggerName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_TRIGGER_NAME) {
    apiError(400, 'trigger.nameLength', `Enter a name (1–${MAX_TRIGGER_NAME} characters).`, { max: MAX_TRIGGER_NAME })
  }
  return name.trim()
}

/** Resolve the ACTION half of a trigger create/update payload — exactly one of
 *  `prompt` (dispatch a temporary agent) or `workflowId` (fire a workflow run)
 *  may drive a trigger, never both, never neither. Workflow mode stores
 *  `prompt: ''`. Whether the referenced workflow actually exists is the
 *  route's check (utils/workflows.ts) — this only settles the shape. */
export function resolveTriggerAction(
  promptRaw: unknown,
  workflowIdRaw: unknown,
): { prompt: string; workflowId: string | null } {
  const hasWorkflow = typeof workflowIdRaw === 'string' && workflowIdRaw.trim().length > 0
  const hasPrompt = typeof promptRaw === 'string' && promptRaw.trim().length > 0

  if (hasWorkflow && hasPrompt) {
    apiError(400, 'trigger.actionConflict', 'Set a prompt or a workflow, not both.')
  }
  if (!hasWorkflow && !hasPrompt) {
    apiError(400, 'trigger.actionRequired', 'Set a prompt or a workflow.')
  }

  if (hasWorkflow) return { prompt: '', workflowId: (workflowIdRaw as string).trim() }

  const prompt = (promptRaw as string).trim()
  if (prompt.length > MAX_TRIGGER_PROMPT) {
    apiError(400, 'trigger.promptLength', `Enter a prompt (1–${MAX_TRIGGER_PROMPT} characters).`, {
      max: MAX_TRIGGER_PROMPT,
    })
  }
  return { prompt, workflowId: null }
}

/** The workflow-delete cascade: every trigger bound to the workflow loses its
 *  binding AND is disabled in the same write — clearing `workflowId` alone
 *  would leave a trigger with no action at all ready to fire. Returns how many
 *  of each kind were detached (the DELETE response; triggers publish no
 *  machine events today, so the client refreshes off these counts). */
export async function detachWorkflowFromTriggers(workflowId: string): Promise<{ schedules: number; webhooks: number }> {
  const store = await triggerStore.load()
  let schedules = 0
  let webhooks = 0
  for (const schedule of store.schedules) {
    if (schedule.workflowId === workflowId) {
      schedule.workflowId = null
      schedule.enabled = false
      schedules++
    }
  }
  for (const webhook of store.webhooks) {
    if (webhook.workflowId === workflowId) {
      webhook.workflowId = null
      webhook.enabled = false
      webhooks++
    }
  }
  if (schedules + webhooks > 0) triggerStore.persist()
  return { schedules, webhooks }
}

/** Length cap for a raw cron expression string (CYB-91). */
const MAX_CRON_EXPRESSION = 100

/** Resolve the cadence half of a schedule create/update payload — exactly one
 *  of `intervalMinutes`/`cronExpression` may drive a schedule, never both,
 *  never neither. Shared by the create route (where a cadence is always
 *  required) and the patch route (called only when the request actually
 *  touches a cadence field, so a plain `enabled`/name/prompt patch never hits
 *  this). Validates a cron expression with cron-parser at the boundary so an
 *  unparseable one never reaches disk. */
/** Is this a zone the runtime actually knows? `Intl` is the authority already on
 *  the machine, and it throws on an unknown identifier — cheaper and always more
 *  current than shipping our own tz-database list. */
function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function resolveCadence(
  intervalMinutesRaw: unknown,
  cronExpressionRaw: unknown,
  timezoneRaw?: unknown,
): { intervalMinutes: number | null; cronExpression: string | null; timezone: string | null } {
  const hasCron = typeof cronExpressionRaw === 'string' && cronExpressionRaw.trim().length > 0
  const hasInterval = intervalMinutesRaw !== undefined && intervalMinutesRaw !== null

  if (hasCron && hasInterval) {
    apiError(400, 'schedule.cadenceConflict', 'Set an interval or a cron expression, not both.')
  }
  if (!hasCron && !hasInterval) {
    apiError(400, 'schedule.cadenceRequired', 'Set an interval or a cron expression.')
  }

  if (hasCron) {
    const cronExpression = (cronExpressionRaw as string).trim()
    if (cronExpression.length > MAX_CRON_EXPRESSION) {
      apiError(400, 'schedule.cronLength', `The cron expression must be at most ${MAX_CRON_EXPRESSION} characters.`, {
        max: MAX_CRON_EXPRESSION,
      })
    }
    try {
      CronExpressionParser.parse(cronExpression)
    } catch (error) {
      apiError(
        400,
        'schedule.cronInvalid',
        `Enter a valid cron expression: ${error instanceof Error ? error.message : 'unrecognized format'}.`,
      )
    }
    /**
     *
     * The zone only means something alongside a cron's wall clock, so it is
     * resolved here and nowhere else. Absent (an older client) keeps the
     * machine-local behaviour rather than guessing a zone on the user's behalf.
     *
     **/
    let timezone: string | null = null
    if (typeof timezoneRaw === 'string' && timezoneRaw.trim().length > 0) {
      timezone = timezoneRaw.trim()
      if (!isValidTimezone(timezone)) {
        apiError(400, 'schedule.timezoneInvalid', 'Enter a valid IANA time zone, like Europe/Kyiv.')
      }
    }
    return { intervalMinutes: null, cronExpression, timezone }
  }

  const interval = Number(intervalMinutesRaw)
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
    apiError(
      400,
      'schedule.intervalRange',
      `The interval must be ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} minutes.`,
      { min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES },
    )
  }
  /**
   *
   * Interval mode has no wall clock, so no zone to anchor.
   *
   **/
  return { intervalMinutes: interval, cronExpression: null, timezone: null }
}
