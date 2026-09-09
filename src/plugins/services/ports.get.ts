import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listListeningPorts } from './listening-ports.js'

/** TCP ports something on this machine is listening on (the machine's own
 *  listeners excluded) — feeds the Hoshi Computer's "port opened" suggestions
 *  and the Browser tab's ports dropdown. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { ports: (await listListeningPorts()).map((port) => ({ port })) }
})
