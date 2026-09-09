import { readMessages, type Message, anyTurnRunning, sendMessage } from '../../kernel/index.js'
import { runGoalAudit } from './goal-audit.js'
import { patchGoal, type Goal } from './goals.js'

/** How long a goal audit waits for the machine to stop generating before it
 *  gives up on this pass. Generous, because a slow local model's turn is
 *  exactly the case this exists for; bounded, because a goal that never audits
 *  is a goal that never finishes. */
const IDLE_WAIT_MS = 120_000
const IDLE_POLL_MS = 500

/** Resolve once nothing is generating on this machine, or false when the wait
 *  ran out. */
async function waitForIdleModel(): Promise<boolean> {
  const deadline = Date.now() + IDLE_WAIT_MS
  while (anyTurnRunning()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
  }
  return true
}

/**
 * ── Goal loop mechanics (CYB-100) ────────────────────────────────────────────
 *
 * The actual "audit → keep going / done / stuck" pipeline for one goal, shared
 * by the event-driven plugin (plugins/goal-loop.ts) and the resume route (which
 * drives a goal immediately rather than waiting for its session to say
 * something). Kept separate from utils/goals.ts (the CRUD/persistence store)
 * the same way utils/task-queue.ts's mechanics sit apart from
 * utils/triggers.ts's config — different concern, same file-per-concern
 * convention.
 *
 **/

/** What each automatic continuation tells the agent. Beyond "keep going" it
 *  pushes the two goal-mode disciplines: delegate real work to recruited
 *  specialists instead of grinding inline (when the session's agent has the
 *  team tools — the personal agent does), and verify the objective against
 *  reality before ever claiming it's done — the auditor only sees the reply,
 *  so an unverified "done" claim would settle the goal on a lie. */
const CONTINUATION_PROMPT = [
  'Continue working toward the goal.',
  'Prefer delegating substantial work to a specialist with the `task` tool and reviewing what it reports over doing everything inline, when that tool is available to you.',
  'Before declaring the goal achieved, verify it against the actual state — files, checks, outputs — not your intentions; if it is achieved, say so explicitly and stop.',
].join(' ')

/** The assistant's actual prose for this turn. Empty for a turn that was pure
 *  tool calls — nothing there for an auditor to judge. */
function replyText(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function errorSummary(error: NonNullable<Message['error']>): string {
  return error.message?.trim() || error.name || 'The turn ended with an error.'
}

/** Settle a goal into a terminal state in one persisted write. The client
 *  turns the running→terminal `goal.updated` push into the spec's single
 *  settle notification — the machine side only has to make that transition
 *  happen exactly once, which patchGoal's one-shot write already guarantees. */
async function settle(goal: Goal, status: Goal['status'], note: string): Promise<void> {
  await patchGoal(goal.id, { status, progressNote: note, completedAt: new Date().toISOString(), auditing: false })
}

/** Send the next auto-continuation if the cap allows it, otherwise settle as
 *  "stopped" (the continuation-cap safety limit). Shared by the keep_going
 *  verdict path and the empty-reply/compaction fallback in {@link processGoal}. */
async function continueOrStop(goal: Goal): Promise<void> {
  if (goal.continuationCount >= goal.maxContinuations) {
    await settle(goal, 'stopped', 'Continuation limit reached.')
    return
  }
  await patchGoal(goal.id, { continuationCount: goal.continuationCount + 1 })
  await sendMessage(goal.sessionId, { text: CONTINUATION_PROMPT })
}

/** Advance one running goal by one turn. `patchGoal` mutates and returns the
 *  exact object `goal` already references (utils/goals.ts keeps one object per
 *  id in its cache, same as utils/task-queue.ts's records) — every patch below
 *  is immediately visible by reading `goal.*` again, no re-fetch needed.
 *
 *  No-ops (leaving everything exactly as-is, so the next call retries) when:
 *  the goal isn't running, its session's last assistant message is still the
 *  one already audited, the turn hasn't completed yet, or the audit call
 *  itself fails — a broken audit must never misjudge the goal, only delay it.
 *
 *  Exported so both the goal loop (plugins/goal-loop.ts) and the resume route
 *  can drive a goal: a goal resumed while its session sits idle has no turn
 *  coming to wake it, so the route calls this itself. */
export async function processGoal(goal: Goal): Promise<void> {
  if (goal.status !== 'running') return

  let messages: Message[]
  try {
    messages = await readMessages(goal.sessionId)
  } catch (error) {
    console.error(`[goal-loop] failed to read messages for goal ${goal.id}:`, error)
    return
  }

  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!last || last.id === goal.lastMessageId) return
  if (!last.completedAt) return // still busy — nothing to judge yet

  await patchGoal(goal.id, { tokensUsed: goal.tokensUsed + (last.usage?.totalTokens ?? 0) })

  /**
   *
   * A turn that ended in a provider error settles immediately — the "stopping
   * on a turn error" safety limit. Its "reply" isn't meaningful content for the
   * auditor.
   *
   **/
  if (last.error) {
    await patchGoal(goal.id, { lastMessageId: last.id })
    await settle(goal, 'error', errorSummary(last.error))
    return
  }

  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
    await patchGoal(goal.id, { lastMessageId: last.id })
    await settle(goal, 'budget-reached', 'Token budget reached.')
    return
  }

  const reply = replyText(last)
  if (!reply) {
    /**
     *
     * No prose to judge — a pure tool-call turn. Don't spend an audit call on
     * nothing; keep the loop moving as if the auditor said keep_going.
     *
     **/
    await patchGoal(goal.id, { lastMessageId: last.id })
    await continueOrStop(goal)
    return
  }

  /**
   *
   * Not while the machine is generating. The audit is a second call to the
   * same model, and a local runtime serves one request at a time — issuing it
   * alongside somebody's turn puts the machine in front of its own user.
   * Unlike a session title this cannot simply be skipped (the loop needs a
   * verdict), so it waits; if the machine is still busy after that, the pass
   * returns with `lastMessageId` untouched and the next one looks again.
   *
   **/
  if (!(await waitForIdleModel())) return

  await patchGoal(goal.id, { auditing: true })
  const audit = await runGoalAudit({ objective: goal.objective, reply })
  await patchGoal(goal.id, { auditing: false })

  /**
   *
   * The audit call failed — judge nothing. `lastMessageId` deliberately stays
   * put so the next pass looks at this same turn again.
   *
   **/
  if (!audit) return

  await patchGoal(goal.id, { lastMessageId: last.id, progressNote: audit.note })

  if (audit.verdict === 'done') {
    await settle(goal, 'done', audit.note || 'Objective achieved.')
    return
  }

  if (audit.verdict === 'stuck') {
    await patchGoal(goal.id, { stuckCount: goal.stuckCount + 1 })
    if (goal.stuckCount >= 3) {
      await settle(goal, 'stuck', audit.note || 'The agent seems stuck.')
      return
    }
  } else if (goal.stuckCount !== 0) {
    /**
     *
     * Any "keep going" verdict resets the stuck streak.
     *
     **/
    await patchGoal(goal.id, { stuckCount: 0 })
  }

  await continueOrStop(goal)
}
