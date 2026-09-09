/**
 *
 * Usage and budget wire types — spend rollups and the ceilings set against them.
 *
 **/

/** What a budget is set against. */
export type BudgetScope = 'org' | 'user' | 'machine'

/** The window a budget's ceiling applies over. */
export type BudgetPeriod = 'day' | 'month'

/** What happens at the ceiling: a warning, or a stop.
 *
 *  A value, with the type derived from it, so a server that has to CHECK an
 *  incoming action reads the same list a client renders the picker from. It was
 *  a bare union, which left `services/usage-budgets.ts` restating `['warn',
 *  'enforce']` privately to do the check — a second list, and the wire package
 *  is exactly where a second list is not supposed to be (A-04). */
export const BUDGET_ACTIONS = ['warn', 'enforce'] as const
export type BudgetAction = (typeof BUDGET_ACTIONS)[number]

export interface BudgetState {
  id: string
  scope: BudgetScope
  scopeId: string
  scopeLabel: string | null
  period: BudgetPeriod
  action: BudgetAction
  limitCost: number
  /** Spend inside the current period for this budget's scope. */
  spentCost: number
  periodStart: string
  periodEnd: string
  /** Past the ceiling right now. `action` decides what that means. */
  exceeded: boolean
}

/**
 * ── Wire mappers ─────────────────────────────────────────────────────────────
 *
 **/
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  turns: number
}

export interface OrgBudgetInput {
  scope: BudgetScope
  scopeId: string
  limitCost: number
  period: BudgetPeriod
  action: BudgetAction
}
