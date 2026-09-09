import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { pauseGoal } from './goals.js'

/** Pause the goal loop from the status strip's own control — the other half
 *  of the composer's stop button also pausing it (stopping the turn doesn't
 *  reach here; the client calls this directly alongside the abort). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  return { goal: await pauseGoal(id) }
})
