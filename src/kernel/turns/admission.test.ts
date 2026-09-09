import { describe, expect, it } from 'vitest'

import { refuseTurn, TURN_REFUSAL_MESSAGE, type TurnState } from './admission.js'

/**
 *
 * The two rules that decide whether a turn starts, as a table.
 *
 * Both were inline in `sendMessage` and neither appeared in any suite —
 * `TurnBusyError` and `SpendBlockedError` were untested. That matters most for
 * the spend one, which exists BECAUSE of a defect of exactly this kind:
 * enforcement lived in the retired proxy's turn gate, and the move into this
 * package left the org-spend plugin still computing the verdict, still
 * answering `spendBlocked`, still pushing the event a client renders as
 * blocked — while every turn started anyway.
 *
 **/
const state = (over: Partial<TurnState> = {}): TurnState => ({ running: false, spendBlocked: false, ...over })

describe('refuseTurn', () => {
  it.each<[string, TurnState, ReturnType<typeof refuseTurn>]>([
    ['an idle session with budget left', state(), null],
    ['a session already generating', state({ running: true }), 'busy'],
    ['a machine over its spend limit', state({ spendBlocked: true }), 'spend-blocked'],
    [
      'both at once — busy wins, because waiting is the actionable answer',
      state({ running: true, spendBlocked: true }),
      'busy',
    ],
  ])('%s', (_case, input, expected) => {
    expect(refuseTurn(input)).toBe(expected)
  })

  it('says nothing about a session that does not exist — that is answered before this', () => {
    expect(refuseTurn(state())).toBeNull()
  })

  it('has a message for every refusal it can return', () => {
    for (const refusal of ['busy', 'spend-blocked'] as const) {
      expect(TURN_REFUSAL_MESSAGE[refusal]).toBeTruthy()
    }
  })

  it('names no amount and no limit in the spend message — the client already has the number', () => {
    expect(TURN_REFUSAL_MESSAGE['spend-blocked']).not.toMatch(/\d/)
  })
})
