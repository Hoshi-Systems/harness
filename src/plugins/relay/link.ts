import type { Provider } from '../../kernel/index.js'
import { RelayCalls, type MachineFrame } from './protocol.js'

/**
 * ── The one attached connector ───────────────────────────────────────────────
 *
 * Module state shared by the three parts of the relay that may not import each
 * other's owners: the WebSocket route attaches and detaches links, the
 * loopback forwarder sends requests down whichever link is live, and the
 * plugin entry answers the kernel's `relayProviders` port from it.
 *
 * Deliberately in-process memory, against the machine's own durable-state
 * rule, because this state is the LIFETIME OF A SOCKET: persisting it would
 * manufacture exactly the stale row — models offered on a dead loopback port —
 * that keeping it live-only makes impossible (design.md §3).
 *
 * At most one link exists. A second attach replaces the first (newest wins,
 * design.md §5), and `detach` is idempotent because crossws can report the
 * same peer through both `error` and `close`.
 *
 **/

export interface RelayEndpoint {
  /** The id the connector advertised — what `req` frames name. */
  id: string
  /** The provider id the machine registered it under (`local-<id>`). */
  providerId: string
  name: string
}

export interface RelayLink {
  /** The peer this link rides on. Identity only, never called — it is what
   *  lets a RE-hello on the same socket replace its own link without the
   *  "newest wins" rule closing the very connection it is arriving on. */
  key: unknown
  /** True when the frame left; false when the socket is already unusable. */
  send(frame: MachineFrame): boolean
  close(code: number, reason: string): void
  connector: { name: string; version: string }
  calls: RelayCalls
  /** Advertised endpoints that PROVED themselves through the tunnel, keyed by
   *  advertised id. An endpoint that answered no model list is not here. */
  endpoints: Map<string, RelayEndpoint>
  providers: Provider[]
  lastSeen: number
}

let current: RelayLink | null = null

/** The loopback forwarder's port, set once the listener is up. Null until the
 *  plugin's setup has bound it — a hello arriving before that is refused
 *  rather than discovered against a port that does not exist yet. */
let forwarderPort: number | null = null

export function attachedLink(): RelayLink | null {
  return current
}

export function setForwarderPort(port: number | null): void {
  forwarderPort = port
}

export function loopbackPort(): number | null {
  return forwarderPort
}

/** Install a new link, returning the one it replaced (already failed and
 *  closed) so the caller can say why in the close reason. */
export function attach(link: RelayLink): RelayLink | null {
  const previous = current
  current = link
  if (previous) {
    previous.calls.failAll('Another connector attached and replaced this one.')
    if (previous.key !== link.key) previous.close(4000, 'replaced by a newer connector')
  }
  return previous
}

/** Drop `link` if it is still the attached one. True when it was — the moment
 *  the caller announces the provider list changed. False for a link that was
 *  already replaced, whose providers are not the machine's any more. */
export function detach(link: RelayLink, reason: string): boolean {
  if (current !== link) return false
  current = null
  link.calls.failAll(reason)
  return true
}
