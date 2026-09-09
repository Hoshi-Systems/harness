/**
 * ── Whether a turn may start ─────────────────────────────────────────────────
 *
 * Two refusals with different consequences for the caller, so they are a
 * decision rather than a pair of `if`s in the middle of a 160-line function: a
 * client shows "already generating" as a transient state it can retry out of,
 * while a spend refusal is an administrator's problem and retrying changes
 * nothing.
 *
 * The rules were inline and untested. `TurnBusyError` and `SpendBlockedError`
 * appeared in no suite at all — which matters because the SECOND one exists
 * from a defect of exactly this kind: enforcement lived in the retired proxy's
 * turn gate, and the move into this package left the org-spend plugin still
 * computing the verdict, still answering `spendBlocked`, still pushing the
 * event a client renders as blocked, while every turn started anyway.
 *
 * Pure on purpose — it is handed the state rather than reading it, so the table
 * of cases is a table.
 *
 **/

export type TurnRefusal = 'busy' | 'spend-blocked'

export interface TurnState {
  /** Whether this session is already generating. */
  running: boolean
  /** Whether a spend limit the machine must not exceed has been reached. */
  spendBlocked: boolean
}

/**
 *
 * The first reason this turn may not start, or null.
 *
 * ORDER is part of the contract: busy comes before spend because the caller is
 * being told what to do next, and "wait for the turn in front of you" is
 * actionable where "ask an administrator" is not. A session that is already
 * generating tells you nothing about the budget either way.
 *
 * Whether the session EXISTS is not here. That is a question about the request,
 * answered before this one is asked — and keeping it out is what lets the
 * caller's `session` stay narrowed to a real one.
 *
 **/
export function refuseTurn(state: TurnState): TurnRefusal | null {
  if (state.running) return 'busy'
  if (state.spendBlocked) return 'spend-blocked'
  return null
}

/** What a refusal says to whoever asked. Deliberately neutral about WHOSE limit
 *  and HOW MUCH: the machine's budget state rides on the event stream, and a
 *  client that renders "blocked" already has the number. */
export const TURN_REFUSAL_MESSAGE: Record<TurnRefusal, string> = {
  busy: 'This session is already generating.',
  'spend-blocked': 'A spend limit for this machine has been reached; an administrator can raise it.',
}
