import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { setWebhookSigningSecret } from './triggers.js'

/** Enable HMAC signing on a webhook, or rotate the secret of one that already
 *  signs — the regenerate.post.ts model, for the other secret. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const updated = await setWebhookSigningSecret(id)
  if (!updated) apiError(404, 'webhook.notFound', 'Webhook not found.')
  return { webhook: updated }
})
