import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RegisteredPlugin, SystemDependency } from './define.js'

const run = promisify(execFile)

/**
 * ── Software a plugin needs on the machine ───────────────────────────────────
 *
 * The rule from docs/decisions/0002-own-harness.md, in code: **verify is the contract,
 * install is a convenience.**
 *
 * `verify` is what the daemon trusts, at every boot. `install` is one recipe
 * for reaching that state, and a machine is free to have arrived there another
 * way — a base image that already ships it, an admin who installed it, a
 * different package manager entirely. A plugin that only knew how to install
 * would break on every host it did not anticipate.
 *
 **/

/**
 *
 * A `verify` runs in a SHELL, and that is the contract rather than an
 * implementation detail — `verify` is documented as "a command whose success
 * means the dependency is present", and the command a person writes to ask
 * whether a binary exists is `command -v foo`.
 *
 * It used to be `execFile(...verify.split(' '))`, which spawns the first word
 * as a program and never consults a shell. `command` is a shell BUILTIN, so
 * that spawn depends on whether the host happens to ship a `/usr/bin/command`
 * shim: macOS does (one of fifteen hard links from `shell_cmds`), Debian does
 * not. The `desktop` plugin is the one that wrote the portable idiom, so it
 * verified true on every developer's Mac and false on every machine the image
 * actually ships — four binaries installed by infra/machine/Dockerfile,
 * reported absent, the plugin degraded, and no display, no `/desktop` routes
 * and a headless browser as the visible result.
 *
 * Splitting on a space was the deeper mistake: it made every verify a bare
 * argv, so quoting, a pipe and a builtin were all silently unavailable in a
 * field whose whole job is to state a shell command. Nothing here is user
 * input — every verify string is a literal in a plugin module — so the shell
 * costs nothing it protects against.
 *
 * The machine's OTHER binary probe had it right the whole time:
 * `plugins/packs/pack-tools.ts` runs the same `command -v` through an explicit
 * `shell: '/bin/sh'`. Two places asking one question, and only one of them
 * asking it in a way that works.
 *
 **/
const shell = promisify(exec)

export type Manager = 'apt' | 'brew'

export interface DependencyReport {
  plugin: string
  dependency: SystemDependency
  present: boolean
}

/** Is it actually here? The install recipe is never consulted — only the truth
 *  on this machine, which is the whole point of the split above. */
export async function verifyDependency(dependency: SystemDependency): Promise<boolean> {
  if (dependency.platforms && !dependency.platforms.includes(process.platform)) return false
  try {
    await shell(dependency.verify)
    return true
  } catch {
    return false
  }
}

/** Everything the given plugins declare, with whether it is present. */
export async function inspectDependencies(plugins: RegisteredPlugin[]): Promise<DependencyReport[]> {
  const reports: DependencyReport[] = []
  for (const plugin of plugins) {
    for (const dependency of plugin.system ?? []) {
      reports.push({ plugin: plugin.name, dependency, present: await verifyDependency(dependency) })
    }
  }
  return reports
}

/** Which package manager this host actually has. Detected rather than inferred
 *  from the platform: a Debian container and a Debian-flavoured CI image differ,
 *  and guessing produces a confident failure instead of a clear one. */
async function detectManager(): Promise<Manager | null> {
  for (const manager of ['apt-get', 'brew'] as const) {
    try {
      await run('which', [manager])
      return manager === 'apt-get' ? 'apt' : 'brew'
    } catch {
      /* try the next one */
    }
  }
  return null
}

/** The exact command a recipe would run, or null when it has none for this
 *  host. Returned rather than executed so `install --dry-run` can print it and
 *  a person can decide — installing software is not a thing to do silently. */
export function installCommand(
  dependency: SystemDependency,
  manager: Manager,
): { command: string; args: string[] } | null {
  const recipe = dependency.install
  if (!recipe) return null
  if (manager === 'apt' && recipe.apt?.length) {
    return { command: 'apt-get', args: ['install', '-y', '--no-install-recommends', ...recipe.apt] }
  }
  if (manager === 'brew' && recipe.brew?.length) return { command: 'brew', args: ['install', ...recipe.brew] }
  return null
}

export interface InstallOutcome {
  plugin: string
  id: string
  /** `present` — nothing to do. `installed` — we ran the recipe and verify now
   *  passes. `failed` — the recipe ran and verify still says no, or there was
   *  no recipe for this host. */
  result: 'present' | 'installed' | 'failed'
  detail: string | null
}

/** Install what is missing, then VERIFY again.
 *
 *  Re-verifying is not belt-and-braces: a package manager exiting 0 means it
 *  installed something, not that the thing a plugin needs is now runnable — a
 *  headless Chrome missing a font package is installed and still unusable. The
 *  daemon trusts verify and nothing else, so the installer has to as well. */
export async function installDependencies(
  plugins: RegisteredPlugin[],
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): Promise<InstallOutcome[]> {
  const log = options.log ?? ((message: string) => console.log(message))
  const manager = await detectManager()
  const outcomes: InstallOutcome[] = []

  for (const report of await inspectDependencies(plugins)) {
    const { plugin, dependency } = report
    if (report.present) {
      outcomes.push({ plugin, id: dependency.id, result: 'present', detail: null })
      log(`  ✓ ${dependency.id} — already here`)
      continue
    }

    const recipe = manager ? installCommand(dependency, manager) : null
    if (!recipe) {
      const detail = manager
        ? `no ${manager} recipe — ${dependency.reason}`
        : `no package manager on this host — ${dependency.reason}`
      outcomes.push({ plugin, id: dependency.id, result: 'failed', detail })
      log(`  ✗ ${dependency.id} — ${detail}`)
      continue
    }

    log(`  → ${dependency.id}: ${recipe.command} ${recipe.args.join(' ')}`)
    if (options.dryRun) {
      outcomes.push({ plugin, id: dependency.id, result: 'failed', detail: 'dry run — nothing was installed' })
      continue
    }

    try {
      await run(recipe.command, recipe.args)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      outcomes.push({ plugin, id: dependency.id, result: 'failed', detail })
      log(`  ✗ ${dependency.id} — ${detail}`)
      continue
    }

    const present = await verifyDependency(dependency)
    outcomes.push({
      plugin,
      id: dependency.id,
      result: present ? 'installed' : 'failed',
      detail: present ? null : 'the recipe ran, but the machine still cannot find it',
    })
    log(present ? `  ✓ ${dependency.id} — installed` : `  ✗ ${dependency.id} — installed, but verify still fails`)
  }

  return outcomes
}
