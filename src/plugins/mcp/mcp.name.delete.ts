import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError } from '../../kernel/index.js'
import { removeServer } from './servers.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const removed = await removeServer(getRouterParam(event, 'name') ?? '')
  if (!removed) apiError(404, 'mcp.notFound', 'No such connector on this machine.')
  return { ok: true }
})
