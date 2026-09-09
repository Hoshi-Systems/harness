import { describe, expect, it } from 'vitest'
import { describeStep, planFrom } from './turns.js'

/**
 * ── What a task row is told, and what it must never be told ──────────────────
 *
 * These two produce the second line of a sidebar row for a session nobody has
 * open. Nothing downstream can check them: the row renders whatever arrives, so
 * a plan read wrong is a number a person trusts and acts on.
 *
 * The distinction that carries the weight is `undefined` vs `null`. A call that
 * is not a plan tool must leave the stored plan ALONE — a `read` in the middle
 * of a seven-item plan does not end it — while a plan whose items are all
 * finished must clear it, because "7/7" pinned to a row forever is worse than
 * saying nothing.
 *
 **/
describe('the plan a row reports', () => {
  const todos = (...statuses: string[]) => ({ todos: statuses.map((status) => ({ content: 'x', status })) })

  it('counts completed and cancelled as done', () => {
    expect(planFrom('todowrite', todos('completed', 'cancelled', 'pending', 'in_progress'))).toEqual({
      done: 2,
      total: 4,
    })
  })

  it('leaves the plan alone for a call that is not a plan tool', () => {
    expect(planFrom('read', { filePath: 'a.ts' })).toBeUndefined()
    expect(planFrom('bash', todos('pending'))).toBeUndefined()
  })

  it('clears a plan whose every item is finished, rather than reporting 7/7 forever', () => {
    expect(planFrom('todowrite', todos('completed', 'cancelled'))).toBeNull()
  })

  it('clears an empty plan rather than reporting 0/0', () => {
    expect(planFrom('todowrite', { todos: [] })).toBeNull()
    expect(planFrom('todoread', {})).toBeNull()
  })

  it('reads the tool name however it is cased', () => {
    expect(planFrom('TodoWrite', todos('pending', 'completed'))).toEqual({ done: 1, total: 2 })
  })

  it('is not thrown by input that is not a plan at all', () => {
    expect(planFrom('todowrite', { todos: 'nope' })).toBeNull()
    expect(planFrom('todowrite', null)).toBeNull()
    expect(planFrom('todowrite', { todos: [{}, 7, null] })).toEqual({ done: 0, total: 3 })
  })
})

describe('the step a row reports', () => {
  it('names the tool and the one argument that says which thing it is about', () => {
    expect(describeStep('edit', { filePath: 'app/composables/useMachineUrl.ts' })).toEqual({
      tool: 'edit',
      subject: 'app/composables/useMachineUrl.ts',
      field: 'filePath',
    })
    expect(describeStep('bash', { command: 'pnpm verify' })).toEqual({
      tool: 'bash',
      subject: 'pnpm verify',
      field: 'command',
    })
  })

  it('falls back to the bare tool when nothing identifies the target', () => {
    expect(describeStep('memory_save', {})).toEqual({ tool: 'memory_save', subject: null, field: null })
    expect(describeStep('list', { recursive: true })).toEqual({ tool: 'list', subject: null, field: null })
  })

  /**
   *
   * The subject is reported WHOLE. It used to be truncated here, which put a
   * layout decision — how much fits in a ~200px sidebar row — inside the machine,
   * where it applied to the TUI and the desktop panel too, and could not be
   * undone by any of them. A client shortens what it cannot fit.
   *
   **/
  it('does not truncate: how much fits is the client’s business, not the machine’s', () => {
    const long = 'x'.repeat(200)
    expect(describeStep('bash', { command: long })).toEqual({ tool: 'bash', subject: long, field: 'command' })
  })

  /**
   *
   * The FIELD is half the answer. "notes.md" under `filePath` is a file being
   * read; under `pattern` it is a search. A client phrasing the call needs to
   * know which, and only the machine can say.
   *
   **/
  it('reports WHICH argument the subject came from', () => {
    expect(describeStep('grep', { pattern: 'beetles' }).field).toBe('pattern')
    expect(describeStep('task', { agent: 'reviewer', prompt: 'look' }).field).toBe('agent')
    expect(describeStep('skill', { name: 'custom-protocol' }).field).toBe('name')
  })

  it('survives input that is not an object', () => {
    expect(describeStep('read', null)).toEqual({ tool: 'read', subject: null, field: null })
    expect(describeStep('read', 'nope')).toEqual({ tool: 'read', subject: null, field: null })
  })
})
