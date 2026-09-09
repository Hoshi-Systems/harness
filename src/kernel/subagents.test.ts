import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel, ModelMessage } from 'ai'
import { archetypeCatalog } from './subagents.js'
import * as providers from './providers.js'
import { subagentHistory, withParentSession } from './subagent-sessions.js'
import { historyStore } from './history.js'
import { readMessages } from './messages.js'
import { createSession, deleteSession, getSession, listSessions } from './sessions.js'

/**
 * ── Delegation, as the machine actually records it ───────────────────────────
 *
 * Two modules, one claim between them: handing part of a job to a specialist
 * produces a SESSION — a real one, parented to the turn that asked for it, with
 * the specialist's own work readable in it — and that specialist is confined by
 * what it was handed rather than by what it was told.
 *
 * Neither had a test. Both are the kind of code that fails silently: a child
 * that comes out parentless still answers, a specialist handed the wrong tool
 * set still works, and in both cases the only symptom is a guarantee that
 * quietly is not one any more. The behavioural side (a turn really delegating
 * through the library's `task` tool) is evals/cases/03-delegation.eval.mjs;
 * what is pinned here is the machine's own half, which that case can only
 * observe indirectly.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-subagents-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** Never called — every Agent here is inspected, not run. */
const MODEL = 'test/model' as unknown as LanguageModel
/** The same thing as a reference: what the delegating turn is running on. */
const PARENT_MODEL_REF = 'acme/parent-1'

const ARCHETYPES = () => path.join(home, '.hoshi', 'archetypes')

function seedArchetype(
  name: string,
  fields: { description: string; readOnly?: boolean; tier?: string },
  prompt: string,
): void {
  mkdirSync(ARCHETYPES(), { recursive: true })
  const header = [
    `description: ${fields.description}`,
    ...(fields.readOnly ? ['readOnly: true'] : []),
    ...(fields.tier ? [`tier: ${fields.tier}`] : []),
  ].join('\n')
  writeFileSync(path.join(ARCHETYPES(), `${name}.md`), `---\n${header}\n---\n\n${prompt}\n`)
}

function seedPreferences(preferences: Record<string, string>): void {
  mkdirSync(path.join(home, '.hoshi'), { recursive: true })
  writeFileSync(path.join(home, '.hoshi', 'preferences.json'), JSON.stringify(preferences))
}

let counter = 0
function nextId(prefix: string): string {
  return `${prefix}_${++counter}`
}

function say(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: text } as ModelMessage
}

beforeEach(() => {
  counter += 100
})

describe('a delegated specialist’s work becomes a session', () => {
  it('registers the child under the turn that spawned it, in the parent’s directory', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = nextId('ses_child')

    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      subagentHistory.save(child, [say('user', 'Add a bounded retry to the uploader.'), say('assistant', 'Done.')]),
    )

    const registered = await getSession(child)
    expect(registered?.parentId).toBe(parent.id)
    /**
     *
     * The parent's folder, not the process's: a specialist that answered about
     * a different checkout than the one it was delegated from would be reading
     * somebody else's project.
     *
     **/
    expect(registered?.directory).toBe('/workspace/acme/site')
  })

  it('keeps the id the library named the child by, so record and transcript agree', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = nextId('ses_child')

    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      subagentHistory.save(child, [say('assistant', 'STATUS: done.')]),
    )

    expect((await listSessions()).filter((session) => session.parentId === parent.id).map((s) => s.id)).toEqual([child])
    expect(await historyStore.load(child)).toHaveLength(1)
  })

  it('writes what the specialist DID, not only what it reported', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = nextId('ses_child')

    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      subagentHistory.save(child, [
        say('user', 'Add a bounded retry to the uploader.'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'The upload path has no backoff.' },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'edit', input: { path: 'uploader.ts' } },
            { type: 'text', text: 'STATUS: done. Changed uploader.ts.' },
          ],
        } as ModelMessage,
      ]),
    )

    const transcript = await readMessages(child)
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant'])
    const kinds = transcript[1]!.parts.map((part) => part.type)
    expect(kinds).toEqual(['reasoning', 'tool', 'text'])
    /**
     *
     * "What the specialist actually did" is the whole reason to open its
     * thread — a transcript that kept only the report would be the summary
     * this store exists to stop being the only account.
     *
     **/
    const call = transcript[1]!.parts.find((part) => part.type === 'tool')
    expect(call).toMatchObject({ name: 'edit', callId: 'call_1', state: { status: 'completed' } })
    /**
     *
     * Stamped complete: every message here is one the child already finished,
     * and an open stamp renders the specialist as permanently mid-thought.
     *
     **/
    expect(transcript.every((message) => message.completedAt)).toBe(true)
  })

  it('registers once, however many times the child saves', async () => {
    const parent = await createSession('/workspace/acme/site')
    const other = await createSession('/workspace/acme/other')
    const child = nextId('ses_child')

    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      subagentHistory.save(child, [say('assistant', 'Reading.')]),
    )
    /**
     *
     * A second save — and, deliberately, one arriving under a DIFFERENT parent
     * context. Re-registering would re-home a running child onto whichever turn
     * happened to save last.
     *
     **/
    await withParentSession({ sessionId: other.id, directory: other.directory }, () =>
      subagentHistory.save(child, [say('assistant', 'Reading.'), say('assistant', 'STATUS: done.')]),
    )

    expect((await listSessions()).filter((session) => session.id === child)).toHaveLength(1)
    expect((await getSession(child))?.parentId).toBe(parent.id)
    expect(await readMessages(child)).toHaveLength(2)
  })

  it('invents no session for a save with no turn behind it', async () => {
    const orphan = nextId('ses_orphan')

    await subagentHistory.save(orphan, [say('assistant', 'Nobody asked for this.')])

    expect(await getSession(orphan)).toBeNull()
    /**
     *
     * The conversation is still kept — the store's job is the record, and
     * refusing to write it would lose work over a missing label.
     *
     **/
    expect(await historyStore.load(orphan)).toHaveLength(1)
  })

  it('goes with the conversation it belongs to when that is deleted', async () => {
    const parent = await createSession('/workspace/acme/site')
    const child = nextId('ses_child')
    const grandchild = nextId('ses_child')

    await withParentSession({ sessionId: parent.id, directory: parent.directory }, () =>
      subagentHistory.save(child, [say('assistant', 'Working.')]),
    )
    await withParentSession({ sessionId: child, directory: parent.directory }, () =>
      subagentHistory.save(grandchild, [say('assistant', 'Also working.')]),
    )

    expect(await deleteSession(parent.id)).toBe(true)

    /**
     *
     * The whole subtree. A specialist's session is not a conversation in its own
     * right — the only surface that can show it is nested under the parent — so
     * deleting the parent alone left it pointing at a session that no longer
     * exists: invisible everywhere, and unreachable by anything that could tidy
     * it up. Which is exactly what a real machine was found holding.
     *
     **/
    for (const id of [parent.id, child, grandchild]) expect(await getSession(id)).toBeNull()
    /**
     *
     * And their work goes with them, both stores — a transcript left behind is
     * disk nobody can ever read.
     *
     **/
    for (const id of [child, grandchild]) {
      expect(await readMessages(id)).toEqual([])
      expect((await historyStore.load(id)) ?? []).toEqual([])
    }
  })

  it('attributes children correctly when two turns delegate at once', async () => {
    const first = await createSession('/workspace/acme/first')
    const second = await createSession('/workspace/acme/second')
    const firstChild = nextId('ses_child')
    const secondChild = nextId('ses_child')

    /**
     *
     * The reason the parent is carried in AsyncLocalStorage rather than in a
     * module variable. Interleaved on purpose: a shared variable attributes
     * both children to whichever turn wrote it last, and the failure is
     * invisible — every child still runs and still answers.
     *
     **/
    await Promise.all([
      withParentSession({ sessionId: first.id, directory: first.directory }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        await subagentHistory.save(firstChild, [say('assistant', 'First.')])
      }),
      withParentSession({ sessionId: second.id, directory: second.directory }, async () => {
        await subagentHistory.save(secondChild, [say('assistant', 'Second.')])
      }),
    ])

    expect((await getSession(firstChild))?.parentId).toBe(first.id)
    expect((await getSession(secondChild))?.parentId).toBe(second.id)
  })
})

describe('the specialists a session can delegate to', () => {
  const catalog = () =>
    archetypeCatalog({
      model: MODEL,
      modelRef: PARENT_MODEL_REF,
      effort: 'auto',
      sessionId: 'ses_parent',
      directory: home,
    })

  beforeEach(() => {
    rmSync(ARCHETYPES(), { recursive: true, force: true })
    seedArchetype('implementer', { description: 'Writes the code' }, 'You implement what you are briefed on.')
    seedArchetype('reviewer', { description: 'Reads and reports', readOnly: true }, 'You investigate and report.')
  })

  it('offers what is on disk, and nothing for a name that is not', async () => {
    expect((await catalog().list()).map((entry) => entry.name).sort()).toEqual(['implementer', 'reviewer'])
    expect(await catalog().resolve('archaeologist')).toBeUndefined()
  })

  it('builds the specialist from its own file — its brief, not a generic one', async () => {
    const specialist = await catalog().resolve('implementer')
    expect(specialist?.name).toBe('implementer')
    expect(specialist?.systemPrompt).toBe('You implement what you are briefed on.')
    /**
     *
     * `instructions: false` — the machine assembles the system prompt itself,
     * and a library that also went looking for AGENTS.md would append a second
     * copy of instructions the brief already carries.
     *
     **/
    expect(specialist?.instructions).toBe(false)
  })

  it('hands a read-only specialist nothing that can change anything', async () => {
    const reviewer = await catalog().resolve('reviewer')
    const tools = Object.keys(reviewer?.tools ?? {})

    /**
     *
     * "Investigate and report" is only a guarantee if the investigator CANNOT
     * write — enforced by what it is handed, never by asking it nicely in the
     * prompt it is free to reason its way around.
     *
     **/
    for (const mutating of ['write', 'edit', 'delete', 'bash']) expect(tools).not.toContain(mutating)
    expect(tools).toContain('read')
    expect(tools).toContain('list')
  })

  it('hands a read-write specialist the tools the personal agent lacks', async () => {
    const implementer = await catalog().resolve('implementer')
    const tools = Object.keys(implementer?.tools ?? {})

    for (const mutating of ['write', 'edit', 'bash']) expect(tools).toContain(mutating)
  })

  it('gives no specialist a way to delegate onward', async () => {
    for (const name of ['implementer', 'reviewer']) {
      const specialist = await catalog().resolve(name)
      /**
       *
       * The depth cap is STRUCTURAL, not a rule anyone has to remember: a
       * specialist is built with no subagents, so the library never grows it a
       * `task` tool. Chains of delegation nobody reviewed are exactly what the
       * cross-machine broker's own depth cap exists to stop, and this is the
       * same guard one level down.
       *
       **/
      expect(specialist?.subagents).toBeUndefined()
      expect(Object.keys(specialist?.tools ?? {})).not.toContain('task')
    }
  })
})

/**
 * ── Which model a specialist runs on ─────────────────────────────────────────
 *
 * Every archetype declares a tier and, until now, the catalogue handed every
 * specialist the model its PARENT was built with. So the three tiers, the
 * `task_route` tool that picks between them, and the small/heavy models the
 * owner configured in preferences were all decoration: an architect and a
 * scribe ran on the same model, whatever it was.
 *
 * A catalogue with a real baseUrl, so `buildModel` genuinely builds — nothing
 * is called, but a client that resolved to the wrong model id would still look
 * right if this were stubbed.
 *
 **/
function provider(models: string[]): unknown {
  return {
    id: 'acme',
    name: 'Acme',
    connected: true,
    baseUrl: 'https://acme.invalid/v1',
    keyEnvVar: null,
    models: models.map((id) => ({
      id,
      name: id,
      contextLimit: 100_000,
      inputCost: null,
      outputCost: null,
      outputModalities: [],
      inputModalities: [],
      reasoning: null,
      reasoningMode: null,
      reasoningBudgetMin: null,
    })),
  }
}

describe('the model a delegated specialist runs on', () => {
  const catalogFor = (modelRef: string) =>
    archetypeCatalog({ model: MODEL, modelRef, effort: 'auto', sessionId: 'ses_parent', directory: home })

  beforeEach(() => {
    vi.restoreAllMocks()
    rmSync(ARCHETYPES(), { recursive: true, force: true })
    const acme = provider(['small-1', 'standard-1', 'heavy-1']) as {
      models: Array<{ id: string }>
    }
    vi.spyOn(providers, 'listProviderStatuses').mockResolvedValue([acme] as unknown as Awaited<
      ReturnType<typeof providers.listProviderStatuses>
    >)
    /**
     *
     * Spied separately from the list above: `resolveModel` calls its own
     * module's `listProviderStatuses` directly, so replacing the exported
     * binding does not reach it.
     *
     **/
    vi.spyOn(providers, 'resolveModel').mockImplementation(async (ref: string) => {
      const model = acme.models.find((entry) => entry.id === ref.split('/').slice(1).join('/'))
      return ref.startsWith('acme/') && model
        ? ({ provider: acme, model } as unknown as Awaited<ReturnType<typeof providers.resolveModel>>)
        : null
    })
    seedPreferences({ model: 'acme/standard-1', smallModel: 'acme/small-1', heavyModel: 'acme/heavy-1' })
  })

  it('gives the heavy tier the heavy model, not the one the parent happens to be on', async () => {
    seedArchetype('architect', { description: 'Designs the approach', tier: 'heavy' }, 'You design.')

    const specialist = await catalogFor('acme/standard-1').resolve('architect')

    expect((specialist?.model as { modelId?: string })?.modelId).toBe('heavy-1')
  })

  it('gives the light tier the small model, so a summary does not cost an architecture review', async () => {
    seedArchetype('scribe', { description: 'Writes it up', tier: 'light' }, 'You write it up.')

    const specialist = await catalogFor('acme/standard-1').resolve('scribe')

    expect((specialist?.model as { modelId?: string })?.modelId).toBe('small-1')
  })

  it('inherits the parent’s model when the archetype declares no tier', async () => {
    seedArchetype('freeform', { description: 'No tier at all' }, 'You do the thing.')

    /**
     *
     * The parent's built model itself, not a rebuild of the same reference:
     * inheriting must be free, and a specialist that re-resolved its parent's
     * model would read credentials again on every delegation.
     *
     **/
    expect((await catalogFor('acme/standard-1').resolve('freeform'))?.model).toBe(MODEL)
  })

  it('inherits when the tier has no model configured, rather than inventing one', async () => {
    seedPreferences({ model: 'acme/standard-1' })
    seedArchetype('architect', { description: 'Designs the approach', tier: 'heavy' }, 'You design.')

    expect((await catalogFor('acme/standard-1').resolve('architect'))?.model).toBe(MODEL)
  })

  it('inherits when the tier resolves to what the parent is already on', async () => {
    seedArchetype('implementer', { description: 'Writes the code', tier: 'standard' }, 'You implement.')

    expect((await catalogFor('acme/standard-1').resolve('implementer'))?.model).toBe(MODEL)
  })

  it('still delegates when the tier points at a model this machine cannot use', async () => {
    seedPreferences({ model: 'acme/standard-1', heavyModel: 'gone/withdrawn-1' })
    seedArchetype('architect', { description: 'Designs the approach', tier: 'heavy' }, 'You design.')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    /**
     *
     * A preference pointing at a withdrawn model must cost the ROUTING, never
     * the delegation: failing here would turn a stale setting into a `task`
     * call that errors with something the agent cannot act on.
     *
     **/
    const specialist = await catalogFor('acme/standard-1').resolve('architect')
    expect(specialist?.model).toBe(MODEL)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone/withdrawn-1'))
  })
})
