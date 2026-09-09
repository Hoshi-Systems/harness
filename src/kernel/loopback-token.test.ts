import { beforeAll, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'

/** The loopback credential's whole security value is that BOTH halves have to
 *  hold — the right token AND a loopback origin. These cases exist because the
 *  origin half is the one that would be easy to drop in a refactor, and doing so
 *  would turn a machine-local marker into a credential anyone who could read the
 *  vault could use from the public ingress.
 *
 *  The store writes under `$HOME/.hoshi`, so HOME is pointed at a scratch path
 *  before the module loads — the suite never touches a real machine's state. */
let api: typeof import('./loopback-token.js')

beforeAll(async () => {
  process.env.HOME = `/tmp/hoshi-loopback-test-${process.pid}`
  api = await import('./loopback-token.js')
})

/** A request whose socket reports `address`, with an optional bearer. */
function request(address: string | undefined, bearer?: string): H3Event {
  return {
    node: {
      req: {
        socket: { remoteAddress: address },
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      },
    },
  } as unknown as H3Event
}

describe('loopbackToken', () => {
  it('is stable across calls', async () => {
    /**
     *
     * Rotating would silently break every already-seeded skill until the pack
     * was reinstalled.
     *
     **/
    expect(await api.loopbackToken()).toBe(await api.loopbackToken())
  })

  it('is long enough to be unguessable', async () => {
    expect((await api.loopbackToken()).length).toBeGreaterThanOrEqual(40)
  })
})

describe('isLoopbackCall', () => {
  it('accepts the right token over loopback', async () => {
    expect(await api.isLoopbackCall(request('127.0.0.1', await api.loopbackToken()))).toBe(true)
  })

  it('accepts IPv6-mapped IPv4, which a dual-stack listener reports', async () => {
    expect(await api.isLoopbackCall(request('::ffff:127.0.0.1', await api.loopbackToken()))).toBe(true)
    expect(await api.isLoopbackCall(request('::1', await api.loopbackToken()))).toBe(true)
  })

  it('refuses the RIGHT token from a remote address', async () => {
    /**
     *
     * The load-bearing case: the credential is readable by anything on the box,
     * which is only acceptable because presenting it from outside proves nothing.
     *
     **/
    expect(await api.isLoopbackCall(request('203.0.113.9', await api.loopbackToken()))).toBe(false)
  })

  it('refuses a wrong token over loopback', async () => {
    expect(await api.isLoopbackCall(request('127.0.0.1', 'not-the-token'))).toBe(false)
  })

  it('refuses a request with no token at all', async () => {
    expect(await api.isLoopbackCall(request('127.0.0.1'))).toBe(false)
  })

  it('refuses when the socket reports no address', async () => {
    expect(await api.isLoopbackCall(request(undefined, await api.loopbackToken()))).toBe(false)
  })
})
