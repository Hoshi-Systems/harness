import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listWebhooks } from './triggers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { webhooks: await listWebhooks() }
})
