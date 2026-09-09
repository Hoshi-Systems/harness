import { updateMessage } from '../messages.js'
import { turnParts } from '../turn-parts.js'
import type { LiveTurn } from './types.js'

/**
 * ── Writing the answer down while it is still being written ──────────────────
 *
 * The transcript used to be written ONCE, when the turn ended. Everything before
 * that lived in this process's memory and went out as events — so a reload
 * mid-turn read the stored message, found it empty, and showed "Thinking" under
 * an answer the person had been watching arrive. A long answer plus a refresh
 * was a long answer lost. Worse, a machine that restarted mid-turn lost it for
 * good: there was nothing on disk to recover.
 *
 * Throttled, not per-delta: a token at a time would mean thousands of writes of
 * a growing document. A second's granularity is invisible to a person and costs
 * one write per second per running turn.
 *
 * `flushing` is not an optimisation — `updateMessage` serialises per session, so
 * without it a slow write would queue every delta behind it and the queue would
 * outlive the turn.
 */
const FLUSH_INTERVAL_MS = 1_000

async function flushLive(turn: LiveTurn): Promise<void> {
  if (turn.flushing || turn.done) return
  turn.flushing = true
  turn.flushedAt = performance.now()
  try {
    await updateMessage(turn.sessionId, turn.messageId, { parts: turnParts(turn) })
  } catch (error) {
    /**
     *
     * A failed intermediate write is not worth failing the turn over: the final
     * write is the one that must land, and the answer is still streaming to
     * whoever is watching.
     *
     **/
    console.warn(`[harness] could not persist the in-flight answer on ${turn.sessionId}:`, error)
  } finally {
    turn.flushing = false
  }
}

/** Persist if it has been long enough since the last time. Fire-and-forget: the
 *  stream must not wait on a disk write. */
function maybeFlush(turn: LiveTurn): void {
  if (turn.flushing || performance.now() - turn.flushedAt < FLUSH_INTERVAL_MS) return
  void flushLive(turn)
}

/** Mark a tool call settled in the turn's own record, so the transcript written
 *  at the end says what finished, what it produced, and what failed. */

export { FLUSH_INTERVAL_MS, flushLive, maybeFlush }
