import { describe, expect, it } from 'vitest'
import { isGoalActive, validateLimits, validateObjective, type GoalStatus } from './goals.js'

/**
 * ── The bounds on work nobody is watching ────────────────────────────────────
 *
 * A goal is the machine continuing on its own, so its two numbers are the only
 * thing standing between "keep going until it is done" and an unattended loop
 * spending someone's money overnight. They arrive as raw JSON from a route and
 * are the last check before the loop starts.
 *
 * `isGoalActive` is the other load-bearing one: several unattended paths gate on
 * it, notably the alert reporter, which must not notify once per continuation.
 * Getting it wrong in either direction is silent — a goal that never runs, or a
 * phone that buzzes forty times.
 *
 * The `goals` plugin had no tests at all (docs/STRUCTURE_REVIEW.md H-06).
 *
 **/

describe('validateObjective', () => {
  it('trims, because a trailing newline is not part of what was asked', () => {
    expect(validateObjective('  ship the thing  ')).toBe('ship the thing')
  })

  it('refuses an objective that says nothing', () => {
    for (const bad of ['', '   ', '\n\t', 42, null, undefined, {}]) {
      expect(() => validateObjective(bad)).toThrow()
    }
  })

  it('refuses one past the ceiling, measured AFTER trimming', () => {
    expect(validateObjective('a'.repeat(8_000))).toHaveLength(8_000)
    expect(() => validateObjective('a'.repeat(8_001))).toThrow()
    /** Whitespace does not count against the budget. */
    expect(validateObjective(`  ${'a'.repeat(8_000)}  `)).toHaveLength(8_000)
  })
})

describe('validateLimits', () => {
  it('has a default for both, because v1 has no settings page to set them from', () => {
    const limits = validateLimits(undefined, undefined)
    expect(limits.maxContinuations).toBeGreaterThan(0)
    expect(limits.tokenBudget).toBeNull()
  })

  it('treats null the same as absent — a client clearing a field is not an error', () => {
    expect(validateLimits(null, null)).toEqual(validateLimits(undefined, undefined))
  })

  it('takes a number a client sent as a string, which is what a form does', () => {
    expect(validateLimits('5', '2000')).toEqual({ maxContinuations: 5, tokenBudget: 2_000 })
  })

  it('refuses a continuation count that is not a whole number in range', () => {
    for (const bad of [0, -1, 1.5, 'many', Number.NaN, 10_000]) {
      expect(() => validateLimits(bad, undefined)).toThrow()
    }
  })

  it('refuses a token budget too small to finish a single turn', () => {
    expect(() => validateLimits(undefined, 999)).toThrow()
    expect(validateLimits(undefined, 1_000).tokenBudget).toBe(1_000)
  })

  it('refuses a fractional token budget rather than rounding it', () => {
    expect(() => validateLimits(undefined, 1_500.5)).toThrow()
  })
})

describe('isGoalActive', () => {
  it('drives running and paused, and nothing else', () => {
    expect(isGoalActive('running')).toBe(true)
    expect(isGoalActive('paused')).toBe(true)
  })

  it('leaves every terminal status alone — a finished goal must not be resumed by a tick', () => {
    const terminal: GoalStatus[] = ['done', 'stuck', 'budget-reached', 'stopped', 'error']
    for (const status of terminal) expect(isGoalActive(status)).toBe(false)
  })
})
