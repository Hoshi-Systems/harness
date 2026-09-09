import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'

/**
 * ── Launching a specialist: stateless, new, resume, fork ─────────────────────
 *
 * The library's `task` tool takes a `session` argument with four modes.
 * `stateless` runs a child that keeps nothing; `new` gives it a session of its
 * own; `resume` continues one; `fork` clones one. Which specialist a session
 * belongs to is bookkeeping the library will not do for itself — it asks for a
 * metadata store, and consults it before `resume` or `fork` may touch anything.
 *
 * The machine handed it none. What the library does then is keep one IN MEMORY,
 * keyed off the IDENTITY of the config object it was given — and the machine
 * built a fresh config literal on every single turn. So each turn began with an
 * empty set of records: `new` (which writes a record and never reads one)
 * appeared to work, and `resume` and `fork` failed with `Unknown subagent
 * session "…"` for any session not created by the very same turn. Which is to
 * say: for every session anybody would ever want to resume. A restart lost the
 * lot regardless.
 *
 * What is pinned here is the store that replaced it — and the fact that it is
 * not a second copy of anything. A delegated specialist's session is ALREADY a
 * session on this machine, so these are the same three facts read back off it,
 * which is what makes "the user deleted it, so it is not resumable any more"
 * true without anybody maintaining it.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-subagent-modes-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const { subagentSessions, withParentSession } = await import('./subagent-sessions.js')
const { createSession, deleteSession, getSession } = await import('./sessions.js')

const metadata = subagentSessions.metadata

let counter = 0
const nextId = () => `ses_child_${++counter}`

function say(text: string): ModelMessage {
  return { role: 'assistant', content: text } as ModelMessage
}

/** One turn's worth of delegation: the library names the child, records whose
 *  it is, and only then does the child say anything. */
async function delegate(parentId: string, directory: string, agentName: string, id = nextId()): Promise<string> {
  await withParentSession({ sessionId: parentId, directory }, async () => {
    await metadata.save({
      sessionId: id,
      agentName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await subagentSessions.messages.save(id, [say('On it.')])
  })
  return id
}

describe('a resumable specialist session', () => {
  it('is recorded before the child has said anything, under the turn that spawned it', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = nextId()

    /**
     *
     * The library saves the record BEFORE it runs the child — which is the only
     * moment the specialist's name is known — so the session has to come into
     * existence here rather than on the first thing the child writes.
     *
     **/
    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      metadata.save({
        sessionId: child,
        agentName: 'reviewer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    )

    const session = await getSession(child)
    expect(session?.parentId).toBe(parent.id)
    expect(session?.agent).toBe('reviewer')
    expect(await metadata.load(child)).toMatchObject({ sessionId: child, agentName: 'reviewer' })
  })

  it('is still resumable on a LATER turn — which is the whole point of resuming', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = await delegate(parent.id, parent.directory, 'implementer')

    /**
     *
     * A second turn, with nothing carried over in memory from the first. This
     * is the case that never worked: the record lived in a map keyed by the
     * config object of the turn that made it, so the next turn — and every
     * turn after a restart — looked it up in an empty one and `resume` failed.
     *
     **/
    const seenFromAnotherTurn = await metadata.load(child)
    expect(seenFromAnotherTurn).toMatchObject({ sessionId: child, agentName: 'implementer' })
    expect(await subagentSessions.messages.load(child)).toHaveLength(1)
  })

  it('refuses to be resumed as a specialist it does not belong to', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = await delegate(parent.id, parent.directory, 'reviewer')

    /**
     *
     * The library compares the name itself and refuses the mismatch; what has
     * to be true here is that the name it reads back is the one recorded, so
     * an implementer cannot be handed a reviewer's conversation.
     *
     **/
    expect((await metadata.load(child))?.agentName).toBe('reviewer')
  })

  it('is not a person’s own conversation', async () => {
    const mine = await createSession('/workspace/acme/site')

    /**
     *
     * Every session on the machine would otherwise answer to `resume`, and a
     * `task` call could continue the thread its user is typing in.
     *
     **/
    expect(await metadata.load(mine.id)).toBeUndefined()
  })

  it('stops being resumable when the session it IS goes away', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = await delegate(parent.id, parent.directory, 'reviewer')

    expect(await deleteSession(parent.id)).toBe(true)

    /**
     *
     * The record and the session are one row, so this is true for free. Two
     * stores would have had to be kept in step for it, and the one that was
     * there could not be: it had no idea sessions could be deleted.
     *
     **/
    expect(await metadata.load(child)).toBeUndefined()
  })

  it('lists a specialist’s own sessions, and only those', async () => {
    const parent = await createSession('/workspace/acme/site')
    const first = await delegate(parent.id, parent.directory, 'scribe')
    const second = await delegate(parent.id, parent.directory, 'scribe')
    await delegate(parent.id, parent.directory, 'architect')
    await createSession('/workspace/acme/site')

    const scribes = (await metadata.list?.({ agentName: 'scribe' })) ?? []
    expect(scribes.map((entry) => entry.sessionId).sort()).toEqual([first, second].sort())
    expect(scribes.every((entry) => entry.agentName === 'scribe')).toBe(true)
  })

  it('can be forgotten without destroying the specialist’s work', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = await delegate(parent.id, parent.directory, 'reviewer')

    await metadata.delete?.(child)

    expect(await metadata.load(child)).toBeUndefined()
    /**
     *
     * Not resumable any more, still readable. A delegated specialist gets a
     * session so its work is a thing that EXISTS; deleting the transcript to
     * express "do not continue this" would throw away the only account of what
     * it did.
     *
     **/
    expect(await getSession(child)).not.toBeNull()
    expect(await subagentSessions.messages.load(child)).toHaveLength(1)
  })
})

describe('what a turn hands the library', () => {
  it('defaults to giving a specialist a session rather than running it in RAM', () => {
    expect(subagentSessions.defaultMode).toBe('new')
  })

  it('is ONE object, because the library keys a subagent’s bookkeeping by its identity', async () => {
    const again = await import('./subagent-sessions.js')

    /**
     *
     * Not tidiness. `subagentSessions` used to be an object literal built
     * inside the turn, and the library stores that turn's subagent session
     * state in a WeakMap under it — so a new literal per turn meant a new,
     * empty state per turn, and nothing a turn recorded outlived it.
     *
     **/
    expect(again.subagentSessions).toBe(subagentSessions)
  })
})
