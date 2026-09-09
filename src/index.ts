import { createApp, toNodeListener, type App } from 'h3'
import wsAdapter from 'crossws/adapters/node'
import { createServer, type Server } from 'node:http'
import { RouteTable, type RouteRecord } from './http/router.js'
import { closeHttpServer } from './http/shutdown.js'
import { narrateBoot } from './kernel/boot-narration.js'
import { tell } from './kernel/host-ports.js'
import { setInstallPolicy } from './kernel/install-policy.js'
import { configureStateRoot, defaultStateRoot, resetStateRoot } from './kernel/store.js'
import { configureWorkspaceRoot, defaultWorkspaceRoot, resetWorkspaceRoot } from './kernel/workspace.js'
import { harnessHandler, harnessRoutes, startHarness, stopHarness, type HarnessOptions } from './runtime.js'

/**
 * ── The harness ──────────────────────────────────────────────────────────────
 *
 * One entry point, two ways in: `hoshi-harness serve` (the daemon a machine
 * image runs) and `createHarness()` (the same thing as a library). The second
 * is not an afterthought of the first — it is how a plugin author stands up a
 * harness with ONE plugin and no image, which is the test they actually want
 * (docs/decisions/0002-own-harness.md).
 *
 * What is here today: config, the route table, lifecycle. The kernel and the
 * plugins land on top of it, phase by phase (docs/decisions/0002-own-harness.md) — and
 * until they do, the wire-level census pointed at this daemon prints exactly
 * what is still missing, which is the build order.
 *
 **/

/** How long a request that is mid-flight at shutdown has to finish before its
 *  socket is cut. Short on purpose: the only thing waiting this out is an HTTP
 *  handler, and the machine's slow work (a turn) does not live on the wire. */
const STREAM_GRACE_MS = 2_000
/** The point at which "closing gracefully" becomes "not closing". Comfortably
 *  inside a container runtime's own SIGKILL timeout, so the LAST word on how
 *  this process dies is always ours. */
const SHUTDOWN_DEADLINE_MS = 5_000

/** The route table, plugin registry, and host ports are process-wide today.
 * Claiming that fact at the public seam is safer than allowing two objects to
 * silently share a route table and durable paths. */
let activeHarness: symbol | null = null

export interface HarnessConfig {
  port: number
  host: string
  /** The machine's working root — where checkouts live and turns do their work. */
  workspace: string
  /** Durable state: sessions, messages, provider keys, the spend ledger. */
  state: string
  /** When may this machine install system software for a plugin?
   *
   *  `build-only` is the hardened setting and refuses the runtime route
   *  outright. The permissive setting is still owner-gated and never reachable
   *  from a turn — a daemon that installed whatever a plugin asked for would be
   *  a machine an agent can turn into anything, and the machine user already
   *  has sudo (docs/decisions/0002-own-harness.md). */
  installs: 'build-only' | 'owner'
}

export interface Harness {
  config: HarnessConfig
  /** What this daemon serves, and which part of it owns each endpoint. */
  routes(): RouteRecord[]
  listen(): Promise<{ url: string }>
  close(): Promise<void>
}

/** Defaults chosen to match what a machine image already provides, so a
 *  container needs no flags and a laptop needs two. */
export function resolveConfig(input: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    port: input.port ?? Number(process.env.PORT ?? 4200),
    host: input.host ?? process.env.HOST ?? '127.0.0.1',
    workspace: input.workspace ?? defaultWorkspaceRoot(),
    state: input.state ?? defaultStateRoot(),
    installs: input.installs ?? (process.env.HOSHI_INSTALLS === 'owner' ? 'owner' : 'build-only'),
  }
}

export function createHarness(input: Partial<HarnessConfig> & HarnessOptions = {}): Harness {
  const config = resolveConfig(input)
  const app: App = createApp()
  const owner = Symbol('harness')
  let server: Server | null = null
  let mounted = false

  return {
    config,
    routes: () => harnessRoutes(),

    async listen() {
      if (server) return { url: `http://${config.host}:${config.port}` }
      if (activeHarness && activeHarness !== owner) {
        throw new Error(
          'A Harness is already running in this Node process. Run another Harness in a separate process.',
        )
      }
      activeHarness = owner
      configureWorkspaceRoot(config.workspace)
      configureStateRoot(config.state)

      try {
      /**
       *
       * Plugins come up BEFORE the port is bound. A machine that answers
       * requests while half its surface is still registering would give a
       * client a 404 for something that exists a second later — which is
       * indistinguishable from a feature this version does not have.
       *
       **/
        setInstallPolicy(config.installs)
        await startHarness({
          ...(input.plugins ? { plugins: input.plugins } : {}),
          ...(input.extraPlugins ? { extraPlugins: input.extraPlugins } : {}),
        })
      /**
       *
       * CORS rides inside `harnessHandler()` rather than being mounted here.
       * The Nitro shim mounts that handler directly, and applying the headers
       * only at this call site left the shim serving every route without them —
       * which a browser refuses and nothing else notices.
       *
       **/
        if (!mounted) {
          app.use(harnessHandler())
          mounted = true
        }
        server = createServer(toNodeListener(app))

      /**
       *
       * WebSocket upgrades. Without this the daemon can ROUTE a websocket
       * handler and never actually connect one: the upgrade is an HTTP verb
       * nothing in the request pipeline sees, so it has to be answered on the
       * server itself. It is why the editor bridge, the preview proxy and the
       * voice stream are the last routes still served by Nitro — it was doing
       * exactly this for them.
       *
       **/
        const { handleUpgrade } = wsAdapter({ ...app.websocket })
      /**
       *
       * Wrapped, not passed bare. `handleUpgrade` is async and `.on()` drops
       * the promise it returns, so ANY rejection on the upgrade path — in the
       * adapter or in a plugin's own `upgrade` hook — reaches
       * `process.on('unhandledRejection')` and takes the daemon down with
       * `process.exit(1)` (daemon/resilience.ts). That path is reachable
       * BEFORE a credential is checked: crossws builds `request.url` from the
       * client's `Host` header, so a header Node's parser accepts but `new
       * URL()` rejects (`Host: a b`) is an unauthenticated kill. A failed
       * upgrade must cost that one socket and nothing else.
       *
       **/
        server.on('upgrade', (req, socket, head) => {
          void handleUpgrade(req, socket, head).catch(() => socket.destroy())
        })
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(config.port, config.host, resolve)
        })
        narrateBoot('success', `Listening on ${config.host}:${config.port}`)

      /**
       *
       * AFTER the port is bound, and that ordering is the whole point: whoever
       * answers `listening` wants to be told the machine can be reached NOW —
       * a control plane that probes on a tick, for one — and a probe that
       * arrives before the listener would be answered by nothing. Through the
       * port seam rather than a kernel call, because who is waiting is exactly
       * what the kernel must not assume; `tell` keeps a failing answer from
       * failing the bind.
       *
       * The first answer to it was a Nitro boot plugin that did not survive the
       * move into this package: it sat in the kernel with no caller, and a
       * freshly provisioned machine went back to waiting out a reconcile tick
       * on a boot screen (docs/STRUCTURE_REVIEW.md H-10).
       *
       **/
        tell('listening', (run) => run())
        return { url: `http://${config.host}:${config.port}` }
      } catch (error) {
        server?.close()
        server = null
        await stopHarness().catch(() => {})
        resetWorkspaceRoot()
        resetStateRoot()
        activeHarness = null
        throw error
      }
    },

    async close() {
      if (!server) return
      const closing = server
      server = null

      /** Why this is not a plain `server.close()`, and what the two windows
       *  are for: `./http/shutdown.ts`. */
      try {
        await closeHttpServer(closing, { grace: STREAM_GRACE_MS, deadline: SHUTDOWN_DEADLINE_MS })
      } finally {
        try {
          await stopHarness()
        } finally {
          resetWorkspaceRoot()
          resetStateRoot()
          if (activeHarness === owner) activeHarness = null
        }
      }
    },
  }
}

export { startHarness, stopHarness, harnessHandler, harnessRoutes, pluginStatuses } from './runtime.js'
/** A render-safe, versioned projection of the live machine registry. */
export { capabilityPassport } from './kernel/capabilities.js'

/**
 *
 * NO PLUGIN INTERNALS. This barrel used to re-export sixteen of them —
 * `export * from './plugins/git/git.js'` and fifteen more — which made every
 * symbol in those files part of the package's public API, precisely the
 * invisible dependency graph `pnpm check:harness-barrel` forbids
 * (docs/STRUCTURE_REVIEW.md H-05).
 *
 * The stated reason was that an area still living outside this package needed
 * to speak a plugin's vocabulary. That area is gone — the Nitro host it lived in
 * was strangled and deleted, and its last two imports were `startHarness` and
 * `harnessHandler`. Nothing outside this
 * package imported ANY of the sixteen — they were a public surface with no
 * public, which is the state an escape hatch reaches just before someone builds
 * on it. `scripts/check-harness-barrel.mjs` keeps it shut.
 *
 * A plugin reaches another plugin through the host services the contract passes
 * in, never through here.
 *
 **/

export {
  definePlugin,
  hostBinding,
  isOwnPlugin,
  bindTools,
  defineHoshiTool,
  jsonish,
  z,
  machineToolContext,
} from './plugins/index.js'
export type {
  Plugin,
  CapabilityDeclaration,
  PluginHost,
  PluginToolContext,
  RegisteredPlugin,
  SystemDependency,
  PluginStatus,
  PluginState,
  HoshiToolContext,
  HoshiToolDefinition,
  HoshiToolFactories,
  HoshiToolFactory,
  HoshiToolResult,
  HoshiToolSet,
  MachineCapabilities,
} from './plugins/index.js'

export { RouteTable, RouteConflictError, ownedBy } from './http/router.js'
export type { RouteRecord, Method } from './http/router.js'

/**
 *
 * Consumers in this repo import the SOURCE (`exports` → src/index.ts), the way
 * @hoshi/shared is consumed: a workspace that had to build a package before
 * typechecking the app that uses it is a workspace where one stale `dist` makes
 * every error a lie. `dist` exists for the daemon binary and for publishing —
 * the two places where a built artifact is genuinely what runs.
 *
 **/

export * from './kernel/index.js'
/**
 *
 * Named on top of the star export because a plugin PACKAGE's tests need them
 * by name: the port surface a test installs, and the type it is written
 * against. `ports()` itself stays inside — reading the registry from outside
 * would be a way around whatever installed it (kernel/index.ts).
 *
 **/
export { configureKernel } from './kernel/index.js'
export type { KernelPorts, UnattendedContext } from './kernel/index.js'
