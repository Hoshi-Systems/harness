import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionStore, SubagentSessionMetadata, SubagentSessionMetadataStore } from '@openharness/core'
import type { ModelMessage } from 'ai'
import { historyStore } from './history.js'
import { createSession, getSession, listSessions, setSessionAgent, touchSession } from './sessions.js'
import { writeMessages, type Message } from './messages.js'

/**
 * ── A delegated specialist's work is a session ───────────────────────────────
 *
 * It was not. The library ran a subagent entirely in memory: its own
 * conversation, its own loop, and nothing written anywhere. When the turn ended
 * the only surviving account of what the specialist did was the summary it
 * reported back to its parent — a description of the work rather than the work.
 * Nobody could open it, re-read it, or check the report against what actually
 * happened.
 *
 * The library has the seam for this (`subagentSessions`); the machine simply was
 * not filling it in. Handing it a store makes the child's conversation durable,
 * and this store also registers the session the first time it hears the id — so
 * the delegation shows up as a real session, marked with its parent, in the same
 * list as everything else.
 *
 * The id comes FROM the library. It names the child session before we hear about
 * it, and the id in its conversation store is the session — minting our own
 * would leave the record and the transcript describing different things.
 *
 **/

/**
 * The session a delegation belongs under, carried through the turn.
 *
 * `AsyncLocalStorage`, not a module variable, for two reasons that are both
 * correctness rather than taste:
 *
 *   - The store is read LATE. A plain set-and-restore around `harness.send()`
 *     would be undone the instant that call returns its async iterable, long
 *     before the stream is consumed and any child saves anything — so every
 *     child would come out parentless.
 *   - Turns run CONCURRENTLY. One machine can have several sessions generating
 *     at once, and a single shared variable would attribute a child to whichever
 *     turn happened to write it last.
 */
const parentStore = new AsyncLocalStorage<{ sessionId: string; directory: string }>()

export function withParentSession<T>(parent: { sessionId: string; directory: string }, run: () => T): T {
  return parentStore.run(parent, run)
}

/** The conversation store the library uses for delegated specialists.
 *
 *  Registration rides on `save` rather than on `load`: load runs for a session
 *  that may not exist yet and must stay a read, while a save is the moment the
 *  child has actually said something worth keeping. The metadata store below
 *  usually gets there first (it runs before the child does, and knows which
 *  specialist it is); this stays the backstop for a child that saves without
 *  one. */
export const subagentHistory: SessionStore = {
  load(sessionId: string): Promise<ModelMessage[] | undefined> {
    return historyStore.load(sessionId)
  },

  async save(sessionId: string, messages: ModelMessage[]): Promise<void> {
    await ensureSession(sessionId)
    await historyStore.save(sessionId, messages)
    await writeTranscript(sessionId, messages)
  },

  delete(sessionId: string): Promise<void> {
    return historyStore.delete?.(sessionId) ?? Promise.resolve()
  },
}

/** Register the child session once, under the parent that spawned it. */
async function ensureSession(sessionId: string, agent?: string): Promise<void> {
  const existing = await getSession(sessionId)
  if (existing) {
    if (agent && !existing.agent) await setSessionAgent(sessionId, agent)
    return
  }
  const parent = parentStore.getStore()
  if (!parent) return
  await createSession(parent.directory, {
    id: sessionId,
    parentId: parent.sessionId,
    ...(agent ? { agent } : {}),
  })
}

/**
 * ── Which specialist a child session belongs to ──────────────────────────────
 *
 * The library keeps a small record per resumable subagent session — its id, the
 * specialist that owns it, when it was made and last used — and consults it
 * before `session.mode="resume"` or `"fork"` will touch anything. Handing it no
 * store is allowed, and what it does then is keep one IN MEMORY, keyed off the
 * identity of the config object it was handed.
 *
 * Both halves of that were fatal here. The machine built a fresh config literal
 * on every turn, so every turn got a fresh empty record set; and even one object
 * would have lost the lot on restart. The visible behaviour was that `new` (which
 * writes a record and never reads one) worked, and `resume` and `fork` failed
 * with `Unknown subagent session "…"` for every session that was not created by
 * the very same turn — which is to say, for every session anybody would want to
 * resume.
 *
 * Nothing here is new state. A delegated specialist's session is ALREADY a
 * session on this machine (that is what the store above is for), and this is the
 * same three facts read back off it. Which is the point: a subagent session the
 * user deleted must stop being resumable, and two stores would have to be kept
 * in step for that to be true.
 *
 **/
const metadataStore: SubagentSessionMetadataStore = {
  async load(sessionId: string): Promise<SubagentSessionMetadata | undefined> {
    const session = await getSession(sessionId)
    /**
     *
     * A session with no specialist on it is not a subagent session — a person's
     * own conversation must not be resumable AS one, which would let a `task`
     * call continue a thread the user is talking in.
     *
     **/
    if (!session?.agent) return undefined
    return {
      sessionId: session.id,
      agentName: session.agent,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  },

  async save(metadata: SubagentSessionMetadata): Promise<void> {
    /**
     *
     * Called by the library BEFORE the child runs — which is the only moment
     * the specialist's name is known here, so this is where the session is
     * created rather than in `save` on the conversation store below.
     *
     **/
    await ensureSession(metadata.sessionId, metadata.agentName)
    await touchSession(metadata.sessionId)
  },

  async delete(sessionId: string): Promise<void> {
    /**
     *
     * Deliberately not a session delete. The record and the session are the
     * same row, and forgetting that a specialist may be resumed is not a reason
     * to destroy its transcript — which is the whole reason a delegated
     * specialist gets a session at all.
     *
     **/
    await setSessionAgent(sessionId, null)
  },

  async list(filter?: { agentName?: string }): Promise<SubagentSessionMetadata[]> {
    return (await listSessions())
      .filter((session) => session.agent && (!filter?.agentName || session.agent === filter.agentName))
      .map((session) => ({
        sessionId: session.id,
        agentName: session.agent!,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }))
  },
}

/** What a turn hands the library for its delegated specialists.
 *
 *  ONE object for the whole machine, and that is load-bearing rather than
 *  tidiness: the library stores a subagent session's bookkeeping in a WeakMap
 *  keyed by this exact object. A literal built per turn — which is what this
 *  was — is a different key every time, so every turn started from an empty
 *  record set and nothing survived the turn that made it.
 *
 *  `new` rather than `stateless` as the default because a stateless child has
 *  nothing to keep; the agent can still ask for `stateless` per call, and now
 *  `resume` and `fork` mean something. */
export const subagentSessions = {
  messages: subagentHistory,
  metadata: metadataStore,
  defaultMode: 'new' as const,
}

/**
 * ── The child's transcript ───────────────────────────────────────────────────
 *
 * Derived from its own conversation rather than from the event stream, because
 * the stream cannot be attributed: the library reports a subagent's events with
 * a path of agent NAMES, and two specialists of the same archetype are then
 * indistinguishable. The conversation arrives keyed by session id, which is the
 * one thing that identifies the child unambiguously.
 *
 * Rewritten whole on each save. The child's conversation is short by
 * construction — one brief, its work, its report — and a diffing writer here
 * would be machinery guarding a cost nobody is paying.
 *
 **/
async function writeTranscript(sessionId: string, conversation: ModelMessage[]): Promise<void> {
  const now = new Date().toISOString()
  const messages = conversation
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message, index) => ({
      id: `msg_${sessionId}_${index}`,
      role: message.role as 'user' | 'assistant',
      parts: partsOf(message.content),
      createdAt: now,
      /**
       *
       * Stamped complete: every message here is one the child already finished.
       * Leaving it open would render the specialist's thread as permanently
       * mid-thought.
       *
       **/
      completedAt: now,
    }))
    .filter((message) => message.parts.length > 0)

  await writeMessages(sessionId, messages)
}

/** A model message's content in the shape a transcript stores. Tool calls and
 *  their results are kept — "what the specialist actually did" is the reason to
 *  open its thread at all. */
function partsOf(content: ModelMessage['content']): Message['parts'] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Message['parts'] = []
  for (const part of content) {
    if (part.type === 'text' && part.text.trim()) parts.push({ type: 'text', text: part.text })
    else if (part.type === 'reasoning' && part.text.trim()) parts.push({ type: 'reasoning', text: part.text })
    else if (part.type === 'tool-call') {
      parts.push({
        type: 'tool',
        name: part.toolName,
        callId: part.toolCallId,
        state: { status: 'completed', input: part.input },
      })
    }
  }
  return parts
}
