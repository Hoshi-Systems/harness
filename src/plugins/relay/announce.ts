import type { MachineEvent } from '../../kernel/index.js'
import { attachedLink } from './link.js'

/**
 * ── Telling clients about the tunnel ─────────────────────────────────────────
 *
 * `relay.state` on the machine bus: whether a connector is attached and what
 * it carries. Its own module because the WebSocket route needs to announce and
 * only the plugin entry holds `host.events` — the setter is installed at
 * setup, before any socket can exist.
 *
 **/

let publish: ((type: string, properties: Record<string, unknown>) => void) | null = null

export function setAnnouncer(fn: typeof publish): void {
  publish = fn
}

function relayStateProperties(): Record<string, unknown> {
  const link = attachedLink()
  return {
    connected: !!link,
    connector: link ? link.connector : null,
    endpoints: link
      ? [...link.endpoints.values()].map((endpoint) => ({
          id: endpoint.id,
          providerId: endpoint.providerId,
          name: endpoint.name,
          models: link.providers.find((provider) => provider.id === endpoint.providerId)?.models.length ?? 0,
        }))
      : [],
  }
}

/** Publish the current snapshot (as `relay.state` — the host prefixes). */
export function announceRelayState(): void {
  publish?.('state', relayStateProperties())
}

/** The snapshot a freshly connected `/events` client is handed, so its mirror
 *  is complete before anything changes. */
export function replayRelayState(push: (event: MachineEvent) => void): void {
  push({ type: 'relay.state', properties: relayStateProperties() })
}
