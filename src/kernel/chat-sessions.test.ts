import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentForSession } from './tools.js'

/**
 * ── A chat is a session that stays a leaf ────────────────────────────────────
 *
 * A session is a list of turns. A TASK is a tree of them — a root plus every
 * session it spawned. A chat is one session with no tree under it, and the two
 * promises that make it one are both expressed as `readOnly` on the agent its
 * turn runs as:
 *
 *   • it changes nothing — `withoutDisabled` strips the mutating set from the
 *     whole tool list, contributed plugin tools included;
 *   • it spawns nothing — turns.ts withholds the library's own `task` tool from
 *     a read-only agent, which is the half a tool filter cannot reach, because
 *     `task` is not one of our tools to filter.
 *
 * Which is why this is the rule worth a test of its own: everything a chat
 * promises rests on it, and it is one expression that would be easy to lose in
 * a refactor of the turn loop.
 *
 **/

const build = { name: 'build', readOnly: false, prompt: '', tools: {} }
const investigate = { name: 'investigate', readOnly: true, prompt: '', tools: {} }

describe('agentForSession', () => {
  it('makes a chat read-only whatever agent was asked for', () => {
    expect(agentForSession(build, { chat: true }).readOnly).toBe(true)
  })

  it('leaves an ordinary session alone — this is the path every task takes', () => {
    expect(agentForSession(build, { chat: false })).toBe(build)
    expect(agentForSession(build, {})).toBe(build)
  })

  it('leaves an agent that was already read-only exactly as it was', () => {
    /**
     *
     * Identity, not equality: an archetype that already promises to change
     * nothing must not be reallocated on its way through here, or a caller
     * comparing definitions across turns starts seeing a change that did not
     * happen.
     *
     **/
    expect(agentForSession(investigate, { chat: true })).toBe(investigate)
  })

  it('does not mutate the definition it was handed', () => {
    const definition = { ...build }
    agentForSession(definition, { chat: true })
    expect(definition.readOnly).toBe(false)
  })

  it('treats a session it could not load as an ordinary one, never as a chat', () => {
    /**
     *
     * The failure this names: `getSession` answers null for a session that was
     * deleted mid-turn. Reading that as "chat" would silently strip a running
     * task's tools; reading it as ordinary leaves the turn exactly as it was
     * when it started, which is the direction that fails visibly.
     *
     **/
    expect(agentForSession(build, null)).toBe(build)
    expect(agentForSession(build, undefined)).toBe(build)
  })

  it('carries every other field across untouched', () => {
    const chatty = agentForSession({ ...build, prompt: 'be brief', tools: { web_read: true } }, { chat: true })
    expect(chatty).toMatchObject({ name: 'build', prompt: 'be brief', tools: { web_read: true }, readOnly: true })
  })
})

/**
 * ── The record ───────────────────────────────────────────────────────────────
 *
 * `hoshiFile` resolves under `process.env.HOME`, so pointing HOME at a scratch
 * directory is what keeps these off the developer's own `~/.hoshi`. The store
 * caches nothing — every read and write goes to disk — so the flag surviving a
 * round trip here is the same property that makes it survive a restart.
 *
 **/
describe('a chat, as a stored session', () => {
  let home = ''
  let previousHome: string | undefined

  beforeAll(async () => {
    previousHome = process.env.HOME
    home = await mkdtemp(path.join(tmpdir(), 'hoshi-chat-'))
    process.env.HOME = home
  })

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('round-trips the flag, so a chat is still a chat after a restart', async () => {
    const { createSession, getSession } = await import('./sessions.js')
    const created = await createSession(home, { chat: true })
    expect(created.chat).toBe(true)
    expect(await getSession(created.id)).toMatchObject({ id: created.id, chat: true })
  })

  it('marks an ordinary session in no way at all', async () => {
    const { createSession } = await import('./sessions.js')
    /**
     *
     * Absent, not `false`. The field is written only when it is true, so every
     * session that existed before this change reads back exactly as it did —
     * which is what makes the migration nothing.
     *
     **/
    expect(await createSession(home)).not.toHaveProperty('chat')
  })

  it('refuses a chat with a parent — a chat has no parent, that is what it means', async () => {
    const { createSession, ChatCannotHaveParentError, listSessions } = await import('./sessions.js')
    const before = (await listSessions()).length
    await expect(createSession(home, { chat: true, parentId: 'ses_parent' })).rejects.toBeInstanceOf(
      ChatCannotHaveParentError,
    )
    expect((await listSessions()).length).toBe(before)
  })

  it('still lets a sub-agent session have a parent', async () => {
    const { createSession } = await import('./sessions.js')
    expect(await createSession(home, { parentId: 'ses_parent' })).toMatchObject({ parentId: 'ses_parent' })
  })
})
