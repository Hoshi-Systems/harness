import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { processGoal } from './goal-runner.js'
import { resumeGoal } from './goals.js'

/** Resume a paused goal. Re-arming the loop means driving it right now rather
 *  than waiting out the next scheduled tick (plugins/goal-loop.ts) — if the
 *  session is already idle with an unaudited reply sitting there, the user
 *  shouldn't wait up to TICK_MS to see the loop pick back up. `processGoal` is
 *  a no-op when there's nothing new to act on, so this is always safe. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const goal = await resumeGoal(id)
  await processGoal(goal)
  return { goal }
})
