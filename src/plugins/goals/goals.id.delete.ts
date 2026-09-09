import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { deleteGoal } from './goals.js'

/** Dismiss a goal for good — clears a terminal goal's status strip, or lets
 *  the user abandon one early (running or paused) without waiting for
 *  stuck-3x/budget/error to settle it naturally. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  if (!(await deleteGoal(id))) {
    apiError(404, 'goal.notFound', 'Goal not found.')
  }
  return { ok: true }
})
