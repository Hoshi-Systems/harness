import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { stopProcess } from './processes.js'

/** Stop a tracked process from the Processes panel — SIGTERM, a grace period,
 *  then SIGKILL if it's still alive (see utils/processes.ts's stopProcess).
 *  A process that already isn't `running` is a no-op, not an error — the
 *  response's `alreadyStopped` tells the caller which happened. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const result = await stopProcess(id)
  if (!result) {
    apiError(404, 'process.notFound', 'Process not found.')
  }
  return result
})
