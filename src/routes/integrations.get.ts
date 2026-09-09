import { defineEventHandler } from 'h3'
import { listSuggestedIntegrations, requireAuth } from '../kernel/index.js'

/** Which integrations this machine's preset thinks are worth offering, in order. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { suggested: await listSuggestedIntegrations() }
})
