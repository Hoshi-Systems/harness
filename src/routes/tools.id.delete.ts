import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, clearLevel } from '../kernel/index.js'

/** Drop one tool's explicit level, so it inherits the machine default again.
 *  404 when it had none — there is nothing to clear, and saying so is better
 *  than reporting a change that never happened. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await clearLevel(id))) apiError(404, 'tool.noExplicitLevel', 'That tool has no explicit level to clear.')
  return { ok: true }
})
