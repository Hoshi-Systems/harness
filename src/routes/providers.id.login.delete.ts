import { defineEventHandler } from 'h3'
import { requireAuth, cancelProviderLogin, requireProviderIdParam } from '../kernel/index.js'

/** Stop waiting for a sign-in the person gave up on. Nothing to undo: no
 *  credential exists until GitHub says the code was approved. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const providerId = requireProviderIdParam(event)
  return { cancelled: cancelProviderLogin(providerId) }
})
