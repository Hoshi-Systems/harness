import { describe, expect, it } from 'vitest'
import { conditionHolds, evaluateWorkflowCondition, parseWorkflowCondition } from './workflow-condition.js'

/** A run context shaped exactly like buildRunContext's (workflow-runs.ts). */
const CONTEXT = {
  trigger: {
    body: { action: 'opened', issue: { title: 'Login is broken', labels: ['bug', 'p1'] } },
    headers: {},
    query: {},
  },
  input: { action: 'opened' },
  steps: {
    triage: { text: 'Looks like a real bug.', output: { severity: 'high', score: 8, actionable: true, notes: '' } },
    empty: { text: '', output: null },
  },
}

function holds(expression: string, context: Record<string, unknown> = CONTEXT): boolean {
  return evaluateWorkflowCondition(parseWorkflowCondition(expression), context)
}

describe('presence', () => {
  it('treats a resolved, non-empty path as true', () => {
    expect(holds('steps.triage.text')).toBe(true)
    expect(holds('steps.triage.output.actionable')).toBe(true)
    expect(holds('steps.triage.output.score')).toBe(true)
  })

  it('treats absent, empty and zero-ish values as false', () => {
    expect(holds('steps.nope.text')).toBe(false)
    expect(holds('steps.empty.text')).toBe(false)
    expect(holds('steps.empty.output')).toBe(false)
    expect(holds('steps.triage.output.notes')).toBe(false)
  })

  it('reads an empty array or object as nothing here', () => {
    expect(holds('a', { a: [] })).toBe(false)
    expect(holds('a', { a: {} })).toBe(false)
    expect(holds('a', { a: [1] })).toBe(true)
  })
})

describe('comparison', () => {
  it('compares strings and numbers', () => {
    expect(holds('steps.triage.output.severity == "high"')).toBe(true)
    expect(holds('steps.triage.output.severity != "low"')).toBe(true)
    expect(holds('steps.triage.output.score > 5')).toBe(true)
    expect(holds('steps.triage.output.score >= 8')).toBe(true)
    expect(holds('steps.triage.output.score < 5')).toBe(false)
  })

  it('compares a numeric string to a number — a JSON output routinely stringifies', () => {
    expect(holds('a == 3', { a: '3' })).toBe(true)
    expect(holds('a > 2', { a: '3' })).toBe(true)
  })

  it('compares objects structurally, never by reference', () => {
    expect(holds('a == b', { a: { x: 1 }, b: { x: 1 } })).toBe(true)
    expect(holds('a == b', { a: { x: 1 }, b: { x: 2 } })).toBe(false)
  })

  it('is false rather than an error when the values cannot be ordered', () => {
    expect(holds('a > b', { a: { x: 1 }, b: 2 })).toBe(false)
    expect(holds('missing > 3')).toBe(false)
  })

  it('handles contains over strings, arrays and object keys', () => {
    expect(holds('trigger.body.issue.title contains "broken"')).toBe(true)
    expect(holds('trigger.body.issue.labels contains "p1"')).toBe(true)
    expect(holds('trigger.body.issue.labels contains "p2"')).toBe(false)
    expect(holds('trigger.body contains "issue"')).toBe(true)
  })
})

describe('boolean combination', () => {
  it('honours and/or/not and their symbolic aliases', () => {
    expect(holds('steps.triage.output.severity == "high" and steps.triage.output.score > 5')).toBe(true)
    expect(holds('steps.triage.output.severity == "low" or steps.triage.output.score > 5')).toBe(true)
    expect(holds('not steps.empty.text')).toBe(true)
    expect(holds('!steps.empty.text && steps.triage.text')).toBe(true)
    expect(holds('steps.triage.text || nope')).toBe(true)
  })

  it('binds and tighter than or', () => {
    /**
     *
     * false and false or true → (false and false) or true → true
     *
     **/
    expect(holds('nope and nope or steps.triage.text')).toBe(true)
    /**
     *
     * Parenthesized the other way it must be false.
     *
     **/
    expect(holds('nope and (nope or steps.triage.text)')).toBe(false)
  })

  it('reads the literal keywords', () => {
    expect(holds('true')).toBe(true)
    expect(holds('false')).toBe(false)
    expect(holds('steps.empty.output == null')).toBe(true)
  })
})

describe('parsing', () => {
  it('rejects anything outside the closed operator set', () => {
    /**
     *
     * No arbitrary code, ever — a published workflow runs on someone else's box.
     *
     **/
    expect(() => parseWorkflowCondition('process.exit(1)')).toThrow()
    expect(() => parseWorkflowCondition('a + b')).toThrow()
    expect(() => parseWorkflowCondition('a =~ /b/')).toThrow()
    expect(() => parseWorkflowCondition('`${a}`')).toThrow()
  })

  it('rejects malformed expressions', () => {
    expect(() => parseWorkflowCondition('')).toThrow()
    expect(() => parseWorkflowCondition('(a')).toThrow()
    expect(() => parseWorkflowCondition('a ==')).toThrow()
    expect(() => parseWorkflowCondition('a "b"')).toThrow()
    expect(() => parseWorkflowCondition('"unterminated')).toThrow()
  })

  it('rejects an over-long or over-nested expression', () => {
    expect(() => parseWorkflowCondition('a'.repeat(501))).toThrow()
    expect(() => parseWorkflowCondition('('.repeat(25) + 'a' + ')'.repeat(25))).toThrow()
  })

  it('keeps paths that merely start with an operator word', () => {
    expect(holds('android', { android: true })).toBe(true)
    expect(holds('steps.notes.text', { steps: { notes: { text: 'x' } } })).toBe(true)
  })
})

describe('conditionHolds — the executor entry point', () => {
  it('runs the step when the stored expression no longer parses', () => {
    /**
     *
     * Skipping work over a syntax error is the worse failure of the two.
     *
     **/
    expect(conditionHolds('a ==', CONTEXT)).toBe(true)
  })

  it('never throws, whatever the context holds', () => {
    expect(conditionHolds('a.b.c.d == "x"', {})).toBe(false)
    expect(conditionHolds('a > b', { a: null, b: undefined })).toBe(false)
  })
})
