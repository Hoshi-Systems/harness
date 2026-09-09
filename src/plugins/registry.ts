import type { ToolSet } from 'ai'
import { defineEventHandler, type EventHandler } from 'h3'
import type { MachineEvent } from '../kernel/events.js'
import { apiError } from '../kernel/api-error.js'
import type { RouteTable, Method } from '../http/router.js'
import { extendKernel, ports } from '../kernel/host-ports.js'
import type { KernelPorts } from '../kernel/host-ports.js'
import type { PluginHost, PluginToolContext, RegisteredPlugin, SystemDependency } from './define.js'
import { verifyDependency } from './system.js'

/**
 * ── Starting plugins ─────────────────────────────────────────────────────────
 *
 * The lifecycle from docs/decisions/0002-own-harness.md, and the rule it exists to
 * protect: **a failing plugin never stops the daemon.**
 *
 * A machine whose voice model file is missing still answers chat; a machine
 * whose browser failed to launch still runs every other tool. The failure is
 * loud in exactly one place — each plugin's status, which `machine.state`
 * carries — so a client can say "Browser control is unavailable: Chrome is not
 * installed" instead of a 404 that reads as "this feature does not exist here".
 *
 * `degraded` is also honest about tools: a plugin in that state contributes
 * none. An agent that calls a tool and is told "unavailable" will try three
 * more times and then apologise, which is worse than never having seen it.
 *
 **/

export type PluginState = 'ready' | 'degraded'

export interface PluginStatus {
  name: string
  description: string
  state: PluginState
  /** Why it is degraded, in words a client can show. Null when ready. */
  reason: string | null
}

interface Started {
  plugin: RegisteredPlugin
  status: PluginStatus
  shutdown?: () => void | Promise<void>
  timers: NodeJS.Timeout[]
  tools: Array<{
    build: (context: PluginToolContext) => ToolSet | Promise<ToolSet>
    names: () => string[]
  }>
  replays: Array<(push: (event: MachineEvent) => void) => void | Promise<void>>
}

const started: Started[] = []

/** Is the dependency actually present? The ANSWER comes from `system.ts` — this
 *  only turns it into words a client can show. It carried a second copy of the
 *  check until 2026-08-29, and the copies had not drifted: they were both wrong
 *  the same way. One implementation, because there is one question. */
async function verify(dependency: SystemDependency): Promise<string | null> {
  if (dependency.platforms && !dependency.platforms.includes(process.platform)) {
    return `${dependency.id} is not available on ${process.platform}`
  }
  return (await verifyDependency(dependency)) ? null : `${dependency.id} is not installed — ${dependency.reason}`
}

function hostFor(entry: Started, table: RouteTable): PluginHost {
  const name = entry.plugin.name
  const route =
    (method: Method) =>
    (path: string, handler: Parameters<RouteTable['add']>[3]): void => {
      /**
       *
       * Registered whatever the plugin's state, and gated at REQUEST time.
       *
       * It used to read the state HERE, which made the gate unreachable:
       * registration only happens inside `setup`, and `setup` only runs for a
       * plugin that is already ready. A plugin that threw PART-WAY through
       * setup therefore kept the real handler for whatever it had registered
       * first, while its tools, timers and replays were cleared as
       * untrustworthy — routes being the one thing that survived, against this
       * file's own "half a plugin is not a working one". `voice` opens a model
       * file in setup and registers a WebSocket route, so that was not
       * hypothetical.
       *
       * A plugin degraded by a missing system DEPENDENCY still registers
       * nothing at all, because its setup never runs — see the comment further
       * down for why that is deliberate and why 404 is the right answer there.
       * The two cases differ in what is already true when we find out: before
       * running anything, versus half-way through.
       *
       **/
      table.add(method, path, name, gated(entry, handler))
    }
  return {
    tools: { add: (build, names) => entry.tools.push({ build, names }) },
    routes: {
      get: route('GET'),
      post: route('POST'),
      patch: route('PATCH'),
      put: route('PUT'),
      delete: route('DELETE'),
      all: route('ALL'),
    },
    events: {
      publish: (type, properties) => {
        /**
         *
         * Prefixed, always: the bus is shared, and a plugin that could publish
         * any type at all could impersonate the kernel.
         *
         **/
        void import('../kernel/events.js').then(({ publishMachineEvent }) =>
          publishMachineEvent(`${name}.${type}`, properties),
        )
      },
      onConnect: (replay) => entry.replays.push(replay),
    },
    jobs: {
      every: (intervalMs, job) => {
        const timer = setInterval(() => {
          /**
           *
           * `(async () => job())()`, not `Promise.resolve(job())`: a job that
           * throws SYNCHRONOUSLY never reaches the second form's `.catch` — the
           * throw escapes before there is a promise to attach one to. Here that
           * means an uncaught exception inside a timer callback, which
           * daemon/resilience.ts turns into `process.exit(1)`: one plugin's bad
           * tick, and the machine is gone.
           *
           **/
          void (async () => job())().catch((error) => console.error(`[${name}] job failed:`, error))
        }, intervalMs)
        timer.unref?.()
        entry.timers.push(timer)
      },
      /**
       *
       * QUEUED, not run here. A plugin's `setup` runs while the others are
       * still registering, so a boot job that fires inside it sees a machine
       * that is only half assembled — in particular it sees no port any LATER
       * plugin provides, and `platform` sorts after most of them.
       *
       * That was not theoretical. Three plugins guarded their boot work with
       * `if (!platform()?.machineId) return`, all three sort before `platform`,
       * and all three therefore took the "this machine has no organization"
       * branch on every machine that has one: the spend rollup never started,
       * session grants were never refreshed, and the delegation wake-up pull
       * never ran (docs/STRUCTURE_REVIEW.md H-10). Nothing errored — every one
       * of them is *supposed* to do nothing on a machine with no Platform.
       *
       * "Once, at boot" now means once the machine has booted.
       *
       **/
      once: (job) => {
        bootJobs.push({ name, job })
      },
    },
    log: {
      info: (message, ...rest) => console.log(`[${name}] ${message}`, ...rest),
      error: (message, ...rest) => console.error(`[${name}] ${message}`, ...rest),
    },
    platform: () => ports().platform?.() ?? null,
    /**
     *
     * Read through, like `unattended` below and for the same reason — a proxy
     * rather than a snapshot, so a port answered after this plugin started is
     * still the one it reaches.
     *
     * This is the whole of a plugin's access to what other plugins answer, and
     * it is why `plugins/**` has no business importing `kernel/host-ports`:
     * that module is the kernel's own storage, and a plugin holding a handle on
     * it is a plugin the kernel cannot reorganise around.
     *
     **/
    ports: new Proxy({} as KernelPorts, {
      get: (_target, key: string) => ports()[key as keyof KernelPorts],
      has: (_target, key: string) => key in ports(),
      ownKeys: () => Reflect.ownKeys(ports()),
      getOwnPropertyDescriptor: (_target, key: string) => {
        const value = ports()[key as keyof KernelPorts]
        return value === undefined ? undefined : { value, enumerable: true, configurable: true }
      },
    }),
    provide: (answers) => {
      /**
       *
       * Merged into what is already installed, so plugin order cannot decide
       * whose organization rules survive. The FUNCTION form is for the ports
       * more than one plugin answers — it is handed what is already there, so
       * it can wrap rather than erase (`claimsCompletion` is the case).
       *
       **/
      extendKernel((current) => (typeof answers === 'function' ? answers(current) : { ...current, ...answers }))
    },
    /**
     *
     * Read through, not captured: the host installs its answers at boot, and a
     * plugin that snapshotted them at setup would keep asking a machine that
     * has since been linked to an organization the wrong questions.
     *
     **/
    unattended: {
      notify: (alert) => ports().notify?.(alert),
      mayProceed: async (call) => (await ports().mayProceed?.(call)) ?? { effect: null, ruleId: null },
      spendBlocked: () => ports().spendBlocked?.() ?? false,
      refreshSpend: async () => ports().refreshSpend?.(),
      /**
       *
       * A GETTER, not a value: this object is built while plugins are starting,
       * which is before the host has finished installing its ports — reading
       * once here would freeze "this machine runs no workflows" into a machine
       * that runs plenty. Absence still stays absence rather than becoming a
       * stub that reports failure: "no workflows here" and "the workflow would
       * not start" are different answers a caller has to tell apart.
       *
       **/
      get startWorkflow() {
        const port = ports().startWorkflow
        return port ? (input: Parameters<typeof port>[0]) => port(input) : undefined
      },
      dispatch: async (task) => {
        const dispatch = ports().dispatch
        if (!dispatch) throw new Error('This machine has no dispatcher — unattended work cannot be started here.')
        return dispatch(task)
      },
    },
  }
}

/** What a degraded plugin's route says, in words a client can show. */
function reasonFor(entry: Started): string {
  return entry.status.reason ?? 'This part of the machine is not running.'
}

/**
 *
 * Hold a plugin's route to the plugin's state, checked when the request
 * arrives rather than when the route was registered.
 *
 * 503 rather than 404 on purpose: a 404 reads as "this version does not have
 * that feature" and sends a person looking for an upgrade instead of a cause.
 * The code is `<plugin>.unavailable`, which is what tells a client this is ONE
 * part of the machine and not the machine being replaced — App:Web raises its
 * global maintenance overlay on a 503 that carries no such envelope
 * (`machineErrorCode` in `@hoshi/shared`).
 *
 * The websocket half is the part that needs care, and it is the reason this is
 * not a two-line change. h3 keeps `__is_handler__` and `__websocket__` ON THE
 * HANDLER OBJECT, and a plain wrapper drops both — the mistake
 * `RouteTable.handler`'s own comment records, which silently disabled every
 * websocket route the first time it was made. Carrying them across is not
 * enough either: an upgrade never runs the event handler, so a gate that only
 * wrapped the handler would refuse plain requests and let sockets straight
 * through to a plugin that never finished starting. The `upgrade` hook is
 * where a socket is refused — it is how `voice` already answers 401 — so the
 * gate goes there too.
 *
 **/
interface WebSocketHooks {
  upgrade?: (request: unknown) => unknown
  [hook: string]: unknown
}

function gated(entry: Started, handler: EventHandler): EventHandler {
  const wrapped = defineEventHandler(async (event) => {
    if (entry.status.state !== 'ready') {
      apiError(503, `${entry.plugin.name}.unavailable`, reasonFor(entry))
    }
    return await handler(event)
  })

  /** `__is_handler__`, `__websocket__`, and whatever else h3 hangs on it. */
  Object.assign(wrapped, handler)

  const hooks = (handler as EventHandler & { __websocket__?: WebSocketHooks }).__websocket__
  if (hooks) {
    ;(wrapped as EventHandler & { __websocket__?: WebSocketHooks }).__websocket__ = {
      ...hooks,
      async upgrade(request: unknown) {
        if (entry.status.state !== 'ready') {
          return new Response(reasonFor(entry), { status: 503 })
        }
        return await hooks.upgrade?.(request)
      },
    }
  }
  return wrapped
}

/** Bring up every plugin, in order, contributing into `table`.
 *
 *  Never throws: a plugin that cannot start is recorded and the next one is
 *  tried. What it does NOT do is hide the failure — see `pluginStatuses`. */
/** Boot jobs a plugin asked for, held until every plugin has registered. See
 *  `jobs.once` for why they cannot run where they are declared. */
const bootJobs: Array<{ name: string; job: () => void | Promise<void> }> = []

/**
 *
 * Bring up every plugin, in order, contributing into `table`.
 *
 * `configuration` is keyed by plugin name and reaches each plugin's own
 * `config` parser; a plugin that declares none is handed nothing. A parser that
 * throws makes THAT plugin degraded with its message as the reason, and the
 * rest come up — a machine that refuses to boot because one plugin's port was
 * misspelled is worse than one that says so and runs everything else.
 *
 **/
export async function startPlugins(
  plugins: RegisteredPlugin[],
  table: RouteTable,
  configuration: Record<string, unknown> = {},
): Promise<void> {
  for (const plugin of plugins) {
    const entry: Started = {
      plugin,
      status: { name: plugin.name, description: plugin.description, state: 'ready', reason: null },
      timers: [],
      tools: [],
      replays: [],
    }

    let config: unknown
    try {
      config = plugin.configure(configuration[plugin.name])
    } catch (error) {
      entry.status = { ...entry.status, state: 'degraded', reason: `configuration: ${describe(error)}` }
      console.error(`[harness] plugin ${plugin.name} was configured wrongly:`, error)
      started.push(entry)
      continue
    }

    for (const dependency of plugin.system ?? []) {
      const missing = await verify(dependency)
      if (missing) {
        entry.status = { ...entry.status, state: 'degraded', reason: missing }
        break
      }
    }

    const host = hostFor(entry, table)
    if (entry.status.state === 'ready') {
      try {
        const handle = await plugin.setup(host, config)
        if (handle && typeof handle === 'object' && handle.shutdown) entry.shutdown = handle.shutdown
      } catch (error) {
        entry.status = { ...entry.status, state: 'degraded', reason: describe(error) }
        /**
         *
         * Whatever it managed to register before throwing is not trustworthy:
         * half a plugin is not a working one.
         *
         **/
        for (const timer of entry.timers) clearInterval(timer)
        entry.timers = []
        entry.tools = []
        entry.replays = []
        console.error(`[harness] plugin ${plugin.name} failed to start:`, error)
      }
    } else {
      /**
       *
       * Setup does NOT run. It was tempting to run it anyway so the plugin's
       * routes would exist and could answer 503 with a reason — but setup is
       * where a plugin does its work: launching the browser it is missing,
       * opening the model file that is not there. Running it in a state where
       * its dependency is absent is asking for exactly the failure the check
       * just prevented, and a plugin that logs "ready" while degraded is worse
       * than one that is quietly absent.
       *
       * What a client learns instead is better than a 503 on a path: every
       * plugin's status and REASON ride on `machine.state`, so "Browser
       * control is unavailable: Chromium is not installed" is one read away
       * (kernel/machine-state.ts).
       *
       **/
      console.error(`[harness] plugin ${plugin.name} is degraded: ${entry.status.reason}`)
    }

    started.push(entry)
  }
}

/**
 *
 * The boot work every plugin asked for, dispatched now that the machine is
 * assembled: every plugin has registered, so every port one of them provides is
 * installed, and the runtime has finished extending the kernel — which matters
 * because a boot job may START A TURN (workflow recovery does), and a turn
 * built before `extraTools` was installed would run without any plugin's tools.
 *
 * Not awaited, and each isolated: boot work is a machine catching up — pulling
 * what it missed, mirroring its organization's knowledge — and none of it
 * should hold up the port binding or take another plugin's job down with it.
 *
 **/
export function runBootJobs(): void {
  for (const { name, job } of bootJobs.splice(0)) {
    /** Same reason as `jobs.every` above: a synchronous throw must not escape
     *  into the boot that dispatched it. */
    void (async () => job())().catch((error) => console.error(`[${name}] job failed:`, error))
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every plugin and how it is doing — what `machine.state` carries so a client
 *  can name what is missing instead of guessing from a status code. */
/** Every plugin this harness started, ready or degraded — the list a route
 *  that acts on a plugin BY NAME consults, since what is installed is no
 *  longer one static list (daemon/load.ts). */
export function registeredPlugins(): RegisteredPlugin[] {
  return started.map((entry) => entry.plugin)
}

export function pluginStatuses(): PluginStatus[] {
  return started.map((entry) => ({ ...entry.status }))
}

/** Tools contributed by every READY plugin, for the kernel's tool port.
 *
 *  A contribution that throws costs its own plugin's tools and nothing else:
 *  an unreachable connector must never take the turn down with it. */
export async function pluginTools(context: { sessionId: string; directory: string; agent: string }): Promise<ToolSet> {
  const all: ToolSet = {}
  /** Which plugin claimed each name, so a collision can name both sides the
   *  way `RouteTable` does. */
  const owner = new Map<string, string>()
  for (const entry of started) {
    for (const contribution of entry.tools) {
      try {
        for (const [name, tool] of Object.entries(
          await contribution.build({ ...context, eventNamespace: entry.plugin.name }),
        )) {
          /**
           *
           * First claim wins, and the loser is announced. Merging silently
           * would let one plugin take over another's tool name — and with it
           * that name's permission grant, since the permission store keys on
           * the bare name. The route table refuses the same class of conflict
           * outright; tools can only drop the contribution, because a
           * connector may rename its tools upstream long after boot.
           *
           **/
          const claimed = owner.get(name)
          if (claimed) {
            console.error(
              `[${entry.plugin.name}] refused a tool named "${name}": already contributed by "${claimed}". Two owners for one tool name is not a merge.`,
            )
            continue
          }
          owner.set(name, entry.plugin.name)
          all[name] = tool
        }
      } catch (error) {
        console.error(`[${entry.plugin.name}] failed to contribute tools:`, error)
      }
    }
  }
  return all
}

export function pluginToolNames(): string[] {
  return started.flatMap((entry) => entry.tools.flatMap((contribution) => contribution.names()))
}

/** Each plugin's opening snapshot for a client that has just connected. */
export async function replayPlugins(push: (event: MachineEvent) => void): Promise<void> {
  for (const entry of started) {
    for (const replay of entry.replays) {
      try {
        await replay(push)
      } catch (error) {
        console.error(`[${entry.plugin.name}] failed to replay on connect:`, error)
      }
    }
  }
}

/** Reverse order, so a plugin still has whatever it was built on top of. */
export async function stopPlugins(): Promise<void> {
  for (const entry of [...started].reverse()) {
    for (const timer of entry.timers) clearInterval(timer)
    try {
      await entry.shutdown?.()
    } catch (error) {
      console.error(`[${entry.plugin.name}] failed to shut down:`, error)
    }
  }
  started.length = 0
}
