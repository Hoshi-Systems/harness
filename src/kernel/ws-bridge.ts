import type { Hooks } from 'crossws'

/**
 * ── Bridging one WebSocket to another ────────────────────────────────────────
 *
 * The machine proxies several long-lived WebSockets — a dev server's HMR
 * channel, the embedded editor's remote connection, the agent's desktop — and
 * every one of them needs the same three things: authorize the UPGRADE from raw
 * headers (a browser WebSocket cannot send `Authorization`), resolve where it
 * goes, then pipe both ways until either end closes.
 *
 * In the kernel because two plugins need it and a plugin may not import another
 * (docs/decisions/0002-own-harness.md). It lived in `plugins/services/ws-proxy.ts`
 * while `services` was its only caller; `desktop` made that a cross-plugin
 * import, which is the moment the contract says to move the shared thing rather
 * than reach across.
 *
 * What stays with each caller is the only part that differs: `resolveTarget`,
 * which authenticates and decides the upstream URL — or returns a `Response`
 * to refuse the upgrade outright.
 *
 **/

/** Minimal structural type for Node 22's global (undici) WebSocket — the DOM
 *  lib isn't in this tsconfig, so we type what we use. */
interface UpstreamSocket {
  readyState: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

const WebSocketImpl = (
  globalThis as unknown as { WebSocket: new (url: string, protocols?: string[]) => UpstreamSocket }
).WebSocket

const CONNECTING = 0
const OPEN = 1

interface BridgeState {
  upstream: UpstreamSocket
  /** Frames the browser sent before the upstream finished connecting. */
  pending: (string | Uint8Array)[]
}

/** One cookie out of a raw `Cookie:` header. */

/** Authenticate a WebSocket upgrade from its raw headers/URL: bearer (non-
 *  browser clients), the alternate `X-Hoshi-Token` header (for a client whose
 *  `Authorization` is already spent on its own auth scheme), `?hoshi_token=`,
 *  the platform session cookie, or the preview-auth cookie — any one passing
 *  wins. */

/** Bridge hooks around a target resolved at upgrade time: the resolver
 *  authenticates and returns the upstream ws:// URL (or a Response to reject).
 *  Subprotocols the browser offered are re-offered upstream; crossws' node
 *  adapter echoes the first offered one back to the browser (`vite-hmr` etc.),
 *  so negotiation holds end to end. */
export function makeBridgeHooks(
  resolveTarget: (request: { url: string; headers: Headers }) => Promise<string | Response>,
): Partial<Hooks> {
  return {
    async upgrade(request) {
      const resolved = await resolveTarget({ url: request.url, headers: request.headers })
      if (resolved instanceof Response) return resolved
      request.context.wsTarget = resolved
    },

    open(peer) {
      const target = peer.context.wsTarget as string | undefined
      if (!target) {
        peer.terminate()
        return
      }
      const offered = peer.request.headers
        ?.get('sec-websocket-protocol')
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      const upstream = new WebSocketImpl(target, offered?.length ? offered : undefined)
      upstream.binaryType = 'arraybuffer'
      const state: BridgeState = { upstream, pending: [] }
      peer.context.bridge = state

      upstream.onopen = () => {
        for (const frame of state.pending) upstream.send(frame)
        state.pending = []
      }
      upstream.onmessage = (event) => {
        peer.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      }
      upstream.onclose = (event) => {
        /**
         *
         * 1005/1006 are reserved "no status" codes — not sendable on close().
         *
         **/
        const code = event.code >= 1000 && event.code !== 1005 && event.code !== 1006 ? event.code : 1000
        peer.close(code, event.reason)
      }
      upstream.onerror = () => peer.terminate()
    },

    message(peer, message) {
      const state = peer.context.bridge as BridgeState | undefined
      if (!state) return
      const data = typeof message.rawData === 'string' ? message.rawData : message.uint8Array()
      if (state.upstream.readyState === OPEN) state.upstream.send(data)
      else if (state.upstream.readyState === CONNECTING) state.pending.push(data)
    },

    close(peer) {
      const state = peer.context.bridge as BridgeState | undefined
      if (state && state.upstream.readyState <= OPEN) state.upstream.close()
    },

    error(peer) {
      peer.terminate()
    },
  }
}
