import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { killTerminal } from './terminals.js'

/** Close a shell: its process group is killed and its buffer released. The
 *  event bus tells every other client watching it. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')
  if (!id || !killTerminal(id)) apiError(404, 'terminal.notFound', 'No such shell.')
  return { ok: true }
})
