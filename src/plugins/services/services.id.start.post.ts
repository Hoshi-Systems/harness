import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { startService } from './services.js'

/** Run it. The wire carries only an id — the command comes from the stored
 *  declaration, never from the request (see the spawning note in
 *  utils/processes.ts for why that distinction is the whole boundary).
 *
 *  409 when it's already running, or when the declared port is taken; 400 when
 *  the command dies on the spot, with the reason, so a typo reads as a message
 *  rather than a row that silently flips to `exited`. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { service: await startService(getRouterParam(event, 'id')!) }
})
