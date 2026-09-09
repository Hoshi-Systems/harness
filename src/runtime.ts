import type { EventHandler } from 'h3'
import { extendKernel } from './kernel/host-ports.js'
import { RouteTable, type RouteRecord } from './http/router.js'
import { registerKernelRoutes } from './routes/index.js'
import { narrateBoot, resetBootNarration } from './kernel/boot-narration.js'
import { settleInterruptedMessages } from './kernel/messages.js'
import { catalogueAge, refreshCatalogue } from './kernel/providers.js'
import { assertSessionSecretConfigured } from './kernel/session-secret.js'
import { assertOwnerLockConfigured } from './kernel/auth.js'
import { watchSessionTitles } from './kernel/session-titles.js'
import { WORKSPACE_ROOT } from './kernel/workspace.js'
import { mkdir } from 'node:fs/promises'
import {
  pluginStatuses,
  pluginToolNames,
  pluginTools,
  replayPlugins,
  registeredPlugins,
  runBootJobs,
  startPlugins,
  stopPlugins,
} from './plugins/registry.js'
import { firstParty } from './plugins/index.js'
import type { RegisteredPlugin } from './plugins/define.js'

/**
 * ── Bringing a harness up ────────────────────────────────────────────────────
 *
 * One place where the three halves meet: the kernel's routes, the plugins, and
 * the ports that let the second contribute to the first.
 *
 * It is module-level state rather than an object the caller threads around,
 * because the package's two entry points reach the same runtime from different
 * files: `startHarness` brings it up and `harnessHandler` mounts it, and
 * neither can be handed the other's local.
 *
 **/

let table: RouteTable | null = null
let booting: Promise<void> | null = null
export interface HarnessOptions {
  /** Which plugins to run, by name. Absent means all the first-party ones. */
  plugins?: string[]
  /** Plugins that are not first-party — a test's own, or one somebody is
   *  writing. This is what makes "stand up a harness with ONE plugin" a real
   *  thing rather than a promise in a document (docs/decisions/0002-own-harness.md). */
  extraPlugins?: RegisteredPlugin[]
  /**
   *
   * Configuration, keyed by plugin name.
   *
   * Each plugin's own `config` parser is handed its entry — `undefined` when
   * there is none — and what it returns is what `setup` receives. A parser that
   * throws degrades THAT plugin with its message, rather than refusing the
   * whole boot: one misspelled port is not a reason for a machine to be down.
   *
   **/
  pluginConfig?: Record<string, unknown>
}

/** How stale the open model catalogue may be before boot refetches it. A day:
 *  models.dev moves in days, and a machine that refetched on every boot would
 *  hammer it for nothing. */
const CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The machine's own housekeeping, before it serves anything.
 *
 *  Each of these arrived as a boot plugin and is the daemon's now, because each
 *  is the DAEMON's: a session secret that is missing has to
 *  stop the machine, not a route; a workspace that does not exist yet is not a
 *  request's problem; and a client should never be the thing that triggers the
 *  catalogue's first fetch. */
async function houseKeeping(): Promise<void> {
  /**
   *
   * A fresh process is a fresh story. The narration is the machine's own half
   * of the boot log a client renders — the Platform's half can only describe
   * requesting a container and probing a port, and its last line ("Machine is
   * ready") is where the user's wait often begins.
   *
   * It is narrated HERE and not in a plugin because these are the daemon's own
   * steps. It went silent for a while: the narration lived in a Nitro boot
   * plugin, that plugin was deleted with the app, and `narrateBoot` came across
   * into the package with no caller — so `machine.boot.snapshot` answered every
   * connecting client with an empty list and nothing anywhere raised an error
   * (docs/STRUCTURE_REVIEW.md H-10).
   *
   **/
  resetBootNarration()
  narrateBoot('info', 'Starting up')

  /**
   *
   * Loudly, and before anything serves: a machine that accepts requests with no
   * way to verify a token is a machine that authorizes nobody, or everybody.
   *
   **/
  assertSessionSecretConfigured()
  assertOwnerLockConfigured()

  await mkdir(WORKSPACE_ROOT, { recursive: true }).catch((error) =>
    console.error(`[harness] could not create ${WORKSPACE_ROOT}:`, error),
  )

  /**
   *
   * A session names itself after its first exchange. Watching rather than
   * ticking: the machine already says when a turn settles.
   *
   **/
  watchSessionTitles()

  /**
   *
   * Best-effort and unawaited: a machine with no network still boots, it just
   * offers whatever catalogue it cached last.
   *
   **/
  void (async () => {
    const age = await catalogueAge()
    if (age !== null && age < CATALOGUE_MAX_AGE_MS) return
    /**
     *
     * Narrated because it is the one boot step that can take a while: it is a
     * network fetch, and this is precisely the stretch a user spends on a boot
     * screen wondering what the machine is doing.
     *
     **/
    narrateBoot('info', 'Fetching the model catalogue')
    await refreshCatalogue()
      .then(() => narrateBoot('success', 'Model catalogue is up to date'))
      .catch((error) => {
        console.error('[harness] could not refresh the catalogue:', error)
        narrateBoot('error', 'Could not refresh the model catalogue — using the last one it cached')
      })
  })()
}

async function boot(options: HarnessOptions): Promise<void> {
  await houseKeeping()

  /**
   *
   * Before anything can read a transcript: a turn that died with the previous
   * process leaves a message nothing will ever finish (kernel/messages.ts).
   *
   **/
  const interrupted = await settleInterruptedMessages()
  if (interrupted > 0) {
    console.log(`[harness] settled ${interrupted} turn(s) a restart interrupted`)
    narrateBoot('info', `Settled ${interrupted} turn(s) a restart interrupted`)
  }

  const built = new RouteTable()
  registerKernelRoutes(built)

  const wanted = [
    ...(options.plugins ? firstParty.filter((plugin) => options.plugins!.includes(plugin.name)) : firstParty),
    ...(options.extraPlugins ?? []),
  ]
  /**
   *
   * Loudly, and before anything starts: a name names ONE plugin. Two under the
   * same name would share an event prefix, so a client could not tell whose
   * event it was reading, and `machine.state` would carry one status for two
   * things. It is an operator's mistake rather than a plugin's failure — the
   * same package loaded twice, or an external plugin shadowing a built-in —
   * so it stops the boot rather than degrading a plugin, which would report
   * the wrong one.
   *
   **/
  const seen = new Set<string>()
  for (const plugin of wanted) {
    if (seen.has(plugin.name)) {
      throw new Error(
        `Two plugins are named "${plugin.name}". A name names one plugin: is the same package loaded twice?`,
      )
    }
    seen.add(plugin.name)
  }
  await startPlugins(wanted, built, options.pluginConfig)

  /**
   *
   * What came up, and what came up degraded. A degraded plugin names its own
   * reason ("chromium is not installed"), which is the difference between a
   * client showing a missing feature and a client showing nothing.
   *
   **/
  const statuses = pluginStatuses()
  const degraded = statuses.filter((status) => status.state === 'degraded')
  narrateBoot('success', `${statuses.length - degraded.length} of ${statuses.length} plugins ready`)
  for (const status of degraded)
    narrateBoot('error', `${status.name} is degraded: ${status.reason ?? 'no reason given'}`)

  /**
   *
   * Plugins answer the same ports the host does, so they compose rather than
   * replace: a machine that registered its own tools keeps them, and the
   * plugins' land beside them (kernel/ports.ts).
   *
   **/
  extendKernel((current) => ({
    ...current,
    extraTools: async (context) => ({ ...(await current.extraTools?.(context)), ...(await pluginTools(context)) }),
    extraToolNames: () => [...(current.extraToolNames?.() ?? []), ...pluginToolNames()],
    pluginStatuses,
    replayOnConnect: async (push) => {
      await current.replayOnConnect?.(push)
      await replayPlugins(push)
    },
  }))

  table = built

  /**
   *
   * LAST, and after the kernel has been extended. A plugin's "once at boot" job
   * runs against the assembled machine — every port answered, every plugin's
   * tools installed — rather than against whatever existed at the moment it was
   * declared. Workflow recovery starts turns from here; a turn built before
   * `extraTools` landed would run with none of the plugins' tools.
   *
   **/
  runBootJobs()
}

/** Start the harness once. Repeat calls await the first. */
export function startHarness(options: HarnessOptions = {}): Promise<void> {
  booting ??= boot(options)
  return booting
}

export async function stopHarness(): Promise<void> {
  await stopPlugins()
  table = null
  booting = null
}

/** Everything this harness serves — the kernel's routes and every plugin's,
 *  each carrying the name of what owns it. */
export function harnessRoutes(): RouteRecord[] {
  return table?.list() ?? []
}

/** The whole surface as one h3 handler. Non-preemptive: a path nothing here
 *  owns returns undefined, so a host with routes of its own carries on to them.
 *  That is what let one host serve the machine's routes beside its own while
 *  the wire moved across, and it is why the daemon can mount this handler
 *  without owning every path (docs/decisions/0002-own-harness.md). */
export function harnessHandler(): EventHandler {
  if (!table) throw new Error('startHarness() has not finished — nothing is mounted yet.')
  return table.handler()
}

export { pluginStatuses, registeredPlugins }
