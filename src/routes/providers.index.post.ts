import { defineEventHandler, setResponseStatus } from 'h3'
import {
  requireAuth,
  publishMachineState,
  apiError,
  readJsonBody,
  addCustomProvider,
  CorruptStoreError,
  ProviderExistsError,
  ProviderNotAllowedError,
  ProviderUnreachableError,
} from '../kernel/index.js'

/** Add a provider to this machine — a self-hosted runtime, or an endpoint the
 *  open catalogue has never heard of.
 *
 *  Only the address is required. The model list is asked FOR, from the endpoint
 *  itself, because the person adding Ollama knows where it runs and not what is
 *  loaded in it — and because no catalogue can answer for somebody's own
 *  hardware. An address that answers with no model list is refused rather than
 *  saved: a provider with no models is a row in every picker that can never be
 *  picked, and a wrong port is easiest to fix in the second it was typed. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    id?: unknown
    name?: unknown
    baseUrl?: unknown
    keyEnvVar?: unknown
    models?: unknown
  }>(event)

  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    apiError(400, 'provider.invalidId', 'A provider id is letters, digits, dots, dashes or underscores.')
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  if (!/^https?:\/\/.+/i.test(baseUrl)) apiError(400, 'provider.invalidBaseUrl', 'baseUrl must be an http(s) URL.')

  const models = Array.isArray(body.models)
    ? body.models.filter((model): model is string => typeof model === 'string' && !!model)
    : null

  try {
    const provider = await addCustomProvider({
      id,
      name: typeof body.name === 'string' ? body.name.trim() : null,
      baseUrl,
      keyEnvVar: typeof body.keyEnvVar === 'string' && body.keyEnvVar.trim() ? body.keyEnvVar.trim() : null,
      models,
    })
    /**
     *
     * The set of usable providers just changed, and `machine.state.ready` is
     * computed from it — a client whose composer is gated on that field would
     * otherwise stay blocked until a reload (docs/MACHINE_WIRE.md: machine
     * state a client watches publishes its changes in the same change).
     *
     **/
    await publishMachineState()
    setResponseStatus(event, 201)
    return { provider }
  } catch (error) {
    if (error instanceof ProviderExistsError) apiError(409, 'provider.exists', error.message)
    /**
     *
     * The organization's allow-list, refused as its own status and code.
     * Nothing was written: a connection the machine cannot use is not a
     * connection, and reporting one — which is what saving-then-filtering did
     * — is worse than refusing, because the person is then told to look for a
     * provider that is not anywhere. The client turns this into the approval
     * step (`POST /org-defaults/allow`), which is capability-checked by the
     * Platform, not here.
     *
     **/
    if (error instanceof ProviderNotAllowedError) apiError(403, 'provider.policyBlocked', error.message)
    if (error instanceof ProviderUnreachableError) apiError(400, 'provider.unreachable', error.message)
    /**
     *
     * The providers file is hand-editable, so a syntax error in it is a user
     * situation, not a server fault: say which file and that nothing was
     * written, rather than a bare 500 that reads as "Hoshi is broken".
     *
     **/
    if (error instanceof CorruptStoreError) apiError(409, 'provider.storeCorrupt', error.message)
    throw error
  }
})
