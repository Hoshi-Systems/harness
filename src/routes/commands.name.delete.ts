import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, deleteCommand } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const removed = await deleteCommand(getRouterParam(event, 'name') ?? '')
  if (!removed) apiError(404, 'command.notFound', 'No such command on this machine.')
  return { ok: true }
})
