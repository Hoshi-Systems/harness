import { defineEventHandler } from 'h3'
import { requireAuth, getPreferences } from '../kernel/index.js'

/** This machine's OpenCode defaults — default/small model, sharing, auto-update. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { preferences: await getPreferences() }
})
