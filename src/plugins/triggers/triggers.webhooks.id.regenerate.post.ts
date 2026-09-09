import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { regenerateWebhookSecret } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const updated = await regenerateWebhookSecret(id)
  if (!updated) apiError(404, 'webhook.notFound', 'Webhook not found.')
  return { webhook: updated }
})
