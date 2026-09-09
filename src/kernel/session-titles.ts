import { readMessages, type Message } from './messages.js'
import { complete } from './model.js'
import { getSession, renameSession } from './sessions.js'
import { anyTurnRunning } from './turns.js'
import { createCachedStore } from './json-store.js'
import { subscribeMachineEvents, type MachineEvent } from './events.js'
import { getPreferences } from './preferences.js'

/**
 * ── Session titles ───────────────────────────────────────────────────────────
 *
 * A session starts nameless and gets named from what was actually said in it,
 * then renamed again as the conversation drifts — unless somebody else has
 * claimed the name, in which case nothing here touches it again.
 *
 * THIS IS THE FALLBACK NOW, not the first choice. The agent can name its own
 * session (`session_update`, plugins/sessions/), and when it does this stands
 * down: it read the request, while everything below reads a clipped transcript
 * after the fact. What is left here is what it was always good for — a session
 * whose agent never said anything about the name, and the sessions no agent
 * drives at all.
 *
 * This used to be a tick that walked every scope's sessions every 30 seconds,
 * because the old runtime named a session exactly once (at its first user
 * message) and froze the title forever after; keeping titles honest meant
 * re-deriving from the outside which ones had moved on, without ever being told
 * that anything happened. Our engine publishes `message.completed`, which is
 * precisely the moment a title could have become wrong — so this listens for it
 * instead. No tick, no workspace scan, no cooldowns for sessions parked
 * mid-turn, and no window in which a finished conversation still wears the
 * wrong name.
 *
 * A fresh title reaches every client as the `session.updated` event that
 * renameSession already publishes.
 *
 **/

/** Re-title once the conversation has grown by this many user messages since it
 *  was last named — "occasionally", not every turn. */
const REFRESH_EVERY_USER_MESSAGES = 3
/** Transcript budget for the generation call. */
const TRANSCRIPT_MESSAGES = 12
const TRANSCRIPT_PART_CHARS = 400
const TRANSCRIPT_TOTAL_CHARS = 5_000
/** Titles the model returns are clipped to this. */
const TITLE_MAX_CHARS = 80
/** Store cap — entries beyond this are pruned oldest-first (claimed last). */
const MAX_TRACKED_SESSIONS = 2_000
const TITLE_CALL_TIMEOUT_MS = 60_000

interface TitleEntry {
  /** The user named this session themselves — hands off, forever. */
  manual?: boolean
  /** The AGENT named it, with `session_update`. Also hands off, and for a
   *  better reason than deference: it read the request, while the generation
   *  below reads a clipped transcript after the fact. See titleOwner(). */
  agent?: boolean
  /** User-message count when the title was last set or adopted. */
  countAtTitle?: number
  /** When this entry was last touched, for pruning. */
  touchedAt?: number
}

interface TitleStore {
  sessions: Record<string, TitleEntry>
}

const titleStore = createCachedStore<TitleStore>('session-titles.json', (stored) => {
  const sessions = (stored as TitleStore | null)?.sessions
  return { sessions: sessions && typeof sessions === 'object' ? sessions : {} }
})

/** Who wrote the title a session is wearing.
 *
 *  `machine` — nobody has claimed it, so the generation below owns it.
 *  `agent`   — the turn named its own session, and keeps it until it renames.
 *  `user`    — a person named it, and nothing else may write it again.
 *
 *  Three states rather than a boolean, because the two that are not `machine`
 *  are not interchangeable: `session_update` must refuse a `user` title and may
 *  replace an `agent` one, and a single "manual" flag cannot tell them apart. */
export type TitleOwner = 'machine' | 'agent' | 'user'

export async function titleOwner(sessionId: string): Promise<TitleOwner> {
  const entry = (await titleStore.load()).sessions[sessionId]
  if (entry?.manual) return 'user'
  if (entry?.agent) return 'agent'
  return 'machine'
}

/** Record that this session's title is not ours to change — a user rename
 *  (routes/sessions.id.patch.ts, the one place a person can name a session)
 *  or a caller that pinned its own title, like a dispatched run or a workflow
 *  step.
 *
 *  The agent flag comes OFF: a person renaming a session the agent named is
 *  taking it from the agent, and leaving both set would make `titleOwner` depend
 *  on the order it happens to check them in. */
export async function markManualTitle(sessionId: string): Promise<void> {
  const store = await titleStore.load()
  const { agent: _taken, ...rest } = store.sessions[sessionId] ?? {}
  store.sessions[sessionId] = { ...rest, manual: true, touchedAt: Date.now() }
  titleStore.persist()
}

/** Record that the AGENT named this session, with `session_update`.
 *
 *  Not `manual` — a user rename still outranks it, and `releaseTitle` still
 *  hands the session back. What it buys is that the generation below stands
 *  down: an agent that names its own thread has read the request the thread is
 *  about, which is strictly more than a small model summarizing the last twelve
 *  messages after the fact. Two writers for one field is how a title flickers.
 *
 *  A no-op on a session the user has named, so a caller that skipped the
 *  `titleOwner` check cannot launder a rename through this. */
export async function markAgentTitle(sessionId: string): Promise<void> {
  const store = await titleStore.load()
  if (store.sessions[sessionId]?.manual) return
  store.sessions[sessionId] = { ...store.sessions[sessionId], agent: true, touchedAt: Date.now() }
  titleStore.persist()
}

/** Hand a session's title back — the user cleared it, which is how they undo a
 *  rename, and asking for no title is asking for ours again. */
export async function releaseTitle(sessionId: string): Promise<void> {
  const store = await titleStore.load()
  delete store.sessions[sessionId]
  titleStore.persist()
}

/** Counts toward the refresh cadence only if the user actually said something.
 *  A message with no prose is a file drop or an empty send — it moves the
 *  conversation nowhere a title should follow. */
function isRealUserMessage(message: Message): boolean {
  return message.role === 'user' && !!messageText(message)
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The visible prose of one message — tool parts say nothing about what the
 *  conversation is ABOUT. */
function messageText(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
}

/** The tail of the conversation, condensed for the title call. */
function buildTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages.slice(-TRANSCRIPT_MESSAGES)) {
    const text = messageText(message)
    if (!text) continue
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(text, TRANSCRIPT_PART_CHARS)}`)
  }
  return clip(lines.join('\n\n'), TRANSCRIPT_TOTAL_CHARS)
}

/** One line, unquoted, bounded — a small model occasionally decorates its
 *  answer despite instructions. Null when nothing usable remains. */
function sanitizeTitle(raw: string): string | null {
  const first = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0]
  if (!first) return null
  const cleaned = first
    .replace(/^["'`«»„“”]+|["'`«»„“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? clip(cleaned, TITLE_MAX_CHARS) : null
}

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.
Generate a brief title (under 50 characters) that summarizes what this conversation is about NOW and would help the user find it later.
Respond in the same language as the conversation. Do not answer the conversation itself. No quotes, no trailing punctuation.`

/** One hidden call: transcript in, sanitized title (or null) out. On the small
 *  model when the machine has one — naming a thread is not work worth paying
 *  the default model for. */
async function generateTitle(transcript: string): Promise<string | null> {
  try {
    const { smallModel } = await getPreferences()
    const text = await complete(transcript, {
      ...(smallModel ? { model: smallModel } : {}),
      system: TITLE_SYSTEM_PROMPT,
      timeoutMs: TITLE_CALL_TIMEOUT_MS,
    })
    return sanitizeTitle(text)
  } catch (error) {
    console.error('[session-titles] title generation failed:', error)
    return null
  }
}

/** Name a session, or rename one whose conversation has clearly moved on since
 *  it was last named. Called for every turn that settles. */
async function considerSession(sessionId: string): Promise<void> {
  const store = await titleStore.load()
  if (claimed(store, sessionId)) return
  const session = await getSession(sessionId)
  if (!session) return

  const record = (patch: TitleEntry) => {
    store.sessions[sessionId] = { ...store.sessions[sessionId], ...patch, touchedAt: Date.now() }
    titleStore.persist()
  }

  const messages = await readMessages(sessionId)
  const userCount = messages.filter(isRealUserMessage).length
  if (userCount < 1) return

  if (session.title !== null) {
    const baseline = store.sessions[sessionId]?.countAtTitle
    /**
     *
     * A title with no baseline was not written by us — adopt the current count
     * rather than guess how old it is, and let the cadence run from here.
     *
     **/
    if (baseline == null) {
      record({ countAtTitle: userCount })
      return
    }
    if (userCount - baseline < REFRESH_EVERY_USER_MESSAGES) return
  }

  const transcript = buildTranscript(messages)
  if (!transcript) return

  /**
   *
   * Never while the machine is generating. A local runtime serves one request
   * at a time, so this call would sit in front of somebody's turn and the
   * answer they are waiting for would not start until the machine finished
   * naming a thread. Skipping is safe: titles are reconsidered on every turn
   * that ends, so the next quiet moment does the work.
   *
   **/
  if (anyTurnRunning()) return

  const title = await generateTitle(transcript)
  /**
   *
   * The call can run for a minute — a rename landing meanwhile is the user's,
   * and must not be clobbered. Re-read the live store rather than trusting the
   * read from the top of this function.
   *
   **/
  if (claimed(store, sessionId)) return
  if (title && title !== session.title) await renameSession(sessionId, title)
  /**
   *
   * Even a failed generation resets the cadence: retrying on every turn against
   * a model that cannot answer would burn calls, and the next window comes
   * around on its own.
   *
   **/
  record({ countAtTitle: userCount })
  pruneStore(store)
}

/** Somebody other than this module owns the title — a person, or the agent that
 *  named its own thread. Either way there is nothing here to generate. */
function claimed(store: TitleStore, sessionId: string): boolean {
  const entry = store.sessions[sessionId]
  return !!entry?.manual || !!entry?.agent
}

/** Keep the store bounded: drop the least recently touched entries first,
 *  claimed ones last (losing that flag would let this overwrite somebody's
 *  rename). */
function pruneStore(store: TitleStore): void {
  const ids = Object.keys(store.sessions)
  if (ids.length <= MAX_TRACKED_SESSIONS) return
  const byAge = ids.sort((a, b) => {
    const ea = store.sessions[a]!
    const eb = store.sessions[b]!
    const ca = !!ea.manual || !!ea.agent
    const cb = !!eb.manual || !!eb.agent
    if (ca !== cb) return ca ? 1 : -1
    return (ea.touchedAt ?? 0) - (eb.touchedAt ?? 0)
  })
  for (const id of byAge.slice(0, ids.length - MAX_TRACKED_SESSIONS)) delete store.sessions[id]
  titleStore.persist()
}

function onMachineEvent(event: MachineEvent): void {
  if (event.type !== 'message.completed') return
  const props = event.properties as { sessionId?: string; error?: unknown }
  /**
   *
   * A failed turn said nothing worth naming a thread after.
   *
   **/
  if (!props.sessionId || props.error) return
  void considerSession(props.sessionId).catch((error) =>
    console.error(`[session-titles] could not title ${props.sessionId}:`, error),
  )
}

/** Arm titling on the machine's own event bus. Called once, from
 *  plugins/session-titles.ts. */
export function watchSessionTitles(): () => void {
  return subscribeMachineEvents(onMachineEvent)
}
