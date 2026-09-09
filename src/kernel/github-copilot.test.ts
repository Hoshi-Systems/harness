import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCopilotTokens, copilotFetch, copilotToken, CopilotTokenError } from './github-copilot.js'

/**
 *
 * The one thing the catalogue cannot say about Copilot: the credential in the
 * vault is not the one the wire wants. These pin the exchange — that it
 * happens, that it happens ONCE per token life rather than per request, and
 * that the request going out carries what an editor's would.
 *
 **/

interface Seen {
  url: string
  headers: Record<string, string>
  body: unknown
}

let seen: Seen[]
let exchanges: number
let tokenResponse: () => Response

function stubFetch() {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    seen.push({ url, headers, body: init?.body })
    if (url.endsWith('/copilot_internal/v2/token')) {
      exchanges += 1
      return Promise.resolve(tokenResponse())
    }
    return Promise.resolve(Response.json({ ok: true }))
  })
}

beforeEach(() => {
  seen = []
  exchanges = 0
  tokenResponse = () =>
    Response.json({
      token: 'copilot-token',
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      endpoints: { api: 'https://api.business.githubcopilot.com/' },
    })
  clearCopilotTokens()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('copilotToken', () => {
  it('mints from the GitHub token and reuses the result while it lives', async () => {
    const first = await copilotToken('gho_abc')
    const second = await copilotToken('gho_abc')
    expect(first.token).toBe('copilot-token')
    expect(second).toBe(first)
    expect(exchanges).toBe(1)
    expect(seen[0]!.headers.authorization).toBe('token gho_abc')
    expect(seen[0]!.headers['editor-version']).toMatch(/^vscode\//)
  })

  it('re-mints ahead of expiry rather than sending a token about to die', async () => {
    vi.useFakeTimers()
    tokenResponse = () => Response.json({ token: 'short', expires_at: Math.floor(Date.now() / 1000) + 90 })
    await copilotToken('gho_abc')
    vi.setSystemTime(Date.now() + 45_000)
    await copilotToken('gho_abc')
    expect(exchanges).toBe(2)
  })

  it('keeps tokens apart per GitHub token', async () => {
    await copilotToken('gho_one')
    await copilotToken('gho_two')
    expect(exchanges).toBe(2)
  })

  it('says why when GitHub will not issue one', async () => {
    tokenResponse = () => new Response('no', { status: 403 })
    await expect(copilotToken('gho_abc')).rejects.toBeInstanceOf(CopilotTokenError)
    await expect(copilotToken('gho_abc')).rejects.toThrow(/subscription/)
  })
})

describe('copilotFetch', () => {
  const baseUrl = 'https://api.githubcopilot.com'

  it('swaps the bearer, adds the editor headers, and re-points at the host the token names', async () => {
    const send = copilotFetch('gho_abc', baseUrl, globalThis.fetch)
    await send(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer gho_abc', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const request = seen.at(-1)!
    expect(request.url).toBe('https://api.business.githubcopilot.com/chat/completions')
    expect(request.headers.authorization).toBe('Bearer copilot-token')
    expect(request.headers['copilot-integration-id']).toBe('vscode-chat')
    expect(request.headers['openai-intent']).toBe('conversation-panel')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['x-initiator']).toBe('user')
    expect(request.headers['copilot-vision-request']).toBeUndefined()
  })

  it('marks a continuation after a tool as the agent, and a picture as vision', async () => {
    const send = copilotFetch('gho_abc', baseUrl, globalThis.fetch)
    await send(`${baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:…' } }] },
          { role: 'assistant', content: 'looking' },
          { role: 'tool', content: 'done' },
        ],
      }),
    })
    const request = seen.at(-1)!
    expect(request.headers['x-initiator']).toBe('agent')
    expect(request.headers['copilot-vision-request']).toBe('true')
  })

  it('leaves the address alone when the token names no host', async () => {
    tokenResponse = () => Response.json({ token: 't', expires_at: Math.floor(Date.now() / 1000) + 1800 })
    const send = copilotFetch('gho_abc', baseUrl, globalThis.fetch)
    await send(`${baseUrl}/chat/completions`, { method: 'POST', body: '{}' })
    expect(seen.at(-1)!.url).toBe(`${baseUrl}/chat/completions`)
  })

  it('sends through the inner fetch it was composed over', async () => {
    const inner = vi.fn(async () => Response.json({}))
    const send = copilotFetch('gho_abc', baseUrl, inner as unknown as typeof globalThis.fetch)
    await send(`${baseUrl}/chat/completions`, { method: 'POST', body: '{}' })
    expect(inner).toHaveBeenCalledTimes(1)
    /**
     *
     * The exchange itself still went to the real (stubbed) fetch: the inner one
     * is for the model request, which is the only thing the effort hook rewrites.
     *
     **/
    expect(exchanges).toBe(1)
  })
})
