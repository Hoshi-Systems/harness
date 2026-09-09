import { historyStore } from './history.js'
import { readMessages, replaceMessages, truncateMessages } from './messages.js'
import { createSession, getSession, touchSession, type Session } from './sessions.js'
import { isTurnRunning } from './turns.js'

/**
 * ── Rewriting a session's past ───────────────────────────────────────────────
 *
 * Rewind and fork. Both cut TWO stores at one point: the transcript people read
 * (engine/messages.ts) and the conversation the model remembers
 * (engine/history.ts). Cutting only the first is the trap this module exists to
 * avoid — an "undo" after which the agent still remembers what the person sees
 * undone is worse than no undo at all, and it is exactly what the single-store
 * migration bug looked like from the other side.
 *
 * The alignment is `historyAt` on each user message: the length of the model's
 * memory at the moment that turn began, stamped by sendMessage. Cutting the
 * transcript before a user message and the memory to its `historyAt` lands both
 * stores on the same moment, exactly — no guessing, no content matching.
 *
 **/

export class TimelineBusyError extends Error {}
export class TimelineAnchorError extends Error {}

function assertIdle(sessionId: string): void {
  if (isTurnRunning(sessionId)) {
    throw new TimelineBusyError('The session is generating — stop the turn before rewriting its history.')
  }
}

/** Roll a session back to the moment before `messageId` was sent. The anchor
 *  and everything after it disappear from both stores. */
export async function rewindSession(sessionId: string, messageId: string): Promise<void> {
  assertIdle(sessionId)
  const anchor = await truncateMessages(sessionId, messageId)
  if (!anchor) throw new TimelineAnchorError('No such message in this session.')
  if (anchor.historyAt === undefined) {
    /**
     *
     * A message from before the stamp existed. The transcript is already cut;
     * leaving the memory whole would be the lie described above, so the safe
     * floor is to cut memory back to nothing and let the model re-read the
     * transcript's survivors as context on the next turn... except it cannot:
     * history IS its context. Refusing after the truncate would leave the
     * stores misaligned, so cut memory conservatively to the same count of
     * messages as the surviving transcript.
     *
     **/
    const survivors = await readMessages(sessionId)
    const memory = (await historyStore.load(sessionId)) ?? []
    await historyStore.save(sessionId, memory.slice(0, survivors.length))
  } else {
    const memory = (await historyStore.load(sessionId)) ?? []
    await historyStore.save(sessionId, memory.slice(0, anchor.historyAt))
  }
  /**
   *
   * The session moved; the list should say so (publishes session.updated).
   *
   **/
  await touchSession(sessionId)
}

/** Branch a new session carrying history up to (and excluding) `messageId` —
 *  or the whole conversation when no anchor is given. The original is never
 *  touched. */
export async function forkSession(sessionId: string, messageId?: string): Promise<Session> {
  assertIdle(sessionId)
  const source = await getSession(sessionId)
  if (!source) throw new TimelineAnchorError('No such session on this machine.')

  const messages = await readMessages(sessionId)
  const memory = (await historyStore.load(sessionId)) ?? []

  let keepMessages = messages
  let keepMemory = memory
  if (messageId) {
    const index = messages.findIndex((message) => message.id === messageId)
    if (index === -1) throw new TimelineAnchorError('No such message in this session.')
    keepMessages = messages.slice(0, index)
    const anchor = messages[index]!
    keepMemory =
      anchor.historyAt === undefined ? memory.slice(0, keepMessages.length) : memory.slice(0, anchor.historyAt)
  }

  /**
   *
   * A fork of a chat is a chat. Carrying the flag is not decoration: without it
   * forking silently promoted a read-only conversation into a read-write one,
   * complete with a copy of the whole transcript — which is both a surprise and
   * exactly the cost a chat exists to avoid. Promoting a chat to a task is a
   * reasonable thing to want and should be a deliberate, named action, not a
   * side effect of "branch this conversation".
   *
   **/
  const fork = await createSession(source.directory, source.chat ? { chat: true } : {})
  await replaceMessages(fork.id, keepMessages)
  await historyStore.save(fork.id, keepMemory)
  return fork
}
