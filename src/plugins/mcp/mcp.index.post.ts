import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { addServer, InvalidServerError, parseConfig } from './servers.js'

/** Add a connector. The definition is validated here, where the person who
 *  typed it is looking — a connector that could never connect should not become
 *  a mysterious `unreachable` five minutes later. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ name?: unknown; config?: unknown }>(event)
  if (typeof body.name !== 'string') apiError(400, 'mcp.nameRequired', 'name is required.')
  try {
    /**
     *
     * `body.config`, the way a connector is described everywhere else on this
     * wire — `GET /mcp` answers `{ name, config }`, and every client builds the
     * same shape to send back. This route read the definition off the TOP level
     * instead, so every connector added from the marketplace came back "type
     * must be one of: stdio, http, sse" — the type was there, one level down,
     * and the message pointed at the person's own choice rather than at the
     * mismatch.
     *
     **/
    await addServer(body.name as string, parseConfig(body.config))
    return { ok: true }
  } catch (error) {
    if (error instanceof InvalidServerError) apiError(400, 'mcp.invalid', error.message)
    throw error
  }
})
