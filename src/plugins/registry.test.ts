import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { createApp, defineEventHandler, toWebHandler, type EventHandler } from 'h3'
import { configureKernel, ports } from '../kernel/host-ports.js'
import { RouteTable } from '../http/router.js'
import { definePlugin } from './define.js'
import { pluginStatuses, runBootJobs, startPlugins, stopPlugins } from './registry.js'

/**
 * ── When a plugin's boot work is allowed to run ──────────────────────────────
 *
 * Plugins are started one after another, so a plugin's `setup` runs while the
 * others are still registering. Anything it does THERE sees a half-assembled
 * machine — in particular it sees no port any later plugin provides.
 *
 * That is not a hypothetical. `firstParty` is alphabetical, `platform` sorts
 * near the end, and three plugins guarded their boot work with
 * `if (!platform()?.machineId) return`. All three sort before it, so all three
 * took the "this machine has no organization" branch on every machine that has
 * one: the spend rollup never started, session grants were never refreshed, and
 * the delegation wake-up pull never ran. Nothing errored — doing nothing is
 * exactly what each of them is supposed to do on an unlinked machine, so the
 * bug was indistinguishable from correct behaviour (docs/STRUCTURE_REVIEW.md
 * H-10).
 *
 **/

beforeEach(async () => {
  await stopPlugins()
  configureKernel({})
})

/** A plugin that answers `platform`, the way the real one does. */
const provider = definePlugin({
  name: 'zz-platform',
  description: 'answers the platform port, and sorts last on purpose',
  setup(host) {
    host.provide({ platform: () => ({ platformUrl: 'http://p', token: 't', machineId: 'm1', orgId: 'o1' }) })
  },
})

describe('boot jobs', () => {
  it('runs a job AFTER every plugin has registered, so a later plugin`s port is answerable', async () => {
    let seen: string | null | undefined
    const early = definePlugin({
      name: 'aa-early',
      description: 'asks who its Platform is, from a boot job',
      setup(host) {
        host.jobs.once(() => {
          seen = ports().platform?.()?.machineId ?? null
        })
      },
    })

    await startPlugins([early, provider], new RouteTable())
    runBootJobs()
    /** The job is dispatched unawaited, like the real ones. */
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toBe('m1')
  })

  it('does not run it during setup, which is the state that made the bug invisible', async () => {
    const order: string[] = []
    const early = definePlugin({
      name: 'aa-early',
      description: 'records when its boot job ran relative to the other setups',
      setup(host) {
        order.push('setup:aa-early')
        host.jobs.once(() => {
          order.push('job:aa-early')
        })
      },
    })
    const later = definePlugin({
      name: 'bb-later',
      description: 'registers after the job was declared',
      setup() {
        order.push('setup:bb-later')
      },
    })

    await startPlugins([early, later], new RouteTable())
    runBootJobs()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['setup:aa-early', 'setup:bb-later', 'job:aa-early'])
  })

  it('survives a job that throws SYNCHRONOUSLY, which is the shape that escapes a .catch', async () => {
    /**
     *
     * `Promise.resolve(job()).catch(...)` looks like it handles everything and
     * does not: a job that throws before returning throws while the ARGUMENT is
     * being evaluated, so there is no promise yet to attach the handler to. The
     * first version of the deferral had exactly that, and this test is why it
     * does not now — on the interval path the same shape becomes an uncaught
     * exception in a timer callback, which daemon/resilience.ts answers with
     * `process.exit(1)`.
     *
     **/
    let ran = false
    const angry = definePlugin({
      name: 'aa-angry',
      description: 'throws synchronously from its boot job',
      setup(host) {
        host.jobs.once(() => {
          throw new Error('the Platform is not answering')
        })
      },
    })
    const calm = definePlugin({
      name: 'bb-calm',
      description: 'its boot work must still happen',
      setup(host) {
        host.jobs.once(() => {
          ran = true
        })
      },
    })

    await startPlugins([angry, calm], new RouteTable())
    expect(() => runBootJobs()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toBe(true)
  })

  it('does not carry a job from one start into the next', async () => {
    let runs = 0
    const counter = definePlugin({
      name: 'aa-counter',
      description: 'counts how many times its boot job fires',
      setup(host) {
        host.jobs.once(() => {
          runs += 1
        })
      },
    })

    await startPlugins([counter], new RouteTable())
    runBootJobs()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await stopPlugins()
    await startPlugins([provider], new RouteTable())
    runBootJobs()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toBe(1)
  })
})

describe('interval jobs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps ticking after a tick throws synchronously', async () => {
    vi.useFakeTimers()
    let ticks = 0
    const flaky = definePlugin({
      name: 'aa-flaky',
      description: 'its first tick throws',
      setup(host) {
        host.jobs.every(1_000, () => {
          ticks += 1
          if (ticks === 1) throw new Error('not answering yet')
        })
      },
    })

    await startPlugins([flaky], new RouteTable())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(ticks).toBe(3)
  })
})

/**
 * ── What a degraded plugin's route actually answers ──────────────────────────
 *
 * The registry answers 503 for a degraded plugin's route deliberately, so a
 * client can say "unavailable because X" rather than 404 — which would send a
 * person looking for an upgrade instead of a cause.
 *
 * The SHAPE of that answer is load-bearing in a way it did not used to be.
 * App:Web raises its global maintenance overlay on a 503 from a machine, and
 * the only thing separating "this machine is being replaced" from "one part of
 * it is missing" is the error envelope this handler writes
 * (`machineErrorCode` in `@hoshi/shared`, and docs/REMEDIATION.md R26). Drop
 * the code and every degraded plugin blacks out the product; the request would
 * still 503, the reason would still be in the message, and nothing but a person
 * opening the app would notice.
 *
 **/
/**
 * ── What a plugin's routes do once the plugin is degraded ────────────────────
 *
 * Two situations, and they get different answers because different things are
 * already true when we find out.
 *
 * A missing system DEPENDENCY is known before anything runs, so setup is
 * skipped and no route is registered — 404, and the reason rides on
 * `machine.state` where a client reads it once for the whole machine.
 *
 * A throw PART-WAY through setup is found after the plugin has already
 * registered. Its tools, timers and replays are cleared as untrustworthy, and
 * until 2026-08-26 its routes were the one thing that survived — serving a
 * plugin that never finished starting, against this file's own "half a plugin
 * is not a working one". They answer 503 with the reason now.
 *
 * The websocket case is the one worth the care: an upgrade never runs the event
 * handler, so a gate that only wrapped the handler would refuse plain requests
 * and let sockets through. `voice` opens a model file in setup and registers a
 * WebSocket route, which is exactly that shape.
 *
 **/
describe('a degraded plugin’s routes', () => {
  async function call(table: RouteTable, path: string) {
    const app = createApp()
    app.use(table.handler())
    const response = await toWebHandler(app)(new Request(`http://machine.test${path}`))
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null }
  }

  /**
   *
   * A table that also keeps what was registered, so the websocket assertions
   * can reach the handler OBJECT. `RouteRecord` deliberately does not carry it
   * — that listing is served over the wire — so the test captures it on the way
   * in rather than the table growing a field for one caller.
   *
   **/
  function capturing() {
    const table = new RouteTable()
    const handlers = new Map<string, EventHandler & { __websocket__?: Record<string, unknown> }>()
    const add = table.add.bind(table)
    table.add = (method, path, from, handler) => {
      handlers.set(path, handler)
      add(method, path, from, handler)
    }
    return { table, handlers }
  }

  const missingDependency = definePlugin({
    name: 'needy',
    description: 'wants software this machine does not have',
    system: [{ id: 'nothing-is-installed-here', reason: 'nothing needs it', verify: 'exit 1' }],
    setup(host) {
      host.routes.get(
        '/needy',
        defineEventHandler(() => ({ ok: true })),
      )
    },
  })

  /** Registers first, then fails — the shape that used to keep a live route. */
  const brittle = definePlugin({
    name: 'brittle',
    description: 'registers, then throws',
    setup(host) {
      host.routes.get(
        '/brittle',
        defineEventHandler(() => ({ ok: true })),
      )
      host.routes.all(
        '/brittle/stream',
        defineEventHandler({
          websocket: {
            async upgrade() {
              return undefined
            },
            message() {},
          },
          handler: () => ({ ok: true }),
        }),
      )
      throw new Error('the model file is not there')
    },
  })

  it('a missing dependency registers no routes at all — setup never runs', async () => {
    const table = new RouteTable()
    await startPlugins([missingDependency], table)
    expect(table.list().map((route) => route.path)).not.toContain('/needy')
    expect((await call(table, '/needy')).status).toBe(404)
  })

  it('starts a plugin whose dependency IS here, even when the check is a shell builtin', async () => {
    /**
     *
     * The other direction, and the one that actually shipped broken: a plugin
     * declared present, degraded anyway, with a perfectly well-formed reason
     * saying its installed binaries were missing (`plugins/system.ts`).
     *
     * Which is why the census could not see it: it asserts a degraded plugin
     * gives a REASON, never that the reason is true.
     *
     **/
    const table = new RouteTable()
    const shellVerified = definePlugin({
      name: 'present',
      description: 'declares a dependency this machine really has',
      system: [{ id: 'a-builtin', reason: 'the shell is the contract', verify: 'command -v sh' }],
      setup(host) {
        host.routes.get(
          '/present',
          defineEventHandler(() => ({ ok: true })),
        )
      },
    })

    await startPlugins([shellVerified], table)
    expect(pluginStatuses().find((p) => p.name === 'present')).toMatchObject({ state: 'ready', reason: null })
    expect((await call(table, '/present')).status).toBe(200)
  })

  it('a route registered before the throw answers 503, not the real handler', async () => {
    const table = new RouteTable()
    await startPlugins([brittle], table)
    const { status, body } = await call(table, '/brittle')
    expect(status).toBe(503)
    /** Exactly where `machineErrorCode` looks, so a client tells this from an
     *  outage and does not black the whole product out. */
    expect((body?.data as { code?: string })?.code).toBe('brittle.unavailable')
    expect(String(body?.statusMessage ?? body?.message)).toContain('the model file is not there')
  })

  it('the route still EXISTS — a 404 would read as "this version lacks the feature"', async () => {
    const table = new RouteTable()
    await startPlugins([brittle], table)
    expect(table.list().map((route) => route.path)).toContain('/brittle')
  })

  it('keeps h3’s websocket metadata — a plain wrapper drops it and the socket silently dies', async () => {
    /**
     *
     * This is the assertion that fails if the gate is written as a naive
     * wrapper. h3 hangs `__websocket__` on the handler OBJECT; losing it does
     * not error anywhere, it just stops the route being a websocket at all —
     * the mistake `RouteTable.handler`'s comment records from the first time.
     *
     **/
    const { table, handlers } = capturing()
    await startPlugins([brittle], table)
    const registered = handlers.get('/brittle/stream')
    expect(registered).toBeDefined()
    expect(registered?.__websocket__).toBeDefined()
    expect(Object.keys(registered?.__websocket__ ?? {})).toContain('message')
    /** And it is still a handler h3 will accept. */
    expect((registered as { __is_handler__?: boolean })?.__is_handler__).toBe(true)
  })

  it('refuses the UPGRADE too, because a socket never runs the event handler', async () => {
    const { table, handlers } = capturing()
    await startPlugins([brittle], table)
    const hooks = handlers.get('/brittle/stream')?.__websocket__ as
      { upgrade?: (request: unknown) => Promise<Response | undefined> } | undefined
    const refused = await hooks?.upgrade?.({})
    expect(refused?.status).toBe(503)
    expect(await refused?.text()).toContain('the model file is not there')
  })
})
