import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ── Which model actually answers ─────────────────────────────────────────────
 *
 * There is one question here and every delegation surface on the machine asks
 * it: given what the caller said, what the agent asks for, and what the owner
 * configured, WHICH `provider/model` runs this turn?
 *
 * Nothing tested it, and the answer was wrong for every caller that did not
 * name a model outright — which is every unattended run the machine has: a
 * schedule, a webhook, an agent-inbox task, a goal's own next turn, an
 * engagement step that said "inherit", a compaction. All of them went straight
 * past the machine's configured default to "the first model of the first
 * connected provider", so the model that answered was an accident of catalogue
 * order. The reported symptom is exactly that: it always takes the first model,
 * and the first model sometimes does not work.
 *
 * The tier half is the same failure one level down. Every archetype has
 * declared `tier: light|standard|heavy` since they were written, and the parser
 * read past the field: three tiers, a router tool to choose between them, two
 * extra models in preferences, and one model doing all the work.
 *
 * HOME is set before the dynamic import because these modules resolve ~/.hoshi
 * paths from it.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-model-routing-'))
const originalHome = process.env.HOME
process.env.HOME = home
mkdirSync(path.join(home, '.hoshi'), { recursive: true })

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const { resolveModelRef, tierModelRef, isModelTier } = await import('./model.js')
const { listArchetypes, archetypeAsAgent } = await import('./archetypes.js')
const providers = await import('./providers.js')

function preferences(values: Record<string, unknown>): void {
  writeFileSync(path.join(home, '.hoshi', 'preferences.json'), JSON.stringify(values))
}

/** A catalogue whose ORDER is the point: `first/model-a` is what the machine
 *  used to fall to whatever anybody configured. */
function catalogue(): void {
  vi.spyOn(providers, 'listProviderStatuses').mockResolvedValue([
    { id: 'first', name: 'First', connected: true, models: [{ id: 'model-a' }, { id: 'model-b' }] },
    { id: 'second', name: 'Second', connected: true, models: [{ id: 'model-c' }] },
  ] as unknown as Awaited<ReturnType<typeof providers.listProviderStatuses>>)
}

function seedArchetype(name: string, frontmatter: string): void {
  const dir = path.join(home, '.hoshi', 'archetypes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nYou do ${name} work.\n`)
}

beforeEach(() => {
  vi.restoreAllMocks()
  preferences({})
  rmSync(path.join(home, '.hoshi', 'archetypes'), { recursive: true, force: true })
})

describe('the model a turn runs on', () => {
  it('uses what the caller asked for, over everything else', async () => {
    catalogue()
    preferences({ model: 'second/model-c' })
    expect(await resolveModelRef('first/model-b')).toBe('first/model-b')
  })

  it('uses the machine’s configured default when the caller names none', async () => {
    catalogue()
    preferences({ model: 'second/model-c' })

    /**
     *
     * THE BUG, in one line. Every unattended run on this machine sends without
     * a model, and this used to answer `first/model-a` — the first entry of the
     * first connected provider — while `preferences.model` sat unread. A person
     * who set their machine's default model got it in the composer and nowhere
     * else.
     *
     **/
    expect(await resolveModelRef()).toBe('second/model-c')
    expect(await resolveModelRef(undefined)).toBe('second/model-c')
  })

  it('treats "inherit" and an empty string as naming nothing', async () => {
    catalogue()
    preferences({ model: 'second/model-c' })

    /**
     *
     * `inherit` is what a `team_plan` step writes to mean "whatever is above
     * me". Passed through as a literal it would be looked up as a model id and
     * fail the turn; here it simply falls to the next rung.
     *
     **/
    expect(await resolveModelRef('inherit')).toBe('second/model-c')
    expect(await resolveModelRef('')).toBe('second/model-c')
    expect(await resolveModelRef('   ')).toBe('second/model-c')
  })

  it('falls to the first usable model only when nothing else has an answer', async () => {
    catalogue()
    preferences({})
    expect(await resolveModelRef()).toBe('first/model-a')
  })

  it('has no answer at all on a machine with no connected provider', async () => {
    vi.spyOn(providers, 'listProviderStatuses').mockResolvedValue([])
    expect(await resolveModelRef()).toBeNull()
  })
})

describe('the three tiers work is routed to', () => {
  it('maps each tier to the model the owner configured for it', async () => {
    preferences({ model: 'a/standard', smallModel: 'a/small', heavyModel: 'a/heavy' })

    expect(await tierModelRef('light')).toBe('a/small')
    expect(await tierModelRef('standard')).toBe('a/standard')
    expect(await tierModelRef('heavy')).toBe('a/heavy')
  })

  it('answers null for a tier with nothing behind it, rather than the default’s name', async () => {
    preferences({ model: 'a/standard' })

    /**
     *
     * "No heavy model is set" and "the heavy model happens to equal the
     * default" are different answers. Collapsing them pins a recruit to a model
     * nobody chose — and, worse, makes it look deliberate.
     *
     **/
    expect(await tierModelRef('heavy')).toBeNull()
    expect(await tierModelRef('light')).toBeNull()
    expect(await tierModelRef('standard')).toBe('a/standard')
  })

  it('recognises the three sizes and nothing else', () => {
    expect(['light', 'standard', 'heavy'].every(isModelTier)).toBe(true)
    for (const not of ['medium', 'HEAVY', '', 'inherit', null, undefined, 3]) expect(isModelTier(not)).toBe(false)
  })
})

describe('an archetype’s declared tier', () => {
  it('is read off the file — it was written down and never looked at', async () => {
    seedArchetype('architect', 'description: Designs the approach\nreadOnly: true\ntier: heavy')
    seedArchetype('scribe', 'description: Writes it up\ntier: light')
    seedArchetype('implementer', 'description: Writes the code')

    const byName = Object.fromEntries((await listArchetypes()).map((entry) => [entry.name, entry]))
    expect(byName.architect?.tier).toBe('heavy')
    expect(byName.scribe?.tier).toBe('light')
    /**
     *
     * No tier is not a default tier: it means "run on whatever delegated to
     * me", which is a different thing from "run on the standard model".
     *
     **/
    expect(byName.implementer?.tier).toBeNull()
  })

  it('costs the hint, not the specialist, when it is a typo', async () => {
    seedArchetype('confused', 'description: Misconfigured\ntier: enormous')

    const [archetype] = await listArchetypes()
    expect(archetype?.name).toBe('confused')
    expect(archetype?.tier).toBeNull()
  })

  it('resolves to a concrete model when the same archetype runs a turn of its own', async () => {
    preferences({ model: 'a/standard', heavyModel: 'a/heavy' })
    seedArchetype('architect', 'description: Designs the approach\ntier: heavy')
    seedArchetype('implementer', 'description: Writes the code\ntier: standard')
    seedArchetype('freeform', 'description: No tier at all')

    /**
     *
     * An engagement's steps are real sessions run AS a specialist, so the same
     * tier has to govern there — otherwise one archetype answers on two
     * different models depending on which surface reached it.
     *
     **/
    expect((await archetypeAsAgent('architect'))?.model).toBe('a/heavy')
    expect((await archetypeAsAgent('implementer'))?.model).toBe('a/standard')
    expect((await archetypeAsAgent('freeform'))?.model).toBeNull()
  })
})
