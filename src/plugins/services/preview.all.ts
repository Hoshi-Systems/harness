import { createError, defineEventHandler, getCookie, getRequestURL } from 'h3'
import { requirePreviewAuth } from '../../kernel/index.js'
import { forwardToPort, parsePreviewPort, PREVIEW_PORT_COOKIE } from './preview-proxy.js'
import { previewWebSocket } from './ws-proxy.js'

/** Root fallback for the preview proxy. A previewed app requests its assets by
 *  absolute path (`/assets/x.js`, `/@vite/client`) — those land on the machine
 *  root, past the `/proxy/{port}` prefix. When the request carries the
 *  preview-port cookie (set on preview entry), forward it to that port; without
 *  it this stays the 404 it always was. Every named route (health, git, sessions, …)
 *  outranks this wildcard, so the machine's own API is unaffected — and a
 *  client must address one of those rather than land here, which
 *  scripts/check-machine-wire.mjs is what enforces. WebSocket upgrades (Vite HMR dials the page origin's root)
 *  bridge through the same preview target resolution. */
export default defineEventHandler({
  websocket: previewWebSocket,
  handler: async (event) => {
    const raw = getCookie(event, PREVIEW_PORT_COOKIE)
    if (!raw) throw createError({ statusCode: 404 })
    await requirePreviewAuth(event)
    const port = parsePreviewPort(raw)
    const path = event.context.params?.path ?? ''
    const { search } = getRequestURL(event)
    return forwardToPort(event, port, path, search)
  },
})
