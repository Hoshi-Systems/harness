import type { SessionStore } from '@openharness/core'
import type { ModelMessage } from 'ai'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'
import { isTurnRunning } from './turns/live.js'

/**
 * ── The model's memory ───────────────────────────────────────────────────────
 *
 * What the MODEL remembers of a session, which is not the same thing as what
 * the client renders. engine/messages.ts holds the transcript people read —
 * text, one row per turn, stable ids the UI keys off. This holds the harness's
 * own `ModelMessage[]`: assistant turns with their tool calls, and the tool
 * results that came back.
 *
 * They were one store, and the model paid for it. History was rebuilt from the
 * transcript by keeping the text parts and dropping everything else, so the
 * moment a turn ended the agent forgot every tool it had just run — it could
 * read a file, then next turn have no idea it had ever read it, no idea what
 * was in it, and no record of the command whose output it was about to act on.
 * The reply it wrote about the work was all that survived.
 *
 * So the library keeps its own conversation, losslessly, and we give it
 * somewhere to put it (`SessionStore`). One file per session, same as the
 * transcript, so writing a turn never rewrites anybody else's history.
 *
 **/

const FILE = (sessionId: string) => hoshiFile(`history/${sessionId}.json`)

interface HistoryFile {
  messages?: ModelMessage[]
}

/** Context that arrived while a turn was running, waiting for it to end.
 *
 *  A running turn holds the conversation in memory and writes the whole thing
 *  back when it settles, so appending to the file underneath it would be
 *  overwritten and silently lost. Waiting is honest: the model reads history at
 *  the start of a turn anyway, so context added mid-turn could not have reached
 *  the turn already in flight. */
const pendingContext = new Map<string, string[]>()

/** Add something to what the model knows, without asking it anything.
 *
 *  The one thing `sendMessage` cannot do: every message starts a turn, and some
 *  things the model should know are not questions — a button pressed in a
 *  generative-UI card, an outcome the user chose. Those want to be in view the
 *  next time the model thinks, not to provoke a whole reply on their own.
 *
 *  Deliberately NOT written to the transcript (engine/messages.ts): this is
 *  what the model knows, not what the person said, and rendering it as a chat
 *  bubble would put words in the user's mouth. */
export async function addContext(sessionId: string, text: string): Promise<{ deferred: boolean }> {
  if (isTurnRunning(sessionId)) {
    pendingContext.set(sessionId, [...(pendingContext.get(sessionId) ?? []), text])
    return { deferred: true }
  }
  await write(sessionId, [text])
  return { deferred: false }
}

async function write(sessionId: string, texts: string[]): Promise<void> {
  const messages = (await historyStore.load(sessionId)) ?? []
  await historyStore.save(sessionId, [...messages, ...texts.map((text) => ({ role: 'user' as const, content: text }))])
}

/** Flush whatever was held back, now that the turn is over. Called by
 *  engine/turns.ts as it settles — before the next turn can start, so nothing
 *  can read a history that is about to grow. */
export async function flushPendingContext(sessionId: string): Promise<void> {
  const held = pendingContext.get(sessionId)
  if (!held?.length) return
  await write(sessionId, held)
  const current = pendingContext.get(sessionId)
  if (current === held) pendingContext.delete(sessionId)
  else if (current) pendingContext.set(sessionId, current.slice(held.length))
}

export const historyStore: SessionStore = {
  async load(sessionId: string): Promise<ModelMessage[] | undefined> {
    const data = await readHoshiJson<HistoryFile>(FILE(sessionId))
    return Array.isArray(data?.messages) ? data.messages : undefined
  },

  async save(sessionId: string, messages: ModelMessage[]): Promise<void> {
    await writeHoshiJson(FILE(sessionId), { messages })
  },

  async delete(sessionId: string): Promise<void> {
    /**
     *
     * Emptied rather than unlinked, same as deleteMessages: the store's own
     * write path is the only thing that touches these files, and a missing file
     * and an empty one read back identically.
     *
     **/
    await writeHoshiJson(FILE(sessionId), { messages: [] })
    pendingContext.delete(sessionId)
  },
}

/** The same conversation with every picture replaced by a sentence saying one
 *  was there.
 *
 *  For a model that cannot be handed images. The provider does not reject the
 *  offending message, it rejects the REQUEST — so one picture anywhere in the
 *  history makes every remaining turn in that session fail, and the user's only
 *  way out is to abandon the conversation. Reading it without the pictures is
 *  the difference between a session that works and one that is over.
 *
 *  Load-side only: `save` is the untouched store, so switching back to a model
 *  that CAN see is not a one-way door — the pictures are still there. */
export const imagelessHistory: SessionStore = {
  ...historyStore,

  /**
   *
   * Put the pictures BACK before persisting.
   *
   * Inheriting `save` was wrong, and wrong in the way that matters: the library
   * loads the conversation, appends to it, and saves the whole thing — so a
   * stripped load followed by any save burned the placeholders into the stored
   * history permanently. Switching to a text-only model once made every later
   * model blind, including ones that can see perfectly well, and the symptom was
   * a vision model insisting it cannot look at pictures.
   *
   * Restored by position: a message the stripped view replaced is written back
   * as the original. Anything the turn appended is new and passes through
   * untouched.
   *
   **/
  async save(sessionId: string, messages: ModelMessage[]): Promise<void> {
    const original = (await historyStore.load(sessionId)) ?? []
    await historyStore.save(
      sessionId,
      messages.map((message, index) => {
        const was = original[index]
        if (!was || !Array.isArray(was.content)) return message
        return was.content.some((part) => part.type === 'image') ? was : message
      }),
    )
  },
  async load(sessionId: string): Promise<ModelMessage[] | undefined> {
    const messages = await historyStore.load(sessionId)
    if (!messages) return messages
    return messages.map((message) => {
      if (!Array.isArray(message.content)) return message
      if (!message.content.some((part) => part.type === 'image')) return message
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === 'image'
            ? {
                type: 'text' as const,
                text: '<image>An image the user attached. This model cannot read images.</image>',
              }
            : part,
        ),
      } as ModelMessage
    })
  },
}
