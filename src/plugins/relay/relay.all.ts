import { defineEventHandler, createError } from 'h3'
import type { Peer } from 'crossws'
import { authorizeUpgrade, clearDiscoveryCache, publishProvidersChanged } from '../../kernel/index.js'
import { parseConnectorFrame, RelayCalls, type ConnectorFrame } from './protocol.js'
import { attach, attachedLink, detach, loopbackPort, type RelayLink } from './link.js'
import { proveEndpoint, validateAds } from './discover.js'
import { announceRelayState } from './announce.js'

/**
 * ── The connector's socket ───────────────────────────────────────────────────
 *
 * `ALL /relay`: the one WebSocket a local-models connector holds open. The
 * upgrade is authorized exactly like every other machine surface — the same
 * candidates, the same owner lock (kernel/upgrade-auth.ts) — so "who may share
 * hardware with this machine" is never a second auth system.
 *
 * Everything else is frames (plugins/relay/protocol.ts): the connector says
 * hello with its endpoints, the machine proves them through the tunnel and
 * answers `ready`, and from then on the socket carries multiplexed HTTP until
 * one side goes away.
 *
 **/

function linkOf(peer: Peer): RelayLink | undefined {
  return peer.context.relayLink as RelayLink | undefined
}

async function handleHello(peer: Peer, frame: ConnectorFrame & { t: 'hello' }): Promise<void> {
  const port = loopbackPort()
  const send = (payload: unknown): boolean => {
    try {
      peer.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }
  if (port === null) {
    /**
     *
     * Setup has not bound the forwarder yet — nothing to discover against.
     * Honest refusal per endpoint; the connector retries on its next attach.
     *
     **/
    send({
      t: 'ready',
      endpoints: [],
      failed: frame.endpoints.map((endpoint) => ({ id: endpoint.id, reason: 'the machine is still starting' })),
    })
    return
  }

  const { accepted, failed } = validateAds(frame.endpoints)
  const link: RelayLink = {
    key: peer,
    send,
    close: (code, reason) => {
      try {
        peer.close(code, reason)
      } catch {
        /* already gone */
      }
    },
    connector: {
      name: frame.connector.name.trim().slice(0, 64) || 'connector',
      version: frame.connector.version.trim().slice(0, 32),
    },
    calls: new RelayCalls(),
    /**
     *
     * Provisional: the loopback forwarder only serves advertised ids, and the
     * probes below travel through it — so the ids must exist before they can
     * prove themselves. The ones that fail are pruned again before anything
     * is announced.
     *
     **/
    endpoints: new Map(accepted.map((endpoint) => [endpoint.id, endpoint])),
    providers: [],
    lastSeen: Date.now(),
  }
  peer.context.relayLink = link
  attach(link)
  clearDiscoveryCache()

  const ready: Array<{ id: string; providerId: string; models: number }> = []
  const refused = [...failed]
  for (const endpoint of accepted) {
    const outcome = await proveEndpoint(port, endpoint)
    if ('provider' in outcome) {
      link.providers.push(outcome.provider)
      ready.push({ id: endpoint.id, providerId: endpoint.providerId, models: outcome.provider.models.length })
    } else {
      link.endpoints.delete(endpoint.id)
      refused.push({ id: endpoint.id, reason: outcome.reason })
    }
  }

  /**
   *
   * Discovery awaited the network, and "newest wins" may have run meanwhile.
   * A link that is no longer the attached one announces nothing — its
   * providers are not this machine's any more.
   *
   **/
  if (attachedLink() !== link) return
  send({ t: 'ready', endpoints: ready, failed: refused })
  announceRelayState()
  await publishProvidersChanged(null)
}

function dropLink(peer: Peer, reason: string): void {
  const link = linkOf(peer)
  if (!link) return
  peer.context.relayLink = undefined
  if (!detach(link, reason)) return
  clearDiscoveryCache()
  announceRelayState()
  publishProvidersChanged(null).catch((error) => console.error('[relay] announcing detach failed:', error))
}

export default defineEventHandler({
  websocket: {
    async upgrade(request) {
      /**
       *
       * Nothing here may reject — crossws doesn't catch async hook failures,
       * and an unhandled rejection is process-fatal under the resilience
       * policy (plugins/resilience.ts, scripts/dev-guard.cjs).
       *
       **/
      try {
        if (!(await authorizeUpgrade(request.headers, new URL(request.url)))) {
          return new Response('Unauthorized', { status: 401 })
        }
      } catch {
        return new Response('Unauthorized', { status: 401 })
      }
    },

    async message(peer, message) {
      try {
        const raw =
          typeof message.rawData === 'string' ? message.rawData : new TextDecoder().decode(message.uint8Array())
        const frame = parseConnectorFrame(raw)
        if (!frame) return
        const link = linkOf(peer)
        if (link) link.lastSeen = Date.now()

        if (frame.t === 'hello') {
          /**
           *
           * One hello at a time per socket: discovery awaits the tunnel, and a
           * second hello racing the first would attach two links for one peer.
           *
           **/
          if (peer.context.relayHelloBusy) return
          peer.context.relayHelloBusy = true
          try {
            await handleHello(peer, frame)
          } finally {
            peer.context.relayHelloBusy = false
          }
          return
        }
        if (frame.t === 'pong') return
        if (link && attachedLink() === link) link.calls.handle(frame)
      } catch (error) {
        console.error('[relay] socket frame failed:', error)
      }
    },

    close(peer) {
      dropLink(peer, 'The connector disconnected.')
    },

    error(peer) {
      dropLink(peer, 'The connector connection failed.')
    },
  },

  /**
   *
   * The route is WebSocket-only — a plain request has nothing to talk to.
   *
   **/
  handler: () => {
    throw createError({ statusCode: 426, statusMessage: 'Upgrade Required' })
  },
})
