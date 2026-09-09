import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listServers } from './servers.js'

/** MCP connectors with their LIVE state — a connection was actually attempted,
 *  not read back from the stored definition. `configured` and `working` have to
 *  be tellable apart: otherwise a broken connector's only symptom is an agent
 *  quietly missing tools (docs/MACHINE_WIRE.md). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { servers: await listServers() }
})
