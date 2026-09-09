import { defineEventHandler } from 'h3'
import {
  requireAuth,
  publishMachineState,
  apiError,
  readJsonBody,
  publishMachineEvent,
  validateSecretValue,
  setSecret,
  listProviders,
  requireProviderIdParam,
} from '../kernel/index.js'

/** Connect a provider with the user's own API key.
 *
 *  The key lands in the vault and that is the entire operation — no process
 *  cycle, no "restart to apply", no deferred anything. Credential state is read
 *  fresh on every provider/model listing (engine/providers.ts), so the provider
 *  is usable on the very next request. This route used to end in
 *  `restartOpenCode()` because the old runtime snapshotted its model catalogue
 *  at startup; that whole apparatus is what owning the engine removed. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const providerId = requireProviderIdParam(event)
  const body = await readJsonBody<{ key?: unknown }>(event)
  const key = validateSecretValue(body.key)

  const provider = (await listProviders()).find((entry) => entry.id === providerId)
  if (!provider) apiError(404, 'providers.unknown', 'This machine does not know that provider.')
  /**
   *
   * Policy outranks a credential. Storing one for a provider the organization
   * does not allow would make the surface say "connected" about something no
   * turn can use — the same success-shaped lie that saving a disallowed
   * provider was, one field further along. Approval comes first
   * (`POST /org-policy/providers/allow`); this refuses until it has.
   *
   **/
  if (provider.policyBlocked) {
    apiError(
      403,
      'provider.policyBlocked',
      `Your organization's provider policy does not include "${provider.id}", so this machine cannot use it yet.`,
    )
  }
  if (!provider.keyEnvVar) {
    apiError(400, 'providers.noKeyExpected', `${provider.name} takes no API key on this machine.`)
  }

  await setSecret(provider.keyEnvVar, key)
  publishMachineEvent('providers.updated', { providerId })
  /**
   *
   * A machine with no usable provider reports itself not ready, and clients
   * gate their composer on that. Connecting the FIRST key is exactly the moment
   * it stops being true, so the snapshot has to move with it.
   *
   **/
  await publishMachineState()
  return { ok: true }
})
