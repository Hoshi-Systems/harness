import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import { bindTools } from '../define-tool.js'
import { tierModelRef } from '../../kernel/model.js'

/**
 * ── Sizing a task before the agent recruits for it ───────────────────────────
 *
 * `task_route` is advisory by design, which is exactly what makes its failures
 * quiet: a router that stops answering does not error, it just starts sizing
 * everything the same way, and every recruit after that runs on the wrong model
 * — cheaper and worse, or dearer and no better. Nobody sees a stack trace.
 *
 * So the property under test is the FALLBACK CHAIN, all three rungs: the local
 * model in the machine, the small cloud model, and — when neither answers — the
 * rubric handed back to the agent to apply itself. The third rung is the one
 * worth pinning: falling through to it must produce a usable answer, not an
 * error the model has to interpret.
 *
 * Module constants (HOME, MACHINE_ROUTER, the ollama URL) are read at load, so
 * the scratch HOME goes in before the dynamic import below.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'routing-'))
process.env.HOME = home
const ORIGINAL_HOME = process.env.HOME
mkdirSync(path.join(home, '.hoshi', 'archetypes'), { recursive: true })
for (const archetype of ['researcher', 'implementer']) {
  writeFileSync(path.join(home, '.hoshi', 'archetypes', `${archetype}.md`), `# ${archetype}\n`)
}
writeFileSync(
  path.join(home, '.hoshi', 'preferences.json'),
  JSON.stringify({ model: 'anthropic/standard-1', smallModel: 'anthropic/small-1', heavyModel: 'anthropic/heavy-1' }),
)

const { routerTools } = await import('./tools.js')

const ORIGINAL_FETCH = globalThis.fetch

/** The local rung: ollama answering (or not) on the machine itself. */
function localRouterSays(response: string | null): void {
  globalThis.fetch = vi.fn(async () => {
    if (response === null) throw new Error('connection refused')
    return new Response(JSON.stringify({ response }), { status: 200 })
  }) as typeof fetch
}

function route(agent = 'hoshi', complete = async () => ''): Tool {
  return bindTools(
    { task_route: routerTools.task_route! },
    {
      sessionId: 'ses_1',
      directory: '/w/acme/api',
      worktree: '/w/acme/api',
      model: null,
      agent,
      publish: vi.fn(),
      machine: {
        complete,
        providers: async () => [],
        /**
         *
         * The REAL mapping, against the scratch HOME above. Stubbing it would
         * leave the property under test — that the tier the router picked
         * resolves to the model this machine is actually configured to run that
         * size of work on — asserted against the stub.
         *
         **/
        tierModel: (tier) => tierModelRef(tier),
        providerKey: async () => null,
        createCommand: async () => undefined,
        createSkill: async () => undefined,
      },
    },
  ).task_route!
}

const run = (tool: Tool, request = 'refactor the scheduler') =>
  (
    tool.execute as (
      input: unknown,
      options: { abortSignal?: AbortSignal },
    ) => Promise<{ output: string; title: string; metadata?: Record<string, unknown> }>
  )({ request }, { abortSignal: undefined })

beforeEach(() => {
  localRouterSays(null)
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = ORIGINAL_HOME
})

describe('who may route', () => {
  it('refuses a specialist — delegating another budget is not a recruit`s call', async () => {
    await expect(run(route('researcher'))).rejects.toThrow(/personal agent/)
  })
})

describe('the fallback chain', () => {
  it('uses the machine`s own router when it answers', async () => {
    localRouterSays('{"complexity":"hard","archetype":"implementer","tier":"heavy"}')
    const result = await run(route())
    expect(result.metadata).toMatchObject({ hoshi: { route: { source: 'local', tier: 'heavy' } } })
  })

  it('falls through to the small cloud model when the local one is not there', async () => {
    const result = await run(
      route('hoshi', async () => '{"complexity":"simple","archetype":"researcher","tier":"light"}'),
    )
    expect(result.metadata).toMatchObject({ hoshi: { route: { source: 'cloud', tier: 'light' } } })
  })

  it('hands the agent the rubric when neither answers, rather than failing the call', async () => {
    /**
     *
     * The rung that has to work when everything else is down. An error here
     * would surface to the user as a broken tool on a machine whose only real
     * problem is that a 522 MB model has not been pulled yet.
     *
     **/
    const result = await run(
      route('hoshi', async () => {
        throw new Error('no provider')
      }),
    )
    expect(result.metadata).toMatchObject({ hoshi: { route: { source: 'rubric' } } })
    expect(result.output).toContain('size the task yourself')
  })

  it('names the tier models in the rubric, so the agent can still pick one', async () => {
    const result = await run(
      route('hoshi', async () => {
        throw new Error('no provider')
      }),
    )
    expect(result.output).toContain('light=anthropic/small-1')
    expect(result.output).toContain('heavy=anthropic/heavy-1')
  })
})

describe('resolving a tier to a model', () => {
  it('hands back the concrete model for the tier the router chose', async () => {
    localRouterSays('{"complexity":"hard","archetype":"implementer","tier":"heavy"}')
    expect(await run(route())).toMatchObject({
      metadata: { hoshi: { route: { model: 'anthropic/heavy-1' } } },
    })
  })

  it('says `inherit` rather than inventing one when the tier has no model configured', async () => {
    /**
     *
     * A tier with nothing behind it must not silently become the default
     * model's name — the recruit would then be pinned to a model nobody chose.
     *
     **/
    writeFileSync(path.join(home, '.hoshi', 'preferences.json'), '{}')
    localRouterSays('{"complexity":"hard","archetype":"implementer","tier":"heavy"}')
    const result = await run(route())
    expect(result.metadata).toMatchObject({ hoshi: { route: { model: 'inherit' } } })
    writeFileSync(
      path.join(home, '.hoshi', 'preferences.json'),
      JSON.stringify({
        model: 'anthropic/standard-1',
        smallModel: 'anthropic/small-1',
        heavyModel: 'anthropic/heavy-1',
      }),
    )
  })
})

describe('reading what the router said', () => {
  it('finds the JSON inside a reply that also has prose around it', async () => {
    /**
     *
     * A 0.6B model told "no prose, no markdown fences" produces both anyway,
     * routinely. Refusing the answer would drop this rung on most replies.
     *
     **/
    localRouterSays('Sure! ```json\n{"complexity":"simple","archetype":"researcher","tier":"light"}\n```')
    expect(await run(route())).toMatchObject({ metadata: { hoshi: { route: { tier: 'light' } } } })
  })

  it('coerces a tier it does not recognise to standard rather than failing', async () => {
    localRouterSays('{"complexity":"nonsense","archetype":"nobody","tier":"gigantic"}')
    expect(await run(route())).toMatchObject({
      metadata: { hoshi: { route: { tier: 'standard', complexity: 'standard', archetype: null } } },
    })
  })

  it('refuses an archetype this machine does not have, rather than recruiting a ghost', async () => {
    localRouterSays('{"complexity":"hard","archetype":"astronaut","tier":"heavy"}')
    expect(await run(route())).toMatchObject({ metadata: { hoshi: { route: { archetype: null } } } })
  })

  it('falls through to the cloud rung when the local reply is not JSON at all', async () => {
    localRouterSays('I think this is probably a medium sized task, honestly')
    const result = await run(route('hoshi', async () => '{"complexity":"standard","archetype":null,"tier":"standard"}'))
    expect(result.metadata).toMatchObject({ hoshi: { route: { source: 'cloud' } } })
  })
})
