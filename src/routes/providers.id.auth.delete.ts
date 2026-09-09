import { defineEventHandler, send } from 'h3'
import {
  requireAuth,
  publishMachineState,
  apiError,
  disconnectProvider,
  requireProviderIdParam,
} from '../kernel/index.js'

/** Remove this machine's own credential for a provider. An org-supplied key
 *  re-seeds right away — that's the contract: disconnect removes YOUR
 *  credential, not the org's.
 *
 *  It used to cycle the agent runtime afterwards so its model catalogue would
 *  honestly reflect the removal. The engine reads credentials at the moment it
 *  builds a model, so the removal is already true by the time this returns. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const providerId = requireProviderIdParam(event)
  try {
    await disconnectProvider(providerId)
  } catch (error) {
    apiError(502, 'providers.disconnectFailed', error instanceof Error ? error.message : 'Disconnecting failed.')
  }
  /**
   *
   * Removing the last credential can make this machine unable to take a turn,
   * and a composer that only learns that when a send fails is worse than one
   * that says so up front.
   *
   **/
  await publishMachineState()
  return { ok: true }
})
