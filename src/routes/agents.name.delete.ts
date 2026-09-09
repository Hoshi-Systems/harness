import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, deleteAgent } from '../kernel/index.js'

/** Drop a custom agent, or an override on a built-in — which RESTORES the
 *  built-in rather than removing it. Nobody can delete their way to a machine
 *  with no agents. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const removed = await deleteAgent(getRouterParam(event, 'name') ?? '')
  if (!removed) apiError(404, 'agent.notFound', 'Nothing to remove under that name.')
  return { ok: true }
})
