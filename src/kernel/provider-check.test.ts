import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureKernel } from './host-ports.js'
import { checkProvider } from './providers.js'
import { clearDiscoveryCache } from './provider-discovery.js'
import { setSecret } from './secrets.js'

/**
 * ── "Saved" and "works" are two different words ──────────────────────────────
 *
 * A provider reads `connected` the moment its key is in the vault. That is
 * true, and it is not what anybody understands by it: a mistyped key, a revoked
 * key and a working key were indistinguishable until the first turn failed —
 * which is the worst possible moment to find out, and the one place the failure
 * reads as the agent being broken rather than as a text field being wrong.
 *
 * What is pinned here is the vocabulary, because a check with one failure word
 * is barely better than no check. "The address is wrong" and "the key is wrong"
 * send a person to two different places, and the third answer — the endpoint
 * lists its models to anybody, so nothing here tested the key at all — is the
 * one a polite implementation would round up to a pass and must not.
 *
 * And the cost. The only way to settle that third answer is a real completion,
 * which is somebody's money; every test below that does not authorize one
 * asserts that none was made.
 *
 **/

let home: string
const ORIGINAL_HOME = process.env.HOME
/** Every request the machine made while a case ran — the evidence for "and it
 *  did not spend anything". */
let requests: Array<{ url: string; method: string; auth: string | null; body: unknown }>

const ENDPOINT = 'https://llm.test/v1'

function writeCustom(overrides: Record<string, unknown> = {}): void {
  mkdirSync(path.join(home, '.hoshi'), { recursive: true })
  writeFileSync(
    path.join(home, '.hoshi', 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'acme',
          name: 'Acme',
          baseUrl: ENDPOINT,
          keyEnvVar: 'ACME_API_KEY',
          keyless: false,
          models: [{ id: 'acme-1', name: 'Acme 1', limit: { context: 1000 } }],
          ...overrides,
        },
      ],
    }),
  )
}

/** The endpoint, answering `/models` by whether a credential was sent. */
function endpoint(answers: {
  anonymous?: 'models' | 'unauthorized' | 'notFound' | 'down'
  withKey?: 'models' | 'unauthorized' | 'notFound' | 'down'
  completion?: 'ok' | 'unauthorized' | 'down'
}): void {
  const reply = (kind: string | undefined) => {
    if (kind === 'models') return Response.json({ data: [{ id: 'acme-1' }] })
    if (kind === 'unauthorized') return new Response('no', { status: 401 })
    if (kind === 'notFound') return new Response('no', { status: 404 })
    throw new Error('connect ECONNREFUSED')
  }
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.href
    const auth = new Headers(init?.headers).get('authorization')
    requests.push({
      url,
      method: init?.method ?? 'GET',
      auth,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (url.endsWith('/chat/completions')) {
      if (answers.completion === 'ok') return Response.json({ choices: [{ message: { content: 'hi' } }] })
      if (answers.completion === 'unauthorized') return new Response('no', { status: 401 })
      throw new Error('connect ECONNREFUSED')
    }
    return reply(auth ? answers.withKey : answers.anonymous)
  })
}

const completions = () => requests.filter((request) => request.url.endsWith('/chat/completions'))

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'provider-check-'))
  process.env.HOME = home
  requests = []
  configureKernel({})
  clearDiscoveryCache()
  writeCustom()
  await setSecret('ACME_API_KEY', 'sk-real')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  configureKernel({})
  vi.unstubAllGlobals()
})

describe('a credential the provider accepts', () => {
  it('passes, and says so as its own outcome', async () => {
    endpoint({ anonymous: 'unauthorized', withKey: 'models' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'ok', billedModel: null })
  })

  it('is proven the way a turn authenticates, not some other way', async () => {
    /**
     *
     * `kernel/model.ts` builds every provider with `Authorization: Bearer`. A
     * check that proved a credential through a different header would pass for
     * a key the next turn cannot use, which is worse than not checking.
     *
     **/
    endpoint({ anonymous: 'unauthorized', withKey: 'models' })
    await checkProvider('acme')
    expect(requests.some((request) => request.auth === 'Bearer sk-real')).toBe(true)
  })
})

describe('a credential the provider refuses', () => {
  it('is an authentication failure, not a reachability one', async () => {
    /**
     *
     * The two send a person to different places — reissue a key, or fix an
     * address — so collapsing them into "could not connect" costs them the
     * afternoon.
     *
     **/
    endpoint({ anonymous: 'unauthorized', withKey: 'unauthorized' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'auth' })
  })

  it('carries the provider’s own status, because the category is not the reason', async () => {
    endpoint({ anonymous: 'unauthorized', withKey: 'unauthorized' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ detail: 'The provider answered 401.' })
  })
})

describe('an endpoint that does not answer', () => {
  it('is unreachable, and the key is not blamed for it', async () => {
    endpoint({ anonymous: 'down', withKey: 'down' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'unreachable' })
  })

  it('is still unreachable when something answers and none of it is a model list', async () => {
    /**
     *
     * A 404 on both paths means the ADDRESS is wrong. Telling somebody their
     * key was rejected when it was never read sends them to reissue a
     * perfectly good one.
     *
     **/
    endpoint({ anonymous: 'notFound', withKey: 'notFound' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'unreachable' })
  })
})

describe('an endpoint that lists its models to anybody', () => {
  it('is reported untested — nothing there examined the key', async () => {
    /**
     *
     * The answer a polite implementation rounds up to a pass. It is not one:
     * the endpoint has said nothing whatsoever about this credential.
     *
     **/
    endpoint({ anonymous: 'models', withKey: 'models' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'untested' })
  })

  it('and nothing was spent finding that out', async () => {
    endpoint({ anonymous: 'models', withKey: 'models' })
    await checkProvider('acme')
    expect(completions()).toHaveLength(0)
  })

  it('is settled by one completion when the caller authorizes one', async () => {
    endpoint({ anonymous: 'models', withKey: 'models', completion: 'ok' })
    await expect(checkProvider('acme', { allowBillable: true })).resolves.toMatchObject({
      outcome: 'ok',
      billedModel: 'acme-1',
    })
    expect(completions()).toHaveLength(1)
  })

  it('and that completion is one token, so the check cannot cost a conversation', async () => {
    /**
     *
     * The disclosure is "this may cost a fraction of a cent", and that has to
     * stay true. An unbounded probe would make it a sentence nobody could
     * stand behind.
     *
     **/
    endpoint({ anonymous: 'models', withKey: 'models', completion: 'ok' })
    await checkProvider('acme', { allowBillable: true })
    expect(completions()[0]?.body).toMatchObject({ model: 'acme-1', max_tokens: 1, stream: false })
  })

  it('reports the billed model, so what was spent is nameable afterwards', async () => {
    endpoint({ anonymous: 'models', withKey: 'models', completion: 'unauthorized' })
    await expect(checkProvider('acme', { allowBillable: true })).resolves.toMatchObject({
      outcome: 'auth',
      billedModel: 'acme-1',
    })
  })
})

describe('authorizing a billable check does not mean paying for one', () => {
  it('spends nothing when the free probe already answered', async () => {
    /**
     *
     * The permission is to SETTLE an inconclusive answer, not to run a
     * completion regardless. A provider that refuses the key at its model list
     * has been tested for free.
     *
     **/
    endpoint({ anonymous: 'unauthorized', withKey: 'unauthorized', completion: 'ok' })
    await expect(checkProvider('acme', { allowBillable: true })).resolves.toMatchObject({
      outcome: 'auth',
      billedModel: null,
    })
    expect(completions()).toHaveLength(0)
  })
})

describe('a provider with no credential to test', () => {
  it('passes on the endpoint answering, because there is no key to exercise', async () => {
    /**
     *
     * A local runtime on loopback. Reporting `untested` here would be
     * demanding proof of something that does not exist.
     *
     **/
    writeCustom({ keyless: true, keyEnvVar: null })
    endpoint({ anonymous: 'models' })
    await expect(checkProvider('acme')).resolves.toMatchObject({ outcome: 'ok' })
  })
})

describe('a provider the organization does not allow', () => {
  it('is refused rather than tested', async () => {
    /**
     *
     * Policy first, everywhere. A check that reported "your key works" about a
     * provider no turn may use is the same success-shaped lie the connection
     * flow already had.
     *
     **/
    configureKernel({ allowedProviders: async () => new Set(['someone-else']) })
    endpoint({ anonymous: 'unauthorized', withKey: 'models' })
    await expect(checkProvider('acme')).rejects.toThrow(/provider policy/i)
    expect(requests).toHaveLength(0)
  })
})
