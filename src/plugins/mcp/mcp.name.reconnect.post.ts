import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError } from '../../kernel/index.js'
import { reconnectServer } from './servers.js'

/** Dial a connector again and answer with what it gave.
 *
 *  Both the retry and the test: the reply carries the live status, the number of
 *  tools it contributed, and the error if it refused — which is the question a
 *  person actually has when a connector is on the screen and its tools are not.
 *
 *  Connections are otherwise made once per process, so before this the only way
 *  to re-ask after fixing a token or starting a server was to restart the whole
 *  machine. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const name = getRouterParam(event, 'name') ?? ''
  const server = await reconnectServer(name)
  if (!server) apiError(404, 'mcp.notFound', 'No such connector on this machine.')
  return { server }
})
