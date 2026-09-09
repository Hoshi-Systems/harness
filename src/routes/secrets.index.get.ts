import { defineEventHandler } from 'h3'
import { requireAuth, listSecrets } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { secrets: await listSecrets() }
})
