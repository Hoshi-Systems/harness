import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { restartService } from './services.js'

/** Stop, then start — the one-click recovery next to a failed row (US-4).
 *  Deliberately sequential rather than a fresh spawn beside the old process:
 *  the stop has to release the declared port before the start can bind it. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { service: await restartService(getRouterParam(event, 'id')!) }
})
