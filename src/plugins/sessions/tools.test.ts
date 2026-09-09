import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Tool } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ── Who owns a session's name ────────────────────────────────────────────────
 *
 * Three writers want this one field, and the whole design is the order between
 * them: the user outranks the agent, the agent outranks the machine's own
 * titler, and clearing hands it all the way back.
 *
 * Worth a test rather than a comment because every way of getting it wrong is
 * SILENT. An agent that could overwrite a user's rename leaves no error behind,
 * only a session that keeps losing the name somebody gave it; a titler that
 * did not stand down for the agent produces a title that flickers between two
 * plausible ones a few turns apart. Neither throws, and neither is visible from
 * inside a single turn.
 *
 * Driven through the TOOL rather than the store, because the tool is what the
 * model can reach and the refusal it returns is itself part of the contract —
 * a call that reported success over a write that did not happen would teach
 * the model that the title it chose is the one on screen.
 *
 **/

let home = ''
let previousHome: string | undefined

beforeAll(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(path.join(tmpdir(), 'hoshi-session-tools-'))
  process.env.HOME = home
  /**
   *
   * Pay for the kernel's module graph HERE, where the hook's budget covers it,
   * rather than inside the first assertion that happens to name it.
   *
   * Every case below imports these lazily — it has to, because the kernel reads
   * HOME at import time and the line above is what makes that the scratch one —
   * so the FIRST case was carrying the whole graph and the other nine hit a
   * warm cache. Unloaded that is 80ms nobody notices. While `pnpm verify` runs
   * the workspaces at once it is seconds, and the failure was always the same
   * one test, which reads as that test being broken rather than as a cost being
   * charged to whoever went first (the same skew apps/api/vitest.config.ts
   * describes, and fixes the same way).
   *
   **/
  await import('../../kernel/index.js')
  await import('./tools.js')
})

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

interface ToolAnswer {
  title: string
  output: string
  metadata: Record<string, unknown>
}

/** Call a bound tool the way the engine does. */
async function call(tool: Tool, input: unknown): Promise<ToolAnswer> {
  const execute = tool.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<ToolAnswer>
  return execute(input, {})
}

async function boundTo(sessionId: string): Promise<Record<string, Tool>> {
  const { sessionTools } = await import('./tools.js')
  return sessionTools({ sessionId, directory: home, agent: 'hoshi', eventNamespace: 'sessions' })
}

describe('session_update', () => {
  it('names the session, and says so in the words the model reads', async () => {
    const { createSession, getSession } = await import('../../kernel/index.js')
    const session = await createSession(home)
    const answer = await call((await boundTo(session.id)).session_update!, { title: 'Billing webhook migration' })

    expect(answer.metadata.ok).toBe(true)
    expect((await getSession(session.id))?.title).toBe('Billing webhook migration')
  })

  it('stands the machine’s own titler down for that session', async () => {
    /**
     *
     * The whole point of the flag. `titleOwner` is what kernel/session-titles.ts
     * reads before it spends a model call, so `agent` here IS "the generation
     * will not run", expressed where a test can see it.
     *
     **/
    const { createSession, titleOwner } = await import('../../kernel/index.js')
    const session = await createSession(home)
    expect(await titleOwner(session.id)).toBe('machine')

    await call((await boundTo(session.id)).session_update!, { title: 'Something the agent chose' })
    expect(await titleOwner(session.id)).toBe('agent')
  })

  it('renames again when the subject moves, without a second writer appearing', async () => {
    const { createSession, getSession, titleOwner } = await import('../../kernel/index.js')
    const session = await createSession(home)
    const tools = await boundTo(session.id)

    await call(tools.session_update!, { title: 'First subject' })
    await call(tools.session_update!, { title: 'Second subject' })

    expect((await getSession(session.id))?.title).toBe('Second subject')
    expect(await titleOwner(session.id)).toBe('agent')
  })

  it('refuses a session the user named, and TELLS the model it refused', async () => {
    const { createSession, markManualTitle, renameSession, getSession } = await import('../../kernel/index.js')
    const session = await createSession(home)
    await renameSession(session.id, 'The name I gave it')
    await markManualTitle(session.id)

    const answer = await call((await boundTo(session.id)).session_update!, { title: 'The name the agent prefers' })

    expect(answer.metadata.ok).toBe(false)
    expect(answer.metadata.reason).toBe('named-by-user')
    expect(answer.output).toContain('The name I gave it')
    expect((await getSession(session.id))?.title).toBe('The name I gave it')
  })

  it('hands the name back when it is cleared, so the titler resumes', async () => {
    const { createSession, getSession, titleOwner } = await import('../../kernel/index.js')
    const session = await createSession(home)
    const tools = await boundTo(session.id)

    await call(tools.session_update!, { title: 'A name' })
    await call(tools.session_update!, { title: null })

    expect((await getSession(session.id))?.title).toBeNull()
    expect(await titleOwner(session.id)).toBe('machine')
  })

  it('treats a blank title as clearing it, rather than storing whitespace', async () => {
    const { createSession, getSession } = await import('../../kernel/index.js')
    const session = await createSession(home)
    const tools = await boundTo(session.id)

    await call(tools.session_update!, { title: 'A name' })
    await call(tools.session_update!, { title: '   ' })
    expect((await getSession(session.id))?.title).toBeNull()
  })

  it('only ever touches its own session', async () => {
    /**
     *
     * There is no id argument, and that is the security model: the session comes
     * from the turn's own tool context, so one conversation cannot rename
     * another however the model phrases the call.
     *
     **/
    const { createSession, getSession } = await import('../../kernel/index.js')
    const mine = await createSession(home)
    const theirs = await createSession(home)
    await renameOther(theirs.id, 'Untouched')

    await call((await boundTo(mine.id)).session_update!, { title: 'Mine' })

    expect((await getSession(mine.id))?.title).toBe('Mine')
    expect((await getSession(theirs.id))?.title).toBe('Untouched')
  })
})

async function renameOther(sessionId: string, title: string): Promise<void> {
  const { renameSession } = await import('../../kernel/index.js')
  await renameSession(sessionId, title)
}

describe('session_info', () => {
  it('reports the session the turn is actually running in', async () => {
    const { createSession } = await import('../../kernel/index.js')
    const parent = await createSession(home)
    const session = await createSession(home, { parentId: parent.id })

    const answer = await call((await boundTo(session.id)).session_info!, {})

    expect(answer.metadata).toMatchObject({
      ok: true,
      id: session.id,
      directory: home,
      chat: false,
      parentId: parent.id,
      titleOwner: 'machine',
    })
  })

  it('says who named the session, so the agent knows whether to leave it alone', async () => {
    const { createSession, markManualTitle, renameSession } = await import('../../kernel/index.js')
    const session = await createSession(home)
    await renameSession(session.id, 'Theirs')
    await markManualTitle(session.id)

    const answer = await call((await boundTo(session.id)).session_info!, {})
    expect(answer.metadata.titleOwner).toBe('user')
    expect(answer.output).toContain('named by the user')
  })

  it('does not report a cost of zero as a fact when a turn ran unpriced', async () => {
    /**
     *
     * Unpriced is not free — the same claim every client makes, made here too,
     * because "$0.00" is what tells a self-hosted owner their machine costs
     * nothing to run.
     *
     **/
    const { createSession, recordTurnSpend } = await import('../../kernel/index.js')
    const session = await createSession(home)
    await recordTurnSpend({
      sessionId: session.id,
      messageId: 'msg_unpriced',
      model: 'nowhere/a-model-nobody-published-a-price-for',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: null,
    })

    const answer = await call((await boundTo(session.id)).session_info!, {})
    expect(answer.output).toContain('no published price')
  })
})
