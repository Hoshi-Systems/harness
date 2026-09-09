import { defineEventHandler, createError } from 'h3'
import type { Hooks, Peer } from 'crossws'
import { authorizeUpgrade, makeBridgeHooks } from '../../kernel/index.js'
import { attachViewer, desktopPort, detachViewer } from './desktop.js'

/**
 *
 * The desktop, as a WebSocket a browser can render.
 *
 * RFB is raw TCP; websockify is what makes it a WebSocket, and this bridges to
 * that — so the machine's one authenticated bridge stays exactly as it is
 * (kernel/ws-bridge.ts).
 *
 * The upgrade is where the stream is STARTED, because it is the first moment we
 * know somebody is actually looking. Starting on the status read instead would
 * encode frames for anyone who merely opened the Computer panel.
 *
 **/
const bridge = makeBridgeHooks(async ({ url: rawUrl, headers }) => {
  const url = new URL(rawUrl)
  if (!(await authorizeUpgrade(headers, url))) return new Response('Unauthorized', { status: 401 })
  try {
    await attachViewer()
  } catch (error) {
    /** No display on this host, or no encoder. A reason rather than a silent
     *  failed upgrade, which a browser reports as nothing at all. */
    return new Response(error instanceof Error ? error.message : 'The desktop could not start', { status: 503 })
  }
  url.searchParams.delete('hoshi_token')
  return `ws://127.0.0.1:${desktopPort()}`
})

/**
 *
 * `detachViewer` on close, and it must run whatever else happens — the counter
 * it decrements is the only thing that ever stops the encoder. A viewer whose
 * browser was closed, whose network dropped, or who was terminated for a bad
 * upgrade all arrive here; a leak in any of those paths leaves a machine
 * encoding frames for nobody until it reboots.
 *
 **/
const desktopWebSocket: Partial<Hooks> = {
  ...bridge,
  async close(peer: Peer, details: { code?: number; reason?: string }) {
    /**
     *
     * Awaited, and not merely called. crossws does not catch a failing async
     * hook, and an unhandled rejection is process-fatal under the daemon's
     * resilience posture — the same trap `plugins/voice` records. A viewer
     * closing a tab must not be able to take the machine down.
     *
     **/
    try {
      await bridge.close?.(peer, details)
    } catch (error) {
      console.error('[desktop] closing the bridge failed:', error)
    } finally {
      detachViewer()
    }
  },
}

/** The route is WebSocket-only — a plain request has nothing to render. */
export default defineEventHandler({
  websocket: desktopWebSocket,
  handler: () => {
    throw createError({ statusCode: 426, statusMessage: 'Upgrade Required' })
  },
})
