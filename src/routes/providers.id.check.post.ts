import { defineEventHandler } from 'h3'
import {
  apiError,
  checkProvider,
  readJsonBody,
  requireAuth,
  requireProviderIdParam,
  ProviderNotAllowedError,
  ProviderUnknownError,
  ProviderUnreachableError,
} from '../kernel/index.js'

/** Test a provider's credential against its endpoint, because somebody asked.
 *
 *  `connected` elsewhere on this wire means the vault holds a key. This is the
 *  other question, and the two must never be reported as one: a mistyped key,
 *  a revoked one and a working one look identical until the first turn fails.
 *
 *  `allowBillable` authorizes settling an inconclusive answer with a single
 *  one-token completion — the only thing that can prove a credential against an
 *  endpoint whose model list is public. It is never assumed, and it is not
 *  reached at all when the free probe already answered, so asking for it does
 *  not mean paying for it. A client must not send it on mount or on reload. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const providerId = requireProviderIdParam(event)
  const body = await readJsonBody<{ allowBillable?: unknown }>(event).catch(() => ({ allowBillable: false }))
  try {
    return { check: await checkProvider(providerId, { allowBillable: body.allowBillable === true }) }
  } catch (error) {
    if (error instanceof ProviderUnknownError) apiError(404, 'providers.unknown', error.message)
    if (error instanceof ProviderNotAllowedError) apiError(403, 'provider.policyBlocked', error.message)
    if (error instanceof ProviderUnreachableError) apiError(400, 'provider.unreachable', error.message)
    throw error
  }
})
