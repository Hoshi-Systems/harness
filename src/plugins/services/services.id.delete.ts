import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { deleteService } from './services.js'

/** Forget a service. Its process is stopped first — a deleted row must never
 *  leave a dev server holding a port with no way back to it from the panel. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  await deleteService(getRouterParam(event, 'id')!)
  return { ok: true }
})
