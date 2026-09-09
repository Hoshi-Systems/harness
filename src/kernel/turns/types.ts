import type { LiveToolRecord } from '../turn-parts.js'

/**
 * ── What a turn in flight is made of ─────────────────────────────────────────
 *
 * Its own module because both halves of the turn machinery need it: the loop
 * that fills a LiveTurn, and the flush that writes one down. While these types
 * were private to turns.ts, splitting the two meant one importing the other and
 * back — the cycle check-cycles.mjs exists to stop.
 *
 **/

/** A turn in flight. In memory only: it describes work owned by THIS process,
 *  and a "running" turn restored from disk would be a lie no client could
 *  recover from. */
export interface LiveTurn {
  sessionId: string
  messageId: string
  controller: AbortController
  /** Everything emitted so far, so a late subscriber gets the whole answer
   *  rather than joining mid-sentence. */
  text: string
  /** What the model thought before it answered, when it thinks out loud. Kept
   *  apart from `text` because they are different things to a reader: one is
   *  the answer, the other is how it got there, folded away by default. */
  reasoning: string
  /** Tools this turn ran, in the order it ran them — each carrying `textAt`,
   *  the interleaving anchor turn-parts.ts splits the prose at. Kept because
   *  the transcript is written once per flush: without this the saved turn is
   *  prose only, and reopening a session that spent ten minutes running
   *  commands shows the summary with no sign of the work. Live clients see the
   *  events; anyone who reloads sees the record, and the two should agree. */
  tools: LiveToolRecord[]
  /** Guards against a second write starting while one is in flight, and records
   *  when the last one began — see flushLive. */
  flushing: boolean
  flushedAt: number
  subscribers: Set<Subscriber>
  done: boolean
}

export interface Subscriber {
  onChunk: (chunk: string) => void
  /** Called when the turn ends, however it ends. Without this a rejoined
   *  stream would stay open forever after the answer finished — the client
   *  holds a connection that will never produce another byte, and cannot tell
   *  that from a slow model. */
  onDone: () => void
}
