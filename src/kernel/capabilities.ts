import type { RouteRecord } from '../http/router.js'
import { pluginCapabilities } from '../plugins/registry.js'
import type { Capability, CapabilityPassport } from '../wire/capabilities.js'

/** Build the safe capability projection for the current route table.
 *
 * The kernel has no tools of its own, but it does own the API that lets a
 * client operate a machine. Keeping it in the same census makes a reference
 * console explain both the base machine and installed extensions in one view.
 */
export function capabilityPassport(routes: RouteRecord[]): CapabilityPassport {
  const kernel: Capability = {
    id: 'harness.kernel',
    title: 'Machine kernel',
    description: 'The persistent agent machine API and lifecycle.',
    owner: { kind: 'kernel', name: 'harness' },
    state: 'ready',
    reason: null,
    requires: { system: [], ports: [] },
    surfaces: {
      tools: [],
      routes: routes
        .filter((route) => route.from === 'kernel')
        .map(({ method, path }) => ({ method, path })),
    },
  }
  return { schemaVersion: 1, capabilities: [kernel, ...pluginCapabilities()] }
}
