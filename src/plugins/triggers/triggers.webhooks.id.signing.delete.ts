import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { clearWebhookSigningSecret } from './triggers.js'

/** Turn HMAC signing off — unsigned fires to the invocation URL are accepted
 *  again, which is how a webhook works until signing is switched on. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const updated = await clearWebhookSigningSecret(id)
  if (!updated) apiError(404, 'webhook.notFound', 'Webhook not found.')
  return { webhook: updated }
})
