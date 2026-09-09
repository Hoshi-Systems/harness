import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { InvalidServerError, updateServer } from './servers.js'

/** Change a connector: its command, its url, the credentials it carries, or
 *  simply whether it is switched on.
 *
 *  This route did not exist, and its absence was invisible: clients have been
 *  calling it since the migration and getting a 404 the surface reported as a
 *  generic failure. A connector could be added and deleted, never changed and
 *  never switched off.
 *
 *  The body is a PARTIAL definition (`{ enabled: false }` on its own is the
 *  commonest one by far), merged into what is stored and validated as a whole —
 *  so flipping a toggle cannot be answered with a complaint about a `type` the
 *  person never touched. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const name = getRouterParam(event, 'name') ?? ''
  const body = await readJsonBody<{ config?: unknown }>(event)
  const patch = (body.config ?? {}) as Record<string, unknown>
  try {
    const updated = await updateServer(name, patch)
    if (!updated) apiError(404, 'mcp.notFound', 'No such connector on this machine.')
    return { ok: true }
  } catch (error) {
    if (error instanceof InvalidServerError) apiError(400, 'mcp.invalid', error.message)
    throw error
  }
})
