import { defineEventHandler } from 'h3'
import { handleEditorRequest } from './editor.js'
import { editorWebSocket } from './ws-proxy.js'

/** The embedded code editor's entry: `/editor` is openvscode-server behind
 *  the machine's own auth (utils/editor.ts) — the iframe's first navigation
 *  lands here with the `?hoshi_token=` handshake, and the editor's main
 *  remote-connection WebSocket dials this exact path too. */
export default defineEventHandler({
  websocket: editorWebSocket,
  handler: handleEditorRequest,
})
