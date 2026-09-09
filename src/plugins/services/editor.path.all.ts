import { defineEventHandler } from 'h3'
import { handleEditorRequest } from './editor.js'
import { editorWebSocket } from './ws-proxy.js'

/** Everything under `/editor/**` — static assets, webviews, extension
 *  resources — forwarded 1:1 to openvscode-server, which serves under the
 *  same `/editor` base path (utils/editor.ts). WebSocket upgrades bridge the
 *  same way. */
export default defineEventHandler({
  websocket: editorWebSocket,
  handler: handleEditorRequest,
})
