import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listTerminals, terminalsAvailable } from './terminals.js'

/** Every shell this machine is running. `available` is false when `node-pty`
 *  could not be loaded — so a client says why the aside is empty instead of
 *  offering a button that always fails. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { terminals: listTerminals(), available: terminalsAvailable() }
})
