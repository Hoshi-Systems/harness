import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { desktopStatus, displayName, viewerCount } from './desktop.js'

/** What the agent's desktop is doing: whether a display exists, whether anyone
 *  is watching, and how many. The pane hydrates from this once and then holds
 *  its stream — there is nothing here worth polling for. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { status: desktopStatus(), display: displayName(), viewers: viewerCount() }
})
