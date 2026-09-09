import { describe, expect, it } from 'vitest'
import { createApp, defineEventHandler, defineWebSocketHandler, toWebHandler, type EventHandler } from 'h3'
import { RouteConflictError, RouteTable } from './router.js'

/**
 *
 * The route table, which the harness calls load-bearing and had no tests
 * (docs/STRUCTURE_REVIEW.md H-06).
 *
 * Everything asserted here has an outage or a near-miss written into
 * router.ts's own comments: a plugin silently taking over
 * `/sessions/:id/messages`; a browser refusing every call at the preflight
 * because CORS was applied beside the router instead of inside it; and a
 * wrapper that dropped h3's websocket metadata and disabled every upgrade
 * route. Those comments are the spec — this file makes them checkable.
 *
 **/

const ok = (body: unknown = { ok: true }): EventHandler => defineEventHandler(() => body)

/** Drive a table's handler the way a client would. */
async function call(table: RouteTable, method: string, path: string, headers: Record<string, string> = {}) {
  const app = createApp()
  app.use(table.handler())
  const response = await toWebHandler(app)(new Request(`http://machine.test${path}`, { method, headers }))
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /** Left as text — a non-JSON body is a valid thing to assert on. */
  }
  return { status: response.status, body: parsed, headers: response.headers }
}

describe('RouteTable.add', () => {
  it('refuses a second owner for one endpoint, and names both', () => {
    const table = new RouteTable()
    table.add('POST', '/sessions/:id/messages', 'kernel', ok())
    let thrown: unknown
    try {
      table.add('POST', '/sessions/:id/messages', 'rogue-plugin', ok())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RouteConflictError)
    /** Naming BOTH sides is the point: "conflict on /sessions/:id/messages" sends
     *  you grepping, "kernel and rogue-plugin" does not. */
    expect((thrown as Error).message).toContain('kernel')
    expect((thrown as Error).message).toContain('rogue-plugin')
  })

  it('treats /health and health as the same endpoint', () => {
    /** Two spellings that both register and only one of which answers is the
     *  silent-shadowing failure the conflict error exists to prevent. */
    const table = new RouteTable()
    table.add('GET', '/health', 'kernel', ok())
    expect(() => table.add('GET', 'health', 'plugin', ok())).toThrow(RouteConflictError)
  })

  it('treats a trailing slash as the same endpoint', () => {
    const table = new RouteTable()
    table.add('GET', '/goals', 'goals', ok())
    expect(() => table.add('GET', '/goals/', 'other', ok())).toThrow(RouteConflictError)
  })

  it('lets the same path carry different methods', () => {
    const table = new RouteTable()
    table.add('GET', '/preferences', 'kernel', ok())
    expect(() => table.add('PATCH', '/preferences', 'kernel', ok())).not.toThrow()
    expect(table.list()).toHaveLength(2)
  })

  it('records who owns each route, sorted for reading', () => {
    const table = new RouteTable()
    table.add('GET', '/zeta', 'plugin-z', ok())
    table.add('GET', '/alpha', 'kernel', ok())
    table.add('POST', '/alpha', 'plugin-a', ok())
    expect(table.list()).toEqual([
      { method: 'GET', path: '/alpha', from: 'kernel' },
      { method: 'POST', path: '/alpha', from: 'plugin-a' },
      { method: 'GET', path: '/zeta', from: 'plugin-z' },
    ])
  })
})

describe('RouteTable.handler', () => {
  it('routes to the registered handler', async () => {
    const table = new RouteTable()
    table.add('GET', '/health', 'kernel', ok({ status: 'ok' }))
    await expect(call(table, 'GET', '/health')).resolves.toMatchObject({ status: 200, body: { status: 'ok' } })
  })

  it('answers any verb on an ALL route', async () => {
    /** What a websocket upgrade and a proxy passthrough need — Nitro spelled it
     *  "a file with no method in its name"; here it is said out loud. */
    const table = new RouteTable()
    table.add('ALL', '/proxy/:port', 'services', ok({ proxied: true }))
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      await expect(call(table, method, '/proxy/8080')).resolves.toMatchObject({ status: 200 })
    }
  })

  it('carries CORS on every route, because the routes cannot be mounted without it', async () => {
    /**
     *
     * CORS used to be applied beside the router in the daemon's listen path, so
     * anything mounting this handler directly served every route without the
     * headers. A browser then refused every call at the preflight: the page
     * rendered, nothing worked, and nothing reached the server logs. Only a
     * browser can see that failure — which is why it is asserted here.
     *
     **/
    const table = new RouteTable()
    table.add('GET', '/health', 'kernel', ok())
    const answered = await call(table, 'GET', '/health', { origin: 'http://localhost:3000' })
    expect(answered.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  it('answers a preflight without asking the router for a route it does not have', async () => {
    const table = new RouteTable()
    table.add('POST', '/sessions', 'kernel', ok())
    /** No OPTIONS route is registered anywhere; CORS alone must answer, and a
     *  404 here would mean the router saw it. */
    const preflight = await call(table, 'OPTIONS', '/sessions', {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
    })
    expect(preflight.status).toBeLessThan(400)
  })

  it('keeps the router resolver, which is what the websocket upgrade reads', async () => {
    /**
     *
     * The first attempt at moving CORS inside WRAPPED the router's handler, and
     * a wrapper keeps the behaviour while dropping what h3 carries on the
     * handler OBJECT. Every upgrade route went dead and nothing failed loudly.
     *
     * `__resolve__` is the property that goes: it is how the upgrade adapter
     * finds the handler matching an incoming socket, so without it a websocket
     * route exists in the table and answers nothing. Asserting `__is_handler__`
     * does NOT catch this — a wrapper sets that too, which is how the first
     * version of this test passed against the very bug it names.
     *
     **/
    const table = new RouteTable()
    table.add('ALL', '/voice/stream', 'voice', defineWebSocketHandler({ message() {} }))
    const handler = table.handler() as EventHandler & {
      __resolve__?: (path: string) => Promise<{ route?: string; handler?: unknown } | undefined>
    }
    expect(typeof handler.__resolve__).toBe('function')
    /** And it still resolves the route it was given — a present-but-empty
     *  resolver would satisfy the line above and nothing else. */
    await expect(handler.__resolve__!('/voice/stream')).resolves.toMatchObject({ route: '/voice/stream' })
  })
})
