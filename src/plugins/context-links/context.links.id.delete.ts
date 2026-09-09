import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, publishMachineEvent } from '../../kernel/index.js'
import { deleteLink } from './links.js'

/** Unpass a passage. The conversations keep everything they already said — a
 *  link is a record of a hand-off, not the hand-off itself. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await deleteLink(id))) apiError(404, 'link.notFound', 'no such context link.')
  publishMachineEvent('context.unlinked', { id })
  return { ok: true }
})
