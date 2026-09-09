import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES, readProcessLogTail } from './processes.js'
import { getServiceView } from './services.js'

/** The service's combined stdout+stderr tail — the whole of US-4 ("it crashed
 *  and I can see why") without a terminal. `?tail=` caps the trailing lines.
 *
 *  A service that has never run returns empty output rather than a 404: the
 *  declaration exists, it simply hasn't produced anything yet, and the panel
 *  should say so quietly instead of erroring. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const service = await getServiceView(getRouterParam(event, 'id')!)
  if (!service) {
    apiError(404, 'service.notFound', 'Service not found.')
  }

  const tailRaw = getQuery(event).tail
  let tail = DEFAULT_TAIL_LINES
  if (typeof tailRaw === 'string' && tailRaw.trim()) {
    const parsed = Number(tailRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      apiError(400, 'service.tailInvalid', `tail must be a positive integer (max ${MAX_TAIL_LINES}).`)
    }
    tail = Math.min(parsed, MAX_TAIL_LINES)
  }

  return { service, logs: service.processId ? await readProcessLogTail(service.processId, tail) : '' }
})
