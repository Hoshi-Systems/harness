#!/usr/bin/env node
import { capabilityPassport, createHarness, harnessRoutes, resolveConfig, startHarness } from '../index.js'
import { firstParty } from '../plugins/index.js'
import { guardProcess } from './resilience.js'
import { inspectDependencies, installDependencies } from '../plugins/system.js'
import { loadPluginModules, pluginSpecifiers } from './load.js'
import type { RegisteredPlugin } from '../plugins/define.js'

/**
 * ── hoshi-harness ────────────────────────────────────────────────────────────
 *
 * The daemon's front door. Deliberately thin: everything it can do is something
 * `createHarness()` can do, so nothing is reachable only through the CLI and
 * nothing has to be re-tested through a subprocess.
 *
 * Flags beat environment beats config file, because that is the order of who is
 * closest to the problem: a container is configured by environment, and a person
 * debugging one reaches for a flag.
 *
 **/

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index !== -1 && argv[index + 1]) return argv[index + 1]
  const inline = argv.find((entry) => entry.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

/**
 *
 * Plugins from OUTSIDE this package — `--plugins-from a,b` or `HOSHI_PLUGINS`,
 * the flag replacing the variable rather than adding to it, because that is
 * what "flags beat environment" means for a list (daemon/load.ts).
 *
 * Every command loads them, not only `serve`: `install` and `doctor` answer
 * for the plugins a machine WILL run, and `routes` lists what it serves, and
 * all three would show a smaller machine than the one that boots otherwise.
 *
 **/
async function loaded(argv: string[]): Promise<RegisteredPlugin[]> {
  const specifiers = pluginSpecifiers(flag(argv, 'plugins-from') ?? process.env.HOSHI_PLUGINS)
  const modules = await loadPluginModules(specifiers)
  for (const { specifier, plugins } of modules) {
    console.log(`[harness] loaded ${plugins.length} plugin(s) from ${specifier}`)
  }
  return modules.flatMap((module) => module.plugins)
}

async function serve(argv: string[]): Promise<void> {
  const port = flag(argv, 'port')
  const config = resolveConfig({
    ...(port ? { port: Number(port) } : {}),
    ...(flag(argv, 'host') ? { host: flag(argv, 'host')! } : {}),
    ...(flag(argv, 'workspace') ? { workspace: flag(argv, 'workspace')! } : {}),
    ...(flag(argv, 'state') ? { state: flag(argv, 'state')! } : {}),
  })

  /**
   *
   * The port this daemon actually bound, published to its own process so
   * anything that must recognise the machine's own listener agrees with reality
   * rather than guessing. `plugins/services` reserves `PORT ?? NITRO_PORT ??
   * 4200`, which is right for the image (its entrypoint passes no `--port`) and
   * wrong for every other way of starting one — and being wrong there means the
   * machine reports its OWN port as a user's, which is a stray "port opened"
   * notification at best and, since idle sleep reads the same list, a machine
   * that can never be quiet at worst.
   *
   **/
  process.env.PORT = String(config.port)

  guardProcess()
  const extraPlugins = await loaded(argv)
  const harness = createHarness({ ...config, extraPlugins })
  const { url } = await harness.listen()
  console.log(`[harness] listening on ${url} — workspace ${config.workspace}, state ${config.state}`)

  /**
   *
   * A daemon that ignores SIGTERM is a container that takes 10 seconds to stop
   * and loses whatever the last turn was writing.
   *
   * Once only: a second signal arriving mid-shutdown (an impatient operator,
   * a process manager that sends SIGINT then SIGTERM) must not start a second
   * teardown over the top of the first.
   *
   **/
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      void harness.close().then(() => process.exit(0))
    })
  }
}

async function routes(argv: string[]): Promise<void> {
  /**
   *
   * "Which part of this daemon owns that endpoint" answered without grepping —
   * the reason the route table records an owner at all.
   *
   * Plugins are started first, because half of the answer is theirs: a listing
   * that skipped them would show a smaller machine than the one that runs.
   *
   **/
  await startHarness({ extraPlugins: await loaded(argv) })
  for (const route of harnessRoutes()) {
    console.log(`${route.method.padEnd(6)} ${route.path.padEnd(40)} ${route.from}`)
  }
  process.exit(0)
}

/** The same render-safe inventory served at GET /capabilities, useful before a
 * machine binds a port or when an operator is connected only by a shell. */
async function capabilities(argv: string[]): Promise<void> {
  await startHarness({ extraPlugins: await loaded(argv) })
  console.log(JSON.stringify(capabilityPassport(harnessRoutes()), null, 2))
  process.exit(0)
}

/** Which plugins a command is talking about. `--plugins a,b` narrows it;
 *  absent means everything this machine runs — what the harness ships plus
 *  whatever was loaded from outside. */
async function selected(argv: string[]): Promise<RegisteredPlugin[]> {
  const all = [...firstParty, ...(await loaded(argv))]
  const wanted = pluginSpecifiers(flag(argv, 'plugins'))
  return wanted.length ? all.filter((plugin) => wanted.includes(plugin.name)) : all
}

/** Put the software this machine's plugins need ON the machine.
 *
 *  Meant for an image BUILD — one layer, cached, deterministic, and no root in
 *  the running container (docs/decisions/0002-own-harness.md). Exits non-zero when
 *  something is still missing afterwards, so a Dockerfile fails at build time
 *  rather than shipping a machine whose browser plugin is quietly degraded. */
async function install(argv: string[]): Promise<void> {
  const plugins = await selected(argv)
  const dryRun = argv.includes('--dry-run')
  console.log(`[harness] system dependencies for ${plugins.length} plugin(s)${dryRun ? ' (dry run)' : ''}`)
  const outcomes = await installDependencies(plugins, { dryRun })
  const failed = outcomes.filter((outcome) => outcome.result === 'failed')
  if (failed.length > 0 && !dryRun) {
    console.error(`[harness] ${failed.length} dependency(ies) still missing`)
    process.exit(1)
  }
  process.exit(0)
}

/** What this machine is missing, without changing anything. The question a
 *  person asks when a plugin says it is degraded and they want to know why. */
async function doctor(argv: string[]): Promise<void> {
  const reports = await inspectDependencies(await selected(argv))
  if (reports.length === 0) console.log('No plugin on this machine needs anything installed.')
  for (const report of reports) {
    console.log(
      `${report.present ? '✓' : '✗'} ${report.dependency.id.padEnd(20)} ${report.plugin.padEnd(14)} ${report.present ? '' : report.dependency.reason}`,
    )
  }
  process.exit(reports.some((report) => !report.present) ? 1 : 0)
}

/**
 *
 * `hoshi-harness --port 4200` means serve. Requiring the verb would make the
 * common case the verbose one, and a bare flag is what every process manager
 * that starts this will pass.
 *
 **/
const args = process.argv.slice(2)
const [command, argv] = args[0] && !args[0].startsWith('--') ? [args[0], args.slice(1)] : ['serve', args]

switch (command) {
  case 'serve':
    await serve(argv)
    break
  case 'routes':
    await routes(argv)
    break
  case 'capabilities':
    await capabilities(argv)
    break
  case 'install':
    await install(argv)
    break
  case 'doctor':
    await doctor(argv)
    break
  default:
    console.error(`Unknown command "${command}". Try: serve | routes | capabilities | install | doctor`)
    process.exit(1)
}
