import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { TokenUsage } from '@openharness/core'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'

/**
 * ── Message history ──────────────────────────────────────────────────────────
 *
 * What was said in a session, durably. Kept apart from engine/sessions.ts on
 * purpose: a session record is small and read on every listing, while a
 * transcript grows without bound — folding them into one file would make
 * `GET /sessions` re-read every conversation on the machine.
 *
 * One file per session, so writing a turn never rewrites anybody else's history.
 *
 **/

/** A piece of a message, in the order the turn produced them: the model's own
 *  reasoning (when it thinks out loud), the tools it ran, the prose it wrote. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** A file the person attached. Kept in the transcript so reopening the
   *  session still shows what the question was asked ABOUT — the answer alone
   *  is unreadable without it. */
  | { type: 'file'; filename: string; mime: string; url: string }
  | {
      type: 'tool'
      name: string
      callId?: string
      /** `input` is what the call was asked to do, `output` what it produced,
       *  `error` why it failed. All three are the record: a client that only
       *  reloads — or a person scrolling back a week later — has nothing else
       *  to read, and "a tool ran" is not an account of what happened.
       *
       *  `metadata` is the tool's own structured result — a browser screenshot,
       *  what a memory write saved, the shape a card renders from. The model
       *  never sees it; the client renders from it, and reading it back is the
       *  only way to assert what a tool actually did rather than what it said. */
      state: {
        status: string
        input?: unknown
        output?: string
        error?: string
        metadata?: Record<string, unknown>
        /** Milliseconds the call took. `bash` for eight minutes and `bash` for
         *  200ms are the same card without it. */
        ms?: number
      }
    }

export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  createdAt: string
  /** When the turn that produced this message finished — null while it is
   *  still streaming. Unattended subsystems (workflow steps, goals) poll for
   *  exactly this: "has the answer landed yet" cannot be answered by presence,
   *  because the message row exists from the moment the turn starts. */
  completedAt?: string | null
  /** Set when the turn that produced this message failed — the client renders
   *  it as a failed turn rather than as an empty answer. */
  error?: { name: string; message: string } | null
  /** Why the model stopped: `stop` is a finished answer, `length` is one cut
   *  off at the output cap, `tool-calls` a step that ended to run a tool. Kept
   *  because the difference is otherwise invisible — a truncated answer reads
   *  as a complete one that happens to trail off, and nothing else in the
   *  record contradicts that reading. */
  finishReason?: string | null
  /** Milliseconds the MODEL spent generating, summed across the turn's steps —
   *  the honest denominator for a tokens-per-second figure. The turn's wall
   *  clock is not: a turn that ran thirteen tools spends most of it waiting on a
   *  shell, and dividing by that measures the machine's tools, not the model. */
  modelMs?: number | null
  /** How many times the provider had to be asked again before it answered. */
  retries?: number | null
  /** Set when the model's memory was folded during this turn — the user is told
   *  at the time and the record used to forget, leaving a conversation that
   *  quietly lost detail with nothing saying why. */
  compacted?: { tokensBefore: number; tokensAfter: number } | null
  /** What the turn cost, once it finished — the harness's own `TokenUsage`,
   *  stored as it comes rather than reshaped, so there is no second vocabulary
   *  for the same numbers. Recorded per message rather than accumulated on the
   *  session because the things that read it ask different questions: a goal's
   *  token budget wants the sum since it was armed, and the composer's context
   *  gauge wants the last turn's input alone. */
  usage?: TokenUsage | null
  /** Which model produced this — `provider/model`, as RESOLVED, so a turn sent
   *  with no model named still says what actually answered. The thread shows it
   *  and the spend ledger breaks down by it. */
  model?: string | null
  /** What the turn cost in money, from the catalogue's per-token pricing.
   *  Null when either half is unknown — a custom endpoint with no price, or a
   *  provider that reported no usage. Zero is a real answer (a free model),
   *  which is why unknown is not spelled 0. */
  cost?: number | null
  /** On a USER message: how long the model's memory (engine/history.ts) was
   *  when this turn started. The anchor rewind and fork cut both stores at —
   *  without it the transcript and the memory could only be aligned by
   *  guessing, and "undo" that leaves the model remembering what the person
   *  sees undone is worse than no undo at all. */
  historyAt?: number
}

const FILE = (sessionId: string) => hoshiFile(`messages/${sessionId}.json`)

/** Which sessions have a transcript on disk. Read from the directory rather
 *  than from the session list: a transcript outlives nothing, but a session
 *  deleted mid-restart would otherwise leave its wreckage unreachable. */
async function listMessageSessions(): Promise<string[]> {
  try {
    const names = await readdir(path.dirname(FILE('x')))
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

export async function readMessages(sessionId: string): Promise<Message[]> {
  const data = await readHoshiJson<{ messages?: Message[] }>(FILE(sessionId))
  return Array.isArray(data?.messages) ? data.messages : []
}

/** Serialized per session: a turn appends while the previous append may still
 *  be in flight, and two concurrent writes would drop one of the messages. */
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  queues.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Replace a session's whole transcript.
 *
 *  For a transcript that is DERIVED rather than accumulated — a delegated
 *  specialist's, rebuilt from its own conversation each time it is saved. An
 *  append-only writer cannot express that: the source is rewritten whole, and
 *  appending would duplicate every message on every save. */
export async function writeMessages(sessionId: string, messages: Message[]): Promise<void> {
  await serialize(sessionId, async () => {
    await writeHoshiJson(FILE(sessionId), { messages })
  })
}

export async function appendMessage(sessionId: string, message: Message): Promise<void> {
  await serialize(sessionId, async () => {
    const messages = await readMessages(sessionId)
    await writeHoshiJson(FILE(sessionId), { messages: [...messages, message] })
  })
}

/** Replace a message in place — how a streaming assistant reply is committed
 *  once it finishes, without leaving a half-written duplicate behind. */
export async function updateMessage(sessionId: string, id: string, patch: Partial<Message>): Promise<void> {
  await serialize(sessionId, async () => {
    const messages = await readMessages(sessionId)
    const index = messages.findIndex((message) => message.id === id)
    if (index === -1) return
    messages[index] = { ...messages[index]!, ...patch }
    await writeHoshiJson(FILE(sessionId), { messages })
  })
}

/** Drop `fromId` and everything after it. Returns the removed anchor, or null
 *  when the id is not in this session — the caller needs its `historyAt` to cut
 *  the model's memory at the same point. */
export async function truncateMessages(sessionId: string, fromId: string): Promise<Message | null> {
  let anchor: Message | null = null
  await serialize(sessionId, async () => {
    const messages = await readMessages(sessionId)
    const index = messages.findIndex((message) => message.id === fromId)
    if (index === -1) return
    anchor = messages[index]!
    await writeHoshiJson(FILE(sessionId), { messages: messages.slice(0, index) })
  })
  return anchor
}

/** Replace a session's whole transcript — how a fork seeds its copy. */
export async function replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
  await serialize(sessionId, async () => {
    await writeHoshiJson(FILE(sessionId), { messages })
  })
}

export async function deleteMessages(sessionId: string): Promise<void> {
  await serialize(sessionId, async () => {
    await writeHoshiJson(FILE(sessionId), { messages: [] })
  })
}

/** Settle every message a restart interrupted.
 *
 *  A turn lives in this process's memory and nowhere else, so a message still
 *  showing `completedAt: null` at boot is not in flight — it is the wreckage of
 *  a turn that died with the previous process, and nothing will ever finish it.
 *
 *  Left alone it is not merely untidy: a client renders it as a reply still
 *  arriving, forever, and anything that waits for the turn waits with it. A
 *  workflow run adopting an in-flight node held the machine's single run slot
 *  and starved every queued run behind it — the failure was a machine that had
 *  simply stopped running workflows, with nothing in any log to say why.
 *
 *  Marked as an error rather than quietly completed: the answer really was cut
 *  off mid-sentence, and saying so is what lets a person (or a retry) act. */
export async function settleInterruptedMessages(): Promise<number> {
  let settled = 0
  for (const sessionId of await listMessageSessions()) {
    for (const message of await readMessages(sessionId)) {
      if (message.role !== 'assistant' || message.completedAt) continue
      await updateMessage(sessionId, message.id, {
        completedAt: new Date().toISOString(),
        error: { name: 'MachineRestartedError', message: 'The machine restarted while this turn was running.' },
      })
      settled += 1
    }
  }
  return settled
}
