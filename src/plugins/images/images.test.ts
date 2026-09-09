import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import { bindTools, type CatalogueProvider } from '../define-tool.js'
import { imageTools } from './tools.js'

/**
 * ── Can this machine make pictures? ──────────────────────────────────────────
 *
 * The answer comes from the same credentials the chat already runs on, which
 * makes `image_generate` the clearest case of the rule H-08 is about: a
 * capability the machine may simply not have. Everything below is about SAYING
 * SO — an agent handed a vague failure retries three times and then apologises
 * to the user, which is the outcome an actionable refusal exists to prevent.
 *
 * The selection itself is a preference order that nothing else states: this
 * file's driver list, not the catalogue's order, and newest-released first with
 * deprecated models dropped and a stable id preferred over its `-preview` twin.
 * Getting that wrong picks a worse model forever and reports nothing.
 *
 * Nothing here reaches a provider: `fetch` is stubbed, and every case is either
 * decided before a request would go out or asserted on the request that would —
 * which is exactly how "which provider got picked" is checked without depending
 * on anyone's API being up.
 *
 **/

const ORIGINAL_KEYS = { GOOGLE: process.env.GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER: process.env.OPENROUTER_API_KEY }
const ORIGINAL_FETCH = globalThis.fetch

/** Every provider request this run would have made. Refused, so no test here
 *  depends on a third party being reachable. */
let requested: string[] = []

function model(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, outputModalities: ['image'], releaseDate: null, status: null, ...overrides }
}

function provider(id: string, models: ReturnType<typeof model>[], connected = true): CatalogueProvider {
  return { id, name: id, connected, models }
}

/** `vault` is what the machine holds for each provider — the path a key
 *  connected in Customize actually travels. */
function generate(providers: CatalogueProvider[], vault: Record<string, string> = {}): Tool {
  return bindTools(
    { image_generate: imageTools.image_generate! },
    {
      sessionId: 'ses_1',
      directory: '/w/acme/api',
      worktree: '/w/acme/api',
      model: null,
      agent: 'hoshi',
      publish: vi.fn(),
      machine: {
        complete: async () => '',
        providers: async () => providers,
        tierModel: async () => null,
        providerKey: async (id: string) => vault[id] ?? null,
        createCommand: async () => undefined,
        createSkill: async () => undefined,
      },
    },
  ).image_generate!
}

const run = (tool: Tool, args: Record<string, unknown>) =>
  (tool.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>)(
    { prompt: 'a red bicycle', ...args },
    { abortSignal: undefined },
  )

beforeEach(() => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  requested = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    requested.push(String(input))
    return new Response('{"error":"nope"}', { status: 503 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  for (const [name, value] of [
    ['GOOGLE_GENERATIVE_AI_API_KEY', ORIGINAL_KEYS.GOOGLE],
    ['OPENROUTER_API_KEY', ORIGINAL_KEYS.OPENROUTER],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('a machine that cannot make images', () => {
  it('says what to connect, rather than failing vaguely', async () => {
    /**
     *
     * The refusal IS the feature. "No image model" with no next step reads to
     * an agent as a transient fault worth retrying.
     *
     **/
    await expect(run(generate([]), {})).rejects.toThrow(/Connect a provider with an image-output model/)
  })

  it('is not fooled by a text-only model on a connected provider', async () => {
    const textOnly = provider('google', [model('gemini-text', { outputModalities: ['text'] })])
    await expect(run(generate([textOnly]), {})).rejects.toThrow(/No image-generation-capable model/)
  })

  it('does not count a model the provider marked deprecated', async () => {
    const deprecated = provider('google', [model('gemini-old', { status: 'deprecated' })])
    await expect(run(generate([deprecated]), {})).rejects.toThrow(/No image-generation-capable model/)
  })
})

describe('a model the agent asked for by name', () => {
  const google = provider('google', [model('gemini-image-1')])
  const KEYED = { google: 'key-google' }

  it('refuses a reference that is not provider/model', async () => {
    await expect(run(generate([google]), { model: 'gemini-image-1' })).rejects.toThrow(/pass it as "provider\/model"/)
  })

  it('refuses a provider this machine does not have', async () => {
    await expect(run(generate([google]), { model: 'stability/sd-9' })).rejects.toThrow(/Unknown provider "stability"/)
  })

  it('refuses a provider this tool cannot drive, and names the ones it can', async () => {
    /**
     *
     * A connected provider is not the same as a drivable one — this tool
     * speaks two REST APIs by hand.
     *
     **/
    const anthropic = provider('anthropic', [model('claude-image')])
    await expect(run(generate([google, anthropic]), { model: 'anthropic/claude-image' })).rejects.toThrow(
      /isn't supported for direct image generation yet — supported: google, openrouter/,
    )
  })

  it('refuses a model that cannot output images', async () => {
    const mixed = provider('google', [model('gemini-text', { outputModalities: ['text'] })])
    await expect(run(generate([mixed]), { model: 'google/gemini-text' })).rejects.toThrow(/can't output images/)
  })

  it('says an API key is needed when the machine holds none for the provider', async () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    await expect(run(generate([google]), { model: 'google/gemini-image-1' })).rejects.toThrow(/API key/)
  })

  it('finds the key the user connected in Customize, which lives in the vault and not in this process`s env', async () => {
    /**
     *
     * The regression this exists for. `resolveApiKey` read `process.env` and
     * OpenCode's on-disk auth stores, and a Hoshi machine writes neither: the
     * vault holds the key under the provider's env var, and nothing exports it
     * into the daemon. So a machine with a perfectly good Google key connected
     * answered "no API key is set" — a tool that never worked, on a surface
     * neither the census nor the evals connect a provider on.
     *
     **/
    await expect(run(generate([google], KEYED), { model: 'google/gemini-image-1' })).rejects.toThrow(
      /Gemini image request failed/,
    )
    expect(requested).toHaveLength(1)
  })
})

describe('source images the model asked to edit', () => {
  const withKey = () => generate([provider('google', [model('gemini-image-1')])], { google: 'key-google' })

  it('refuses a path that resolves outside the workspace', async () => {
    /**
     *
     * The path comes from the MODEL. Reading an arbitrary file and posting it
     * to a provider is exfiltration with extra steps.
     *
     **/
    await expect(run(withKey(), { sourceImages: ['../../../etc/shadow.png'] })).rejects.toThrow(
      /resolves outside the workspace/,
    )
  })

  it('refuses a file type it will not send', async () => {
    await expect(run(withKey(), { sourceImages: ['notes.txt'] })).rejects.toThrow(/Unsupported source image type/)
  })

  it('refuses more than the four it will carry', async () => {
    const many = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
    await expect(run(withKey(), { sourceImages: many })).rejects.toThrow(/Too many source images \(5\)/)
  })
})

describe('which model gets picked', () => {
  it('prefers google over openrouter, whatever order the catalogue is in', async () => {
    /**
     *
     * The driver list is the preference, and catalogue order is not — a
     * catalogue reshuffle upstream must not change what this machine generates
     * with.
     *
     **/
    const catalogue = [provider('openrouter', [model('or-image')]), provider('google', [model('gemini-image-1')])]
    await expect(run(generate(catalogue, { google: 'key-google', openrouter: 'key-openrouter' }), {})).rejects.toThrow(
      /Gemini/i,
    )
    expect(requested[0]).toContain('googleapis.com')
  })

  it('skips a provider with no key and uses the next one that has one', async () => {
    const catalogue = [provider('google', [model('gemini-image-1')]), provider('openrouter', [model('or-image')])]
    await expect(run(generate(catalogue, { openrouter: 'key-openrouter' }), {})).rejects.toThrow(/OpenRouter/i)
    expect(requested[0]).toContain('openrouter.ai')
  })
})
