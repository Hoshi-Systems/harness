import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'
import { historyStore } from './history.js'
import { deleteMessages } from './messages.js'
import { publishMachineEvent } from './events.js'
import { WORKSPACE_ROOT } from './workspace.js'
import type { SessionProgress } from '../wire/index.js'

/**
 * ── Sessions ─────────────────────────────────────────────────────────────────
 *
 * The first piece of the machine's own agent runtime (docs/HARNESS_MIGRATION.md).
 * A session is a durable RECORD — who is talking, where the work happens, what
 * it is called — and deliberately knows nothing about generating. Turns are
 * built on top of this; the only reason the harness is anywhere near this file
 * is that deleting a session has to delete the model's memory of it too.
 *
 * Two properties are load-bearing and were the previous runtime's two worst
 * bugs, so they are structural here rather than guarded:
 *
 *  1. A session CARRIES its directory. It is data on the record, never a
 *     parameter a caller has to remember to pass in order to be told the truth.
 *     Every read below is machine-wide by construction, so there is no narrower
 *     question to ask by accident (docs/APP_REVIEW.md F1).
 *  2. Sessions are DURABLE. A machine restarts for ordinary reasons — a deploy,
 *     an image update, an OOM — and the user's work has to still be there. The
 *     store is a file under ~/.hoshi (the /data volume on a real machine), not
 *     process memory.
 *
 **/

export type SessionState = 'idle' | 'busy' | 'retrying'

export interface Session {
  id: string
  /** Where this session's work happens: the workspace root (the personal space)
   *  or a project checkout beneath it. */
  directory: string
  title: string | null
  createdAt: string
  updatedAt: string
  /** The session this one was spawned from, when it was.
   *
   *  A delegated specialist runs in its own session so its work is a thing that
   *  EXISTS — openable, readable, still there tomorrow. Without this the whole
   *  delegation left no trace but the summary it reported back, so the only
   *  account of what a specialist did was its own description of it. */
  parentId?: string | null
  /** The specialist this session was delegated to, when it was one.
   *
   *  Set by the delegation path (kernel/subagent-sessions.ts) at the moment the
   *  library names the child, which is before the child has said anything. It
   *  is what makes a subagent session RESUMABLE: `task { session: { mode:
   *  "resume", id } }` has to know that this id is a specialist's thread and
   *  whose, and answering that from the session row means a session the user
   *  deleted stops being resumable for free.
   *
   *  Absent on a person's own conversation, deliberately — otherwise a `task`
   *  call could resume the thread its user is typing in. */
  agent?: string | null
  /** A chat: a session that stays a leaf.
   *
   *  A session is a list of turns. A TASK is a tree of them — a root plus every
   *  session it spawned — which is why a task's cost and progress are sums
   *  rather than fields on a row. A chat is one session with no tree under it:
   *  it delegates nothing, so it never becomes the root of a task, and it runs
   *  read-only, so it never needs a permission or the Computer.
   *
   *  A boolean rather than a `kind`, because `kind: 'task'` would name on a row
   *  something that lives above it. This says the one thing that is true of the
   *  row: this session stays a leaf.
   *
   *  It has to exist because structure alone cannot tell: a chat and a
   *  brand-new task are both one session with no children yet, and no surface
   *  can sort its own list until something says which is which. */
  chat?: boolean
}

interface SessionFile {
  sessions?: Session[]
}

const STORE = () => hoshiFile('sessions.json')

/** Serializes read-modify-write. Nitro handles one request at a time per tick,
 *  but every mutation below awaits a file read before writing — two concurrent
 *  creates would otherwise interleave and the second would persist a snapshot
 *  taken before the first, silently dropping a session. */
let writeQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(operation, operation)
  /**
   *
   * Keep the chain alive after a rejection: the failed op's error still reaches
   * its own caller, but a rejected `writeQueue` would poison every later write.
   *
   **/
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function readAll(): Promise<Session[]> {
  const data = await readHoshiJson<SessionFile>(STORE())
  return Array.isArray(data?.sessions) ? data.sessions : []
}

async function writeAll(sessions: Session[]): Promise<void> {
  await writeHoshiJson(STORE(), { sessions })
}

/** Thrown for a directory that is missing, or outside the workspace. Routes map
 *  it to a 400 — it is a bad request, not a machine fault. */
export class InvalidDirectoryError extends Error {}

/** Resolve the directory a session will work in. Absent means the personal
 *  space, so a client with no project context (the composer on first open)
 *  still gets a usable session.
 *
 *  Anything outside the workspace root is refused. A session is a handle the
 *  agent will later read and write files through, so "any absolute path"
 *  would make it a way to address the whole container. */
export async function resolveSessionDirectory(input: unknown): Promise<string> {
  if (input === undefined || input === null || input === '') {
    /**
     *
     * The personal space, checked like any other. It used to be the one path
     * that was NOT: an absent directory returned the root unverified, so a
     * machine whose workspace root was missing accepted every session and then
     * failed later, inside a turn, in a way that read like a broken agent.
     *
     **/
    const stats = await stat(WORKSPACE_ROOT).catch(() => null)
    if (!stats?.isDirectory()) throw new InvalidDirectoryError('this machine has no workspace directory yet.')
    return WORKSPACE_ROOT
  }
  if (typeof input !== 'string') throw new InvalidDirectoryError('directory must be a string.')

  const resolved = path.resolve(input)
  const root = path.resolve(WORKSPACE_ROOT)
  const relative = path.relative(root, resolved)
  const inside = resolved === root || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!inside) throw new InvalidDirectoryError('directory must be the workspace root or a project inside it.')

  const stats = await stat(resolved).catch(() => null)
  if (!stats?.isDirectory()) throw new InvalidDirectoryError('that directory does not exist on this machine.')
  return resolved
}

export class ChatCannotHaveParentError extends Error {}

export async function createSession(
  directory: string,
  options: { id?: string; parentId?: string; title?: string; chat?: boolean; agent?: string } = {},
): Promise<Session> {
  /**
   *
   * Guarded here rather than at the route because it is a property of the
   * RECORD, and both creators reach this function: the route a person's client
   * calls, and the delegation path that mints a specialist's session. Neither
   * asks for both today — the route accepts no `parentId` and the delegation
   * path asks for no `chat` — which is exactly why this is worth writing down
   * now rather than after a third caller has to work it out.
   *
   **/
  if (options.parentId && options.chat) {
    throw new ChatCannotHaveParentError('a chat has no parent — that is what makes it a chat.')
  }
  return serialize(async () => {
    const now = new Date().toISOString()
    const session: Session = {
      /**
       *
       * The id is accepted rather than always minted because a delegated
       * specialist's session is named by the engine's library before we hear
       * about it — the id in its conversation store IS the session, and minting
       * a second one here would leave the transcript and the record pointing at
       * different things.
       *
       **/
      id: options.id ?? `ses_${randomUUID().replace(/-/g, '')}`,
      directory,
      title: options.title ?? null,
      createdAt: now,
      updatedAt: now,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.chat ? { chat: true } : {}),
    }
    await writeAll([...(await readAll()), session])
    publishMachineEvent('session.created', { session })
    return session
  })
}

/** Every session on the machine. Machine-wide is the ONLY listing there is. */
export async function listSessions(): Promise<Session[]> {
  return readAll()
}

export async function getSession(id: string): Promise<Session | null> {
  return (await readAll()).find((session) => session.id === id) ?? null
}

export async function renameSession(id: string, title: string | null): Promise<Session | null> {
  return serialize(async () => {
    const sessions = await readAll()
    const session = sessions.find((entry) => entry.id === id)
    if (!session) return null
    session.title = title
    session.updatedAt = new Date().toISOString()
    await writeAll(sessions)
    publishMachineEvent('session.updated', { session })
    return session
  })
}

/** Say which specialist a session belongs to, or forget it (`null`).
 *
 *  Separate from `createSession` because the delegation path can arrive at
 *  either end: usually the library names the child before it exists here, but a
 *  child that saved its conversation first is already a row by the time we hear
 *  the specialist's name. */
export async function setSessionAgent(id: string, agent: string | null): Promise<void> {
  await serialize(async () => {
    const sessions = await readAll()
    const session = sessions.find((entry) => entry.id === id)
    if (!session) return
    if (agent) session.agent = agent
    else delete session.agent
    await writeAll(sessions)
    publishMachineEvent('session.updated', { session })
  })
}

/** Mark a session as having just been used. Called when a message is sent.
 *
 *  `updatedAt` used to move only on a rename, which made it a record of when
 *  somebody last renamed the session and nothing else — so a session you had
 *  been talking to all morning sorted below one you had named and abandoned,
 *  and anything asking "what changed since?" was told nothing had. */
export async function touchSession(id: string): Promise<void> {
  await serialize(async () => {
    const sessions = await readAll()
    const session = sessions.find((entry) => entry.id === id)
    if (!session) return
    session.updatedAt = new Date().toISOString()
    await writeAll(sessions)
    publishMachineEvent('session.updated', { session })
  })
}

/** Every session below `id`, deepest last — the delegated work that only exists
 *  because this conversation asked for it.
 *
 *  The `seen` set is a cycle guard on data that should never contain one; it
 *  costs nothing and the alternative is a delete that never returns. */
function descendantsOf(sessions: Session[], id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let frontier = [id]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const parent of frontier) {
      for (const session of sessions) {
        if (session.parentId !== parent || seen.has(session.id)) continue
        seen.add(session.id)
        out.push(session.id)
        next.push(session.id)
      }
    }
    frontier = next
  }
  return out
}

/** Delete a session AND the sub-agent sessions it spawned.
 *
 *  The subtree, because a delegated specialist's session is not a conversation
 *  in its own right — it exists to hold the work one turn of the parent asked
 *  for (kernel/subagent-sessions.ts), and the only place a client can render it
 *  is nested under that parent. Deleting the parent alone left the child
 *  pointing at a session that no longer exists: it is not a root, so no list
 *  shows it, and its parent is gone, so nothing nests it — invisible on every
 *  surface, with its transcript and its model history still on disk. A machine
 *  that delegates and whose conversations get tidied up accumulates those
 *  forever, and nothing on the wire can reach them to clean up.
 *
 *  Every removed session is announced separately: a client holds them as
 *  individual rows and drops each on its own `session.deleted`. */
export async function deleteSession(id: string): Promise<boolean> {
  return serialize(async () => {
    const sessions = await readAll()
    if (!sessions.some((session) => session.id === id)) return false
    const doomed = [id, ...descendantsOf(sessions, id)]
    const gone = new Set(doomed)
    await writeAll(sessions.filter((session) => !gone.has(session.id)))
    /**
     *
     * The transcript people read and the conversation the model remembers are
     * two stores (engine/messages.ts, engine/history.ts). Deleting a session
     * has to clear both, or a session deleted from the list leaves its history
     * behind on disk for nobody.
     *
     **/
    await Promise.all(doomed.flatMap((sessionId) => [deleteMessages(sessionId), historyStore.delete!(sessionId)]))
    for (const sessionId of doomed) publishMachineEvent('session.deleted', { sessionId })
    return true
  })
}

/**
 * ── Status ───────────────────────────────────────────────────────────────────
 *
 * What each session is doing RIGHT NOW. In memory on purpose: it describes this
 * process's live work and must never outlive a restart — a "busy" flag restored
 * from disk would describe a turn that died with the previous process, and the
 * config queue would park writes forever waiting for it to finish.
 *
 * Every known session appears, idle included. A map that only listed generating
 * sessions could not answer "is this machine busy?", which is the question the
 * whole save-parking mechanism rests on.
 *
 **/

const liveStates = new Map<string, SessionState>()

export function setSessionState(id: string, state: SessionState): void {
  if (state === 'idle') liveStates.delete(id)
  else liveStates.set(id, state)
  publishMachineEvent('session.status', { sessionId: id, state })
}

export async function sessionStatuses(): Promise<Record<string, { state: SessionState }>> {
  const statuses: Record<string, { state: SessionState }> = {}
  for (const session of await readAll()) {
    statuses[session.id] = { state: liveStates.get(session.id) ?? 'idle' }
  }
  return statuses
}

/**
 * ── Progress ─────────────────────────────────────────────────────────────────
 *
 * What a session is doing, as opposed to merely THAT it is doing something.
 *
 * A client cannot work this out for itself. Plan progress lives in a
 * `todowrite` call inside the transcript, and the step in flight is a tool call
 * that has not finished — both readable only by loading a session's messages,
 * which a sidebar listing forty tasks is never going to do. So the one process
 * that already knows says so, on the bus it already publishes to.
 *
 * `directory` rides along because it is the only thing that attributes a
 * session to a PROJECT, and a client watching every session on the machine has
 * no other way to bucket them (it maps directory → checkout itself). Sending it
 * on every progress event keeps the event self-contained: a client that has
 * never loaded this session still learns where it belongs.
 *
 * In memory, like `liveStates` and for the same reason: it describes this
 * process's live work and must not outlive a restart.
 *
 **/
export type { SessionProgress } from '../wire/index.js'

const progress = new Map<string, SessionProgress>()

function publishProgress(id: string, directory: string | null): void {
  const current = progress.get(id) ?? { plan: null, step: null }
  publishMachineEvent('session.progress', {
    sessionId: id,
    directory,
    plan: current.plan,
    step: current.step,
  })
}

/** Record (and announce) what a session is doing. Only the fields given are
 *  changed, so a step can move without disturbing the plan it belongs to. */
export function setSessionProgress(id: string, directory: string | null, patch: Partial<SessionProgress>): void {
  const current = progress.get(id) ?? { plan: null, step: null }
  const next: SessionProgress = { ...current, ...patch }
  if (next.plan === current.plan && next.step === current.step) return
  if (next.plan === null && next.step === null) progress.delete(id)
  else progress.set(id, next)
  publishProgress(id, directory)
}

/** Everything the machine currently knows, for the snapshot a client takes when
 *  it connects — the stream carries the diffs after that. */
export function sessionProgressSnapshot(): Record<string, SessionProgress> {
  return Object.fromEntries(progress)
}

/** A turn ended: the step is over, and a plan every item of which is done stops
 *  being progress. Called from the turn loop rather than inferred from `idle`,
 *  because a session can settle without ever having had a plan. */
export function clearSessionStep(id: string, directory: string | null): void {
  setSessionProgress(id, directory, { step: null })
}
