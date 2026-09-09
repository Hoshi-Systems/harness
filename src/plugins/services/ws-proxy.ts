import { authorizeEditorUpgrade, authorizePreviewUpgrade, cookieValue } from '../../kernel/index.js'
import { reservedPorts } from './listening-ports.js'
import type { Hooks } from 'crossws'
import { makeBridgeHooks } from '../../kernel/ws-bridge.js'
import { EDITOR_BASE_PATH, editorPort, ensureEditorRunning } from './editor.js'
import { PREVIEW_PORT_COOKIE } from './preview-proxy.js'

/**
 *
 * The sidecar's WebSocket layer (crossws via Nitro's experimental.websocket).
 * The PREVIEW bridge — browser ⇄ a dev server's websocket on a local port
 * (Vite HMR, Laravel Echo, anything — runtime-agnostic) — is built on this.
 * The upgrade hook authenticates from raw headers (a browser WebSocket can't
 * send Authorization — cookies cover the same-site case, `?hoshi_token=` the
 * rest) and resolves the upstream target; open/message/close pipe both ways.
 *
 **/

/** The preview bridge, shared by every preview route. Target resolution
 *  mirrors the HTTP side: a `p{port}--` preview host wins, then the
 *  `/proxy/{port}/**` path prefix, then the preview-port cookie (the root
 *  fallback — where Vite-style clients connect, since they dial the page's
 *  own origin root). */
export const previewWebSocket: Partial<Hooks> = makeBridgeHooks(async ({ url: rawUrl, headers }) => {
  const url = new URL(rawUrl)
  if (!(await authorizePreviewUpgrade(headers, url))) return new Response('Unauthorized', { status: 401 })

  const hostLabel = /^p(\d+)--/.exec(headers.get('host') ?? '')
  let port = hostLabel ? Number(hostLabel[1]) : null
  let path = url.pathname
  if (port === null) {
    const prefixed = /^\/proxy\/(\d+)(\/.*)?$/.exec(url.pathname)
    if (prefixed) {
      port = Number(prefixed[1])
      path = prefixed[2] || '/'
    }
  }
  if (port === null) {
    const fromCookie = cookieValue(headers.get('cookie'), PREVIEW_PORT_COOKIE)
    if (fromCookie) port = Number(fromCookie)
  }
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535 || reservedPorts().has(port)) {
    return new Response('No preview target for this websocket', { status: 400 })
  }

  url.searchParams.delete('hoshi_token')
  return `ws://127.0.0.1:${port}${path}${url.search}`
})

/** The embedded code editor's bridge (routes/editor/**): openvscode-server's
 *  remote connection is a WebSocket on its own `/editor` base path, forwarded
 *  1:1 like the HTTP side (utils/editor.ts). The ensure-running call covers a
 *  reconnect racing a cold start — cheap once the server answers. */
export const editorWebSocket: Partial<Hooks> = makeBridgeHooks(async ({ url: rawUrl, headers }) => {
  const url = new URL(rawUrl)
  if (!(await authorizeEditorUpgrade(headers, url))) return new Response('Unauthorized', { status: 401 })
  if (url.pathname !== EDITOR_BASE_PATH && !url.pathname.startsWith(`${EDITOR_BASE_PATH}/`)) {
    return new Response('Not an editor websocket', { status: 400 })
  }
  try {
    await ensureEditorRunning()
  } catch {
    return new Response('The code editor is not available on this machine', { status: 503 })
  }
  url.searchParams.delete('hoshi_token')
  return `ws://127.0.0.1:${editorPort()}${url.pathname}${url.search}`
})
