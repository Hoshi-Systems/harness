import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { stopService } from './services.js'

/** SIGTERM the service's process group, SIGKILL if it outstays the grace
 *  period (utils/processes.ts). Idempotent — stopping something already
 *  stopped succeeds, so a double click or a stale view is never an error. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { service: await stopService(getRouterParam(event, 'id')!) }
})
