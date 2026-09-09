import type { LiveTurn } from './types.js'

/**
 * ── Which sessions are generating right now ──────────────────────────────────
 *
 * The registry of in-flight turns, and it is a module of its own for one
 * reason: `history.ts` has to ask whether a turn is running before it appends
 * context, and `turns.ts` reads history to build the next one. Held in
 * `turns.ts`, that question was an import back out of history — the single
 * REVERSE edge in a cluster the cycle gate recorded as four separate known
 * cycles (history↔turns, and the three longer paths through sessions and
 * subagent-sessions that pass through the same edge).
 *
 * Every other edge in that cluster runs one way: turns reads history, sessions
 * and subagent-sessions; subagent-sessions reads sessions and history; sessions
 * reads history. Take this one edge out and the whole thing is acyclic, which
 * is why "genuine mutual recursion in the turn lifecycle, untangling it is a
 * kernel refactor" turned out to be neither — it is one Map in the wrong file.
 *
 * The state stays exactly where it was in every other sense: one process-wide
 * registry, mutated by the turn lifecycle, read by whoever needs to know.
 *
 **/

const live = new Map<string, LiveTurn>()

/** Is this session generating? */
export function isTurnRunning(sessionId: string): boolean {
  return live.has(sessionId)
}

/**
 *
 * Is this machine generating anything at all, in any session?
 *
 * Asked by the machine's own hidden model calls — naming a session, auditing a
 * goal — before they fire. A hosted API answers those in parallel and nobody
 * notices. A local runtime serves ONE request at a time: Ollama's default is a
 * single slot, so a title call issued while the user's turn is queued sits in
 * front of it and the answer they are waiting for does not start until the
 * machine has finished talking to itself.
 *
 **/
export function anyTurnRunning(): boolean {
  return live.size > 0
}

/** The in-flight turn for a session, or undefined. */
export function liveTurn(sessionId: string): LiveTurn | undefined {
  return live.get(sessionId)
}

export function registerTurn(sessionId: string, turn: LiveTurn): void {
  live.set(sessionId, turn)
}

export function unregisterTurn(sessionId: string): void {
  live.delete(sessionId)
}
