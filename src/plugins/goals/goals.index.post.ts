import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody, getSession } from '../../kernel/index.js'
import { createGoal, validateLimits, validateObjective } from './goals.js'

/** Arm a goal on a session (CYB-100): the composer's target button armed,
 *  then the user's own message becomes `objective` — this is called right
 *  after that message is sent, never instead of it. One goal per session at a
 *  time; createGoal 409s if one's already active.
 *
 *  Never on a chat. A goal is a process driving toward a result, audited and
 *  continued turn after turn — which is the cost a chat exists to be an
 *  alternative to. Arming one there would rebuild, inside the cheap
 *  conversation, the expensive thing it was opened instead of. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    sessionId?: unknown
    objective?: unknown
    maxContinuations?: unknown
    tokenBudget?: unknown
  }>(event)

  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    apiError(400, 'goal.sessionIdRequired', 'sessionId is required.')
  }
  if ((await getSession(body.sessionId))?.chat) {
    apiError(409, 'goal.notOnChat', 'that session is a chat — a chat carries no goal.')
  }
  const objective = validateObjective(body.objective)
  const { maxContinuations, tokenBudget } = validateLimits(body.maxContinuations, body.tokenBudget)

  return { goal: await createGoal({ sessionId: body.sessionId, objective, maxContinuations, tokenBudget }) }
})
