import { defineEventHandler } from 'h3'
import { handlePreviewEntry } from './preview-proxy.js'
import { previewWebSocket } from './ws-proxy.js'

/** `/proxy/{port}/` with no trailing path — the preview's front door. Kept as
 *  an explicit index route so the zero-segment URL never depends on how the
 *  sibling catch-all matches empties. */
export default defineEventHandler({
  websocket: previewWebSocket,
  handler: handlePreviewEntry,
})
