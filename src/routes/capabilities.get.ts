import { defineEventHandler } from 'h3'
import { requireAuth } from '../kernel/index.js'
import { capabilityPassport } from '../kernel/capabilities.js'

/** The authenticated, render-safe census of this machine's abilities. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  /**
   * Runtime imports the route catalogue that imports this handler. Deferring
   * this read until an authenticated request avoids a module-initialisation
   * cycle while still asking the one live table that owns the routes.
   */
  const { harnessRoutes } = await import('../runtime.js')
  return capabilityPassport(harnessRoutes())
})
