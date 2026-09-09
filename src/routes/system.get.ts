import { defineEventHandler } from 'h3'
import { requireAuth, collectSystem } from '../kernel/index.js'

/** Live host info for this machine — version, uptime, CPU/memory/disk, and
 *  OpenCode reachability. A machine-native root route (owner-locked like the
 *  rest of the sidecar's own surface), distinct from the `/opencode` proxy. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { system: await collectSystem() }
})
