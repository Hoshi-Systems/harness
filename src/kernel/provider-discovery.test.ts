import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDiscoveryCache, discoverProvider } from './provider-discovery.js'

/**
 *
 * What the endpoint says, and how often it is asked. The second half matters as
 * much as the first: every turn resolves a model through the provider listing,
 * so a provider that is switched off must not cost three seconds of everybody's
 * time, over and over.
 *
 **/

const modelList = () => Response.json({ object: 'list', data: [{ id: 'llama3.2' }, { id: 'qwen2.5-coder' }] })

/** LM Studio's own listing, which carries what the OpenAI-compatible one does
 *  not: how long a context each model is loaded with. */
const nativeList = () =>
  Response.json({
    data: [
      { id: 'llama3.2', type: 'llm', max_context_length: 131_072, loaded_context_length: 32_768 },
      { id: 'qwen2.5-coder', type: 'vlm', max_context_length: 32_768 },
    ],
  })

/** Anything that is not LM Studio: the sibling path does not exist. */
const noNative = () => new Response('not found', { status: 404 })

let calls: Array<{ url: string; auth: unknown }>

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
    return Promise.resolve(handler(url))
  })
}

beforeEach(() => {
  calls = []
  clearDiscoveryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discoverProvider', () => {
  it('reports what the endpoint serves, and that it needed no key', async () => {
    stubFetch((url) => (url.includes('/api/v0/') ? noNative() : modelList()))
    const discovered = await discoverProvider('http://box:11434/v1', null)
    expect(discovered?.models.map((model) => model.id)).toEqual(['llama3.2', 'qwen2.5-coder'])
    expect(discovered?.keyless).toBe(true)
    /**
     *
     * Two asks: the model list, then one look at the sibling path a local
     * runtime publishes its context lengths on. The second 404s everywhere
     * else, which costs nothing and is the only way to learn a figure the
     * OpenAI-compatible listing does not carry.
     *
     **/
    expect(calls.map((call) => call.url)).toEqual(['http://box:11434/v1/models', 'http://box:11434/api/v0/models'])
  })

  it('takes the context length a local runtime publishes on its own path', async () => {
    /**
     *
     * The failure this fixes: `/v1/models` is a list of ids by design, so every
     * self-hosted model arrived with a context limit of 0 — and the composer's
     * context meter, which needs a denominator, disappeared for anybody running
     * LM Studio. The number existed the whole time, one path over.
     *
     **/
    stubFetch((url) => (url.includes('/api/v0/') ? nativeList() : modelList()))
    const discovered = await discoverProvider('http://box:11434/v1', null)
    const byId = new Map(discovered?.models.map((model) => [model.id, model]))
    /**
     *
     * The LOADED length wins over the maximum: a model loaded at 32k in a
     * runtime that could serve 128k is still a 32k conversation.
     *
     **/
    expect(byId.get('llama3.2')?.contextLimit).toBe(32_768)
    expect(byId.get('qwen2.5-coder')?.contextLimit).toBe(32_768)
    expect(byId.get('qwen2.5-coder')?.inputModalities).toContain('image')
  })

  it('looks under /v1 when the root answers with something that is not a model list', async () => {
    /**
     *
     * LM Studio, verbatim: the root path does not 404, it says
     * `200 {"error":"Unexpected endpoint or method"}`.
     *
     **/
    stubFetch((url) =>
      url.endsWith('/v1/models') ? modelList() : Response.json({ error: 'Unexpected endpoint or method.' }),
    )
    const discovered = await discoverProvider('http://box:11434', null)
    expect(discovered?.models.map((model) => model.id)).toEqual(['llama3.2', 'qwen2.5-coder'])
    expect(calls.map((call) => call.url)).toEqual([
      'http://box:11434/models',
      'http://box:11434/v1/models',
      'http://box:11434/api/v0/models',
    ])
  })

  it('falls back to the key when the endpoint refuses an anonymous ask', async () => {
    stubFetch((url) =>
      url.includes('/api/v0/') ? noNative() : calls.at(-1)?.auth ? modelList() : new Response('nope', { status: 401 }),
    )
    const discovered = await discoverProvider('https://api.example.com/v1', 'sk-test')
    expect(discovered?.models.length).toBe(2)
    /**
     *
     * Keyless is EVIDENCE, not an assumption: this endpoint proved it wants one.
     *
     **/
    expect(discovered?.keyless).toBe(false)
    expect(calls.map((call) => call.auth)).toEqual([undefined, 'Bearer sk-test', undefined])
  })

  it('asks once and reuses the answer', async () => {
    stubFetch((url) => (url.includes('/api/v0/') ? noNative() : modelList()))
    await discoverProvider('http://box:11434/v1', null)
    await discoverProvider('http://box:11434/v1', null)
    /**
     *
     * Two calls for the first discovery — the list and the local-runtime probe
     * — and none at all for the second. Every turn resolves a model through
     * this, so an endpoint that is switched off must not cost three seconds
     * over and over.
     *
     **/
    expect(calls.length).toBe(2)
  })

  it('remembers a provider that did not answer, so a listing stays fast', async () => {
    stubFetch(() => new Response('down', { status: 503 }))
    expect(await discoverProvider('http://box:11434/v1', null)).toBeNull()
    expect(await discoverProvider('http://box:11434/v1', null)).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('survives an endpoint that answers with something unparseable', async () => {
    stubFetch(() => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await discoverProvider('http://box:11434/v1', null)).toBeNull()
  })
})
