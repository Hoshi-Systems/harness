import { subscribeMachineEvents } from '../../kernel/index.js'
import { processGoal } from './goal-runner.js'
import { getCurrentGoalForSession, listRunningGoals } from './goals.js'

/** Drives every session's active goal (CYB-100): once a turn settles, audits
 *  the agent's latest reply against the goal's objective and either sends a
 *  continuation, marks the goal done, or gives up after three consecutive
 *  "stuck" verdicts.
 *
 *  A goal only ever advances when its session finishes a turn, and the engine
 *  says so — so this listens instead of ticking. It used to poll every running
 *  goal every 12 seconds, refetching each session's history to find out whether
 *  anything had happened, because the old runtime never volunteered it.
 *
 *  The boot sweep is the catch-up: a turn that settled while the sidecar was
 *  restarting published its event into a process that no longer existed, and
 *  the goal behind it would sit armed and idle forever, waiting for a turn that
 *  has already been and gone. */
export function watchGoals(): void {
  subscribeMachineEvents((event) => {
    if (event.type !== 'message.completed') return
    const sessionId = (event.properties as { sessionId?: string }).sessionId
    if (!sessionId) return
    void (async () => {
      const goal = await getCurrentGoalForSession(sessionId)
      if (goal) await processGoal(goal)
    })().catch((error) => console.error(`[goal-loop] goal in session ${sessionId} failed:`, error))
  })

  void (async () => {
    for (const goal of await listRunningGoals()) {
      try {
        await processGoal(goal)
      } catch (error) {
        console.error(`[goal-loop] boot sweep failed for goal ${goal.id}:`, error)
      }
    }
  })()
}
