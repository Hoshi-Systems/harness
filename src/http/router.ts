import { cors } from './cors.js'
import { createRouter, defineEventHandler, type EventHandler, type H3Event, type Router } from 'h3'

/**
 * ── The route table ──────────────────────────────────────────────────────────
 *
 * Routes are contributed by CODE at boot — the kernel first, then whichever
 * plugins are enabled — rather than discovered from the filesystem at build
 * time (docs/decisions/0002-own-harness.md). That is the whole reason this file exists:
 * a plugin enabled after the image was built still gets its endpoints, which
 * file routing cannot do.
 *
 * Two properties follow from being a real table rather than a convention:
 *
 *  1. Every route records WHO added it. With the kernel and fourteen plugins
 *     contributing, "which one owns this endpoint" has to be answerable without
 *     grepping — `hoshi-harness routes` prints it.
 *  2. A collision is a boot error, naming both sides. Last-one-wins would mean
 *     a plugin could silently take over `/sessions/:id/messages`, and the only
 *     symptom would be turns behaving strangely on a machine nobody changed.
 *
 **/

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'ALL'

export interface RouteRecord {
  method: Method
  path: string
  /** `kernel`, or the plugin's name. */
  from: string
}

export class RouteConflictError extends Error {}

export class RouteTable {
  private readonly router: Router = createRouter()
  private readonly seen = new Map<string, RouteRecord>()

  /** Register one route. `from` is not decoration — see the header. */
  add(method: Method, path: string, from: string, handler: EventHandler): void {
    const key = `${method} ${normalize(path)}`
    const existing = this.seen.get(key)
    if (existing) {
      throw new RouteConflictError(
        `${key} is claimed by both "${existing.from}" and "${from}". Two owners for one endpoint is not a merge — one of them would silently never run.`,
      )
    }
    this.seen.set(key, { method, path: normalize(path), from })
    /**
     *
     * `ALL` is a route that answers whatever verb arrives — a websocket
     * upgrade, a proxy passthrough. Nitro spelled it "a file with no method in
     * its name"; here it is said out loud.
     *
     **/
    if (method === 'ALL') this.router.use(normalize(path), handler)
    else this.router.add(normalize(path), handler, method.toLowerCase() as Lowercase<Exclude<Method, 'ALL'>>)
  }

  /** What this daemon serves, in a shape a person can read. */
  list(): RouteRecord[] {
    return [...this.seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  }

  /**
   * The machine's whole HTTP surface: CORS, then the routes.
   *
   * CORS lives HERE, inside the one thing every way of serving this machine
   * mounts. It used to be applied beside the router in `createHarness().listen()`
   * — the daemon's path only — and the Nitro shim, which mounts this handler
   * directly, served every route without the headers. A browser then refused
   * every call at the preflight: the page rendered, nothing worked, and nothing
   * reached the server logs. Only a browser can see that failure, so the routes
   * must be impossible to mount without it.
   *
   * Wrapping this handler is NOT the way to add behaviour: h3 carries websocket
   * upgrade metadata on the handler object, and a wrapper drops it — the first
   * attempt at this fix silently disabled every websocket route.
   */
  handler(): EventHandler {
    const routes = this.router.handler
    const handler: EventHandler = async (event) => {
      const answered = await cors(event)
      /**
       *
       * A preflight is answered by CORS alone — the router must never see an
       * OPTIONS it has no route for.
       *
       **/
      if (event.method === 'OPTIONS' && answered !== undefined) return answered
      return routes(event)
    }
    /**
     *
     * Carry h3's own metadata across: `__is_handler__` marks it as a handler,
     * and `__websocket__` is what the upgrade adapter reads.
     *
     **/
    return Object.assign(handler, routes) as EventHandler
  }
}

/** Paths are stored and matched in one form, so `/health` and `health` cannot
 *  both be registered and only one of them answer. */
function normalize(path: string): string {
  const trimmed = path.startsWith('/') ? path : `/${path}`
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

/** A handler bound to one plugin, so a throw inside it can be reported with the
 *  name of what threw rather than as an anonymous 500. */
export function ownedBy(from: string, handler: (event: H3Event) => unknown): EventHandler {
  return defineEventHandler(async (event) => {
    try {
      return await handler(event)
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) throw error
      console.error(`[harness] ${from} failed handling ${event.method} ${event.path}:`, error)
      throw error
    }
  })
}
