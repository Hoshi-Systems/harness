import { defineEventHandler } from 'h3'
import { handlePreviewEntry } from './preview-proxy.js'
import { previewWebSocket } from './ws-proxy.js'

/** The authenticated preview proxy: `/proxy/{port}/**` streams to the dev
 *  server listening on that local port — HTTP via utils/preview-proxy.ts (auth
 *  handshake, cookies, header hygiene), WebSocket upgrades via the shared
 *  preview bridge. */
export default defineEventHandler({
  websocket: previewWebSocket,
  handler: handlePreviewEntry,
})
