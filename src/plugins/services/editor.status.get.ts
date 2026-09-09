import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { editorStatus } from './editor.js'

/** Availability of the machine's embedded code editor — the Hoshi Computer's
 *  Code overlay hydrates from this once to pick between the editor iframe and
 *  an "not installed" empty state (a machine without the baked-in
 *  openvscode-server, e.g. bare local dev). Lifecycle beyond that is
 *  implicit: the /editor/** proxy cold-starts the server on demand. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { status: await editorStatus() }
})
