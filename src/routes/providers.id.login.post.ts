import { defineEventHandler } from 'h3'
import {
  requireAuth,
  apiError,
  listProviders,
  providerLogin,
  requireProviderIdParam,
  startProviderLogin,
  ProviderLoginError,
} from '../kernel/index.js'

/** Connect a provider by signing in to an account rather than pasting a key.
 *
 *  Answers with the code to type and where to type it. The machine polls for
 *  the approval itself and reports the outcome as a `provider.login` event —
 *  the client that asked may close its dialog, and another client may be the
 *  one watching. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const providerId = requireProviderIdParam(event)

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
  if (!providerLogin(provider.id) || !provider.keyEnvVar) {
    apiError(400, 'providers.noLogin', `${provider.name} is connected with an API key, not a sign-in.`)
  }

  try {
    return { login: await startProviderLogin(provider.id, provider.keyEnvVar) }
  } catch (error) {
    if (error instanceof ProviderLoginError) apiError(502, 'providers.loginFailed', error.message)
    throw error
  }
})
