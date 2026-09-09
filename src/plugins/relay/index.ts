import { definePlugin } from '../define.js'
import { clearDiscoveryCache, publishProvidersChanged } from '../../kernel/index.js'
import { startLoopbackForwarder } from './loopback.js'
import { attachedLink, detach, setForwarderPort } from './link.js'
import { announceRelayState, replayRelayState, setAnnouncer } from './announce.js'
import route_relay_all from './relay.all.js'

/**
 * ── Local models over the machine's reverse tunnel ───────────────────────────
 *
 * The person's own Ollama or LM Studio, used from their machine in the cloud.
 * The direction is the whole design: their computer sits behind NAT, so a
 * connector there dials OUT to this machine's ingress (`ALL /relay`), and the
 * machine forwards model traffic back down that socket — no inbound
 * connection to their network, no exposed local port, no third-party tunnel.
 *
 * The pieces: the socket (relay.all.ts), the frame vocabulary and multiplexer
 * (protocol.ts), the loopback listener the engine sends requests to
 * (loopback.ts), attach-time discovery (discover.ts), and the one attached
 * link everything shares (link.ts). Providers reach the kernel through the
 * `relayProviders` port — live while the socket is, gone the moment it drops.
 *
 **/

const PING_EVERY_MS = 30_000

/** Three missed heartbeats. A half-open socket (laptop lid, NAT timeout)
 *  otherwise looks attached forever, offering models that can never answer. */
const STALE_AFTER_MS = 90_000

export default definePlugin({
  name: 'relay',
  description: "Local models tunnelled from the owner's own computer — Ollama, LM Studio, vLLM",

  async setup(host) {
    const forwarder = await startLoopbackForwarder()
    setForwarderPort(forwarder.port)
    setAnnouncer(host.events.publish)
    host.events.onConnect(replayRelayState)
    host.provide({ relayProviders: async () => attachedLink()?.providers ?? [] })
    host.routes.all('/relay', route_relay_all)

    host.jobs.every(PING_EVERY_MS, () => {
      const link = attachedLink()
      if (!link) return
      if (Date.now() - link.lastSeen > STALE_AFTER_MS) {
        link.close(4001, 'no heartbeat')
        if (detach(link, 'The connector stopped answering heartbeats.')) {
          clearDiscoveryCache()
          announceRelayState()
          void publishProvidersChanged(null).catch((error) =>
            console.error('[relay] announcing stale detach failed:', error),
          )
        }
        return
      }
      link.send({ t: 'ping' })
    })

    return {
      async shutdown() {
        const link = attachedLink()
        if (link) {
          link.close(1001, 'machine shutting down')
          detach(link, 'The machine is shutting down.')
        }
        setForwarderPort(null)
        setAnnouncer(null)
        await forwarder.close()
      },
    }
  },
})
