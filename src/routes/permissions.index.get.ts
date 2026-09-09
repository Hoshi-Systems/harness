import { defineEventHandler } from 'h3'
import { requireAuth, listAsks } from '../kernel/index.js'

/** Every pending permission ask on the machine.
 *
 *  Machine-wide, with no scope to pass: an ask raised inside a project checkout
 *  is as findable as one in the personal space. It also survives a client
 *  reload — the ask stays here until answered, so reopening the tab re-renders
 *  the card instead of stranding the turn behind a question nobody can see. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { permissions: listAsks() }
})
