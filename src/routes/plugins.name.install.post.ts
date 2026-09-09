import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../kernel/index.js'
import { registeredPlugins } from '../plugins/registry.js'
import { installDependencies } from '../plugins/system.js'
import { installPolicy } from '../kernel/install-policy.js'

/** Install what a plugin needs, now, on a machine that is already running.
 *
 *  Deliberately NOT automatic, and deliberately not reachable from a turn: the
 *  owner asks for it by name. A daemon that installed whatever a plugin
 *  declared, whenever a tool call wanted it, would be a machine an agent can
 *  turn into anything — and the machine user already has sudo, so the only
 *  thing standing between "install a browser" and "install anything" is that a
 *  person asked (docs/decisions/0002-own-harness.md).
 *
 *  A hardened deployment sets `installs: "build-only"` and this refuses
 *  outright: everything its plugins need went into the image, where it is one
 *  cached layer and no root at runtime.
 *
 *  Taking effect needs a restart, and the response says so rather than
 *  pretending: a plugin's `setup` ran at boot and decided it was degraded, and
 *  nothing re-runs it mid-flight. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  if (installPolicy() !== 'owner') {
    apiError(403, 'install.buildOnly', 'This machine installs plugin dependencies at build time only.')
  }

  const name = getRouterParam(event, 'name') ?? ''
  const plugin = registeredPlugins().find((entry) => entry.name === name)
  if (!plugin) apiError(404, 'plugin.notFound', `No plugin "${name}" on this machine.`)
  if (!plugin.system?.length) return { installed: [], restartRequired: false }

  const outcomes = await installDependencies([plugin])
  const failed = outcomes.filter((outcome) => outcome.result === 'failed')
  return {
    installed: outcomes,
    restartRequired: outcomes.some((outcome) => outcome.result === 'installed'),
    ...(failed.length > 0 ? { failed: failed.length } : {}),
  }
})
