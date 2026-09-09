import { defineEventHandler } from 'h3'
import { requireAuth, clearAllLevels } from '../kernel/index.js'

/** Forget every explicit tool level: all of them inherit the machine default
 *  again. Answers how many were actually cleared, so the screen can say
 *  "nothing to reset" rather than claim work it did not do. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { ok: true, count: await clearAllLevels() }
})
