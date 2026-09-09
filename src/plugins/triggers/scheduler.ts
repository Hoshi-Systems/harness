import type { UnattendedContext } from '../../kernel/host-ports.js'
import { listDueSchedules, markScheduleRun } from './triggers.js'

/**
 * ── Firing the machine's due schedules ───────────────────────────────────────
 *
 * A schedule always rolls FORWARD even when delivery fails: a machine that was
 * asleep must not wake to a pile of catch-up runs. A prompt-mode schedule is
 * dispatched as unattended work; a workflow-mode one asks whoever owns
 * workflows to fire the published graph (kernel/ports.ts).
 *
 **/
const TICK_MS = 60_000

export function scheduleTicker(unattended: UnattendedContext) {
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      for (const schedule of await listDueSchedules()) {
        /**
         *
         * Roll forward first so a crash mid-dispatch can't double-fire. This
         * needs its own guard: it sits outside the dispatch try below, so a
         * throw here (an unwritable ~/.hoshi, a hand-edited cron that no longer
         * parses) escaped the loop entirely and took every REMAINING due
         * schedule with it — and, being a tick-level failure, did so again on
         * every tick after. One bad schedule must cost only itself. Skipping
         * the dispatch is deliberate: firing without rolling forward would
         * re-fire the same schedule every minute.
         *
         **/
        try {
          await markScheduleRun(schedule.id)
        } catch (error) {
          console.error(`[scheduler] "${schedule.name}" (${schedule.id}) could not roll forward:`, error)
          continue
        }
        try {
          if (schedule.workflowId) {
            /**
             *
             * A trigger fires the PUBLISHED graph and nothing else, so a
             * half-finished edit open on the canvas can never go off at 03:00 —
             * which is whoever-owns-workflows' rule to enforce, not ours.
             *
             **/
            const fired = await unattended.startWorkflow?.({
              workflowId: schedule.workflowId,
              source: 'schedule',
              triggerId: schedule.id,
            })
            if (!fired) {
              console.error(`[scheduler] "${schedule.name}" (${schedule.id}) skipped: this machine runs no workflows`)
              continue
            }
            if (!fired.started) {
              console.error(
                `[scheduler] "${schedule.name}" (${schedule.id}) skipped: ${fired.reason ?? 'not runnable'}`,
              )
              continue
            }
          } else {
            await unattended.dispatch?.({
              source: 'schedule',
              triggerId: schedule.id,
              triggerName: schedule.name,
              prompt: schedule.prompt,
              projectId: schedule.projectId,
              model: schedule.model,
            })
          }
        } catch (error) {
          console.error(`[scheduler] "${schedule.name}" (${schedule.id}) failed:`, error)
        }
      }
    } finally {
      running = false
    }
  }

  return { every: TICK_MS, tick }
}
