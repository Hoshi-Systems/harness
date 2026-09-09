import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { deleteWebhookTrigger } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  if (!(await deleteWebhookTrigger(id))) {
    apiError(404, 'webhook.notFound', 'Webhook not found.')
  }
  return { ok: true }
})
