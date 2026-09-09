import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureKernel } from './host-ports.js'
import { ProviderNotAllowedError, addCustomProvider, listModels, listProviders, resolveModel } from './providers.js'

/**
 * ── Policy, configuration and credentials are three different facts ──────────
 *
 * The allow-list has always been applied in `listProviders`, and nowhere else.
 * Everything that followed came from that one place:
 *
 *   - Connecting a provider the organization does not list SUCCEEDED. The
 *     endpoint was probed, four models came back, the definition was written to
 *     `providers.json` and the route answered 201 with all of it — and the very
 *     next `GET /providers` filtered the thing out. The person was told it
 *     worked and then shown a machine with no such provider.
 *   - A provider the organization LATER withdrew simply disappeared. Its
 *     configuration was still on disk, still had a credential in the vault, and
 *     the screen that was supposed to explain the machine said nothing at all.
 *
 * So the two cases are pulled apart here: a new connection is refused before
 * anything is written, and an existing one stays visible and unusable. What
 * "unusable" has to mean is asserted through the two readers a turn actually
 * goes through — the model list a picker offers, and `resolveModel`, which is
 * what a send resolves its model with.
 *
 **/

let home: string
const ORIGINAL_HOME = process.env.HOME

/** An org that allows exactly these ids — the shape `allowedProviders` returns
 *  on a machine with a Platform behind it. `null` (no port at all) is the
 *  unrestricted machine, which is the default in `beforeEach`. */
function orgAllows(...ids: string[]): void {
  configureKernel({ allowedProviders: async () => new Set(ids) })
}

function writeCustom(providers: Array<Record<string, unknown>>): void {
  mkdirSync(path.join(home, '.hoshi'), { recursive: true })
  writeFileSync(path.join(home, '.hoshi', 'providers.json'), JSON.stringify({ providers }))
}

/** One hosted provider in the cached open catalogue — the kind nobody on this
 *  machine configured and everybody's organization has an opinion about. */
function writeCatalogue(): void {
  mkdirSync(path.join(home, '.hoshi'), { recursive: true })
  writeFileSync(
    path.join(home, '.hoshi', 'models-dev.json'),
    JSON.stringify({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          keyEnvVar: 'ANTHROPIC_API_KEY',
          keyless: false,
          source: 'catalogue',
          models: [{ id: 'claude', name: 'Claude', contextLimit: 200000 }],
          policyBlocked: false,
        },
      ],
      refreshedAt: new Date().toISOString(),
    }),
  )
}

const LOCAL = {
  id: 'local-llm',
  name: 'My runtime',
  baseUrl: 'http://127.0.0.1:11434/v1',
  keyless: true,
  models: [{ id: 'qwen3', name: 'Qwen 3', limit: { context: 128000 } }],
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'provider-policy-'))
  process.env.HOME = home
  configureKernel({})
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  configureKernel({})
  vi.unstubAllGlobals()
})

describe('adding a provider the organization does not allow', () => {
  beforeEach(() => {
    /**
     *
     * The endpoint is fine and answers with models. That is the point: the
     * refusal must not depend on the address being wrong, because in the case
     * this exists for it never was.
     *
     **/
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'qwen3' }] }))
  })

  it('is refused with a policy error rather than saved', async () => {
    orgAllows('anthropic')
    await expect(addCustomProvider({ id: 'local-llm', baseUrl: LOCAL.baseUrl })).rejects.toBeInstanceOf(
      ProviderNotAllowedError,
    )
  })

  it('writes nothing to the machine — there is no half-made connection to explain', async () => {
    orgAllows('anthropic')
    await addCustomProvider({ id: 'local-llm', baseUrl: LOCAL.baseUrl }).catch(() => undefined)
    await expect(readFile(path.join(home, '.hoshi', 'providers.json'), 'utf8')).rejects.toThrow()
    await expect(listProviders()).resolves.toEqual([])
  })

  it('is accepted once the organization lists it, with no restart in between', async () => {
    /**
     *
     * The approval step and the connection step are separate writes against
     * separate APIs, and this is the seam between them: the machine re-reads
     * policy per call, so an id that arrived a moment ago is usable a moment
     * ago.
     *
     **/
    orgAllows('local-llm')
    await expect(addCustomProvider({ id: 'local-llm', baseUrl: LOCAL.baseUrl })).resolves.toMatchObject({
      id: 'local-llm',
      policyBlocked: false,
    })
  })
})

describe('a configured provider the organization no longer allows', () => {
  beforeEach(() => {
    writeCustom([LOCAL])
    orgAllows('anthropic')
  })

  it('stays on the machine, marked as blocked by policy', async () => {
    const providers = await listProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ id: 'local-llm', source: 'custom', policyBlocked: true })
  })

  it('keeps saying what was configured — the address is not the thing that changed', async () => {
    const [provider] = await listProviders()
    expect(provider?.baseUrl).toBe(LOCAL.baseUrl)
  })

  it('offers none of its models to a picker', async () => {
    await expect(listModels()).resolves.toEqual([])
  })

  it('cannot be resolved for a turn', async () => {
    await expect(resolveModel('local-llm/qwen3')).resolves.toBeNull()
  })

  it('becomes runnable again the moment policy allows it, without a restart', async () => {
    orgAllows('anthropic', 'local-llm')
    const [provider] = await listProviders()
    expect(provider).toMatchObject({ policyBlocked: false })
    await expect(resolveModel('local-llm/qwen3')).resolves.not.toBeNull()
  })
})

describe('a catalogue provider the organization does not allow', () => {
  it('is not in the ordinary listing — it is one of six thousand things this machine could have', async () => {
    /**
     *
     * The asymmetry is deliberate. A catalogue entry nobody connected is not a
     * configuration, so there is nothing to keep visible in the surface that
     * shows what this machine HAS; showing every unapproved provider as
     * "blocked" there would bury the one entry that IS somebody's own.
     *
     **/
    writeCatalogue()
    orgAllows('openai')
    await expect(listProviders()).resolves.toEqual([])
  })
})

describe('the connect picker, whose subject is what could be connected', () => {
  it('is shown the excluded catalogue, marked, so there is something to ask for', async () => {
    /**
     *
     * A brand-new organization allows nothing. Without this the person trying
     * to connect their own Anthropic key opens a picker with one free provider
     * in it and no route from there to the one they came for — which is the
     * founder's first five minutes.
     *
     **/
    writeCatalogue()
    orgAllows('openai')
    const offered = await listProviders({ includeBlocked: true })
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ id: 'anthropic', policyBlocked: true, models: [] })
  })

  it('does not leak into what may run', async () => {
    writeCatalogue()
    orgAllows('openai')
    await expect(listModels()).resolves.toEqual([])
    await expect(resolveModel('anthropic/claude')).resolves.toBeNull()
  })
})

describe('a machine with no organization behind it', () => {
  it('blocks nothing', async () => {
    writeCustom([LOCAL])
    const [provider] = await listProviders()
    expect(provider).toMatchObject({ id: 'local-llm', policyBlocked: false })
  })
})
