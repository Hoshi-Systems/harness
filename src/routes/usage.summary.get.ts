import { defineEventHandler } from 'h3'
import { requireAuth, getUsageSummary } from '../kernel/index.js'

/**
 *
 * This machine's token/cost usage totals + per-model breakdown (CYB-79) —
 * every OpenCode session it has run, not scoped to any one Platform project.
 *
 **/
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return getUsageSummary()
})
