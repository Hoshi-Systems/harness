import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isOwnPlugin } from '../plugins/define.js'
import type { RegisteredPlugin } from '../plugins/define.js'

/**
 * ── Loading plugins from outside the package ─────────────────────────────────
 *
 * The harness ships the plugins a machine needs to be a machine. What a
 * machine does because it belongs to somebody — an organization's policy, its
 * spend, the work it is handed — is a plugin package of its own, loaded here
 * at boot (docs/decisions/0009-open-harness.md).
 *
 * A specifier is a path (`./plugins/dist/index.js`, absolute or relative to
 * the daemon's working directory) or a bare package name, resolved the way
 * node would resolve it FROM that directory — so an image that installs the
 * plugin package beside the harness names it, and a checkout points at a
 * file. The module's default export, or its `plugins` export, is the list.
 *
 * ONE HARNESS. Every plugin must have been defined by the `definePlugin` of
 * the very module instance that is running — see `isOwnPlugin` for what goes
 * wrong otherwise, and why nothing else would notice. The error names the
 * cause rather than the symptom, because the symptom is "the plugin says
 * ready and does nothing", which is the worst kind.
 *
 **/

export interface LoadedPlugins {
  specifier: string
  plugins: RegisteredPlugin[]
}

export async function loadPluginModules(specifiers: string[], from = process.cwd()): Promise<LoadedPlugins[]> {
  const loaded: LoadedPlugins[] = []
  for (const specifier of specifiers) {
    const url = resolve(specifier, from)
    const module = (await import(url)) as { default?: unknown; plugins?: unknown }
    const list = module.default ?? module.plugins
    if (!Array.isArray(list)) {
      throw new Error(
        `${specifier} does not export a plugin list. A plugin package's default export (or its \`plugins\` export) is an array of definePlugin() results.`,
      )
    }
    for (const plugin of list) {
      if (isOwnPlugin(plugin)) continue
      const name = typeof plugin === 'object' && plugin && 'name' in plugin ? String(plugin.name) : '(unnamed)'
      throw new Error(
        `${specifier} exports "${name}", which was defined by a different copy of @hoshi/harness than the one running. ` +
          'A plugin registers with the kernel it imports, so a second copy would register with a kernel nothing serves. ' +
          "Make the plugin package resolve @hoshi/harness to this daemon's own — one install, one instance.",
      )
    }
    loaded.push({ specifier, plugins: list as RegisteredPlugin[] })
  }
  return loaded
}

/** Split the comma-separated list a flag or an environment variable carries. */
export function pluginSpecifiers(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function resolve(specifier: string, from: string): string {
  /**
   *
   * A specifier that names a file that exists is that file — `dist/index.js`
   * as readily as `./dist/index.js`. Only what names nothing on disk is tried
   * as a package, so a typo in a path fails as "no such package" rather than
   * loading a package that happens to share its first segment.
   *
   **/
  const asPath = path.resolve(from, specifier)
  if (specifier.startsWith('.') || path.isAbsolute(specifier) || existsSync(asPath)) {
    return pathToFileURL(asPath).href
  }
  /**
   *
   * A bare name resolves from `from`, not from this file: the daemon may be
   * installed anywhere, and the plugin package is wherever the operator put
   * it beside the harness. `createRequire` is node's own lookup, walked from a
   * file that need not exist, which is what makes a directory usable as the
   * starting point at all.
   *
   **/
  const require = createRequire(path.join(from, '__hoshi_plugins__.js'))
  return pathToFileURL(require.resolve(specifier)).href
}
