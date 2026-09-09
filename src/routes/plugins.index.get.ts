import { defineEventHandler } from 'h3'
import { requireAuth } from '../kernel/index.js'
import { pluginStatuses } from '../plugins/registry.js'

/** What this machine is running, and why anything is not.
 *
 *  The same list `machine.state` carries — a route as well, because a settings
 *  screen wants it on demand rather than only at the moment it connects. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { plugins: pluginStatuses() }
})
