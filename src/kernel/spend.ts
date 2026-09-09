import type { TokenUsage } from '@openharness/core'
import { publishMachineEvent } from './events.js'
import { getSpendBySession, recordUsageEvent } from './usage.js'
import { tell } from './host-ports.js'

/**
 * ── What a turn cost ─────────────────────────────────────────────────────────
 *
 * The seam between the agent loop and the machine's spend ledger. It exists so
 * engine/turns.ts states the fact once — "this turn is over and it cost this" —
 * and everything downstream of that fact (the ledger, the budgets built on it,
 * the org rollup, the clients watching) happens here.
 *
 * This used to be the browser's job: the app POSTed /usage/events after the
 * answer landed. Spend was therefore only counted while somebody was looking,
 * and a scheduled run, a goal working overnight, or a tab closed mid-answer
 * cost real money and appeared in no total.
 *
 **/

export interface TurnSpend {
  sessionId: string
  messageId: string
  /** `provider/model`, as resolved — never what the caller asked for. */
  model: string | null
  usage: TokenUsage | null
  /** Dollars, or null when the model has no published price. Null is recorded
   *  as an unpriced turn, NOT as a free one (utils/usage.ts). */
  cost: number | null
}

function tokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Record a finished turn's tokens and cost, then tell everyone who is watching.
 *
 *  Never throws: a ledger write that failed must not turn a delivered answer
 *  into a failed turn. */
export async function recordTurnSpend(spend: TurnSpend): Promise<void> {
  try {
    await recordUsageEvent({
      ocSessionId: spend.sessionId,
      messageId: spend.messageId,
      model: spend.model,
      inputTokens: tokens(spend.usage?.inputTokens),
      outputTokens: tokens(spend.usage?.outputTokens),
      /**
       *
       * The harness reports input, output and total — nothing else. Reasoning
       * and cache tokens stay columns because the Platform rollup speaks that
       * shape, and they are honestly zero rather than guessed.
       *
       **/
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: spend.cost,
    })

    /**
     *
     * The session's running total, straight from the ledger that was just
     * written — so a client never has to add up turns itself and can never
     * drift from what the machine holds.
     *
     **/
    const session = (await getSpendBySession())[spend.sessionId] ?? { cost: 0, unpricedTurns: 0 }
    publishMachineEvent('session.spend', { sessionId: spend.sessionId, ...session })
  } catch (error) {
    console.error('[engine] failed to record turn spend:', error)
    return
  }

  /**
   *
   * A completed turn is the natural budget checkpoint: it is the only moment
   * this machine's spend actually moves. What happens next — pushing the day's
   * aggregate to the Platform, re-reading the budgets it binds us to — belongs
   * to whoever is hosting this kernel, because a machine with no organization
   * behind it has neither (kernel/ports.ts).
   *
   **/
  tell('spendRecorded', (port) =>
    port({ sessionId: spend.sessionId, messageId: spend.messageId, model: spend.model, cost: spend.cost }),
  )
}
