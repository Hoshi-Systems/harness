import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { adoptProcess, validatePort, validateScope } from './services.js'

/** Turn a running process nothing declares — in practice, the dev server the
 *  agent started with `process_start` — into a real service, WITHOUT restarting
 *  it. That invariant is the point: the panel and the agent must end up looking
 *  at one process, not two truths about the same port (US-3). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ processId?: unknown; name?: unknown; port?: unknown; scope?: unknown }>(event)

  if (typeof body.processId !== 'string' || !body.processId) {
    apiError(400, 'service.processIdRequired', 'processId is required.')
  }

  return {
    service: await adoptProcess({
      processId: body.processId,
      name: typeof body.name === 'string' ? body.name : undefined,
      port: validatePort(body.port),
      scope: validateScope(body.scope),
    }),
  }
})
