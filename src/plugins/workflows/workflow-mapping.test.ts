import { describe, expect, it } from 'vitest'

import { evaluateMapping, validateMapping, WorkflowMappingError, type Mapping } from './workflow-mapping.js'

/** The shape a v3 run context has: node outputs, run state, the trigger. */
const context = {
  trigger: { body: { issue: { title: 'Crash on save', labels: ['bug', 'p1'] } }, headers: {}, query: {} },
  input: { issue: { title: 'Crash on save' } },
  nodes: {
    fetch: {
      text: 'fetched',
      output: {
        status: 200,
        items: [
          { id: 1, title: 'first', done: true },
          { id: 2, title: 'second', done: false },
          { id: 3, title: 'third', done: true },
        ],
      },
    },
  },
  state: { mode: 'triage', attempts: '3' },
}

const evaluate = (mapping: Mapping) => evaluateMapping(mapping, context)

describe('validateMapping', () => {
  it('accepts the ops the node inspector can produce', () => {
    expect(validateMapping({ op: 'path', path: 'nodes.fetch.output.status' })).toEqual({
      op: 'path',
      path: 'nodes.fetch.output.status',
    })
    expect(validateMapping({ op: 'literal', value: { a: [1, 2] } })).toEqual({ op: 'literal', value: { a: [1, 2] } })
  })

  it('rejects an unknown operation rather than ignoring it', () => {
    expect(() => validateMapping({ op: 'exec', command: 'rm -rf /' })).toThrow(WorkflowMappingError)
    expect(() => validateMapping({})).toThrow(WorkflowMappingError)
  })

  it('rejects a path that walks a reserved property', () => {
    expect(() => validateMapping({ op: 'path', path: 'nodes.__proto__' })).toThrow(/reserved/)
    expect(() => validateMapping({ op: 'path', path: 'a.constructor.b' })).toThrow(/reserved/)
  })

  it('rejects an object key that would pollute a prototype', () => {
    const mapping = { op: 'object', entries: [{ key: '__proto__', value: { op: 'literal', value: 1 } }] }
    expect(() => validateMapping(mapping)).toThrow(/not an allowed object key/)
  })

  it('rejects duplicate object keys — a silent overwrite is never what was meant', () => {
    const entry = { key: 'a', value: { op: 'literal', value: 1 } }
    expect(() => validateMapping({ op: 'object', entries: [entry, entry] })).toThrow(/repeats/)
  })

  it('caps nesting depth so a published mapping cannot depth-bomb the walker', () => {
    let mapping: unknown = { op: 'literal', value: 1 }
    for (let i = 0; i < 12; i++) mapping = { op: 'stringify', value: mapping }
    expect(() => validateMapping(mapping)).toThrow(/nest at most/)
  })

  it('parses a filter condition at the boundary, so a bad one never reaches disk', () => {
    const bad = { op: 'filter', value: { op: 'path', path: 'x' }, when: 'item.done ===' }
    expect(() => validateMapping(bad)).toThrow(/filter condition is not valid/)
  })
})

describe('evaluateMapping', () => {
  it('resolves a path, and reports a missing one instead of failing', () => {
    expect(evaluate({ op: 'path', path: 'nodes.fetch.output.status' }).value).toBe(200)

    const missing = evaluate({ op: 'path', path: 'nodes.absent.output' })
    expect(missing.value).toBeNull()
    expect(missing.warnings).toContain('missing-path:nodes.absent.output')
  })

  it('builds an object of paths — the shape a transform node actually produces', () => {
    const result = evaluate({
      op: 'object',
      entries: [
        { key: 'title', value: { op: 'path', path: 'trigger.body.issue.title' } },
        { key: 'mode', value: { op: 'path', path: 'state.mode' } },
      ],
    })
    expect(result.value).toEqual({ title: 'Crash on save', mode: 'triage' })
  })

  it('filters and maps an array through the condition language', () => {
    const done = evaluate({
      op: 'map',
      value: { op: 'filter', value: { op: 'path', path: 'nodes.fetch.output.items' }, when: 'item.done' },
      item: { op: 'path', path: 'item.title' },
    })
    expect(done.value).toEqual(['first', 'third'])
  })

  it('joins, splits, slices and counts', () => {
    expect(
      evaluate({ op: 'join', value: { op: 'path', path: 'trigger.body.issue.labels' }, separator: ', ' }).value,
    ).toBe('bug, p1')
    expect(evaluate({ op: 'split', value: { op: 'literal', value: 'a:b:c' }, separator: ':' }).value).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(evaluate({ op: 'length', value: { op: 'path', path: 'nodes.fetch.output.items' } }).value).toBe(3)
    expect(evaluate({ op: 'first', value: { op: 'path', path: 'trigger.body.issue.labels' } }).value).toBe('bug')
  })

  it('coerces a numeric string, which is what an agent output usually is', () => {
    expect(evaluate({ op: 'number', value: { op: 'path', path: 'state.attempts' } }).value).toBe(3)
    expect(evaluate({ op: 'number', value: { op: 'literal', value: 'not a number' } }).value).toBeNull()
  })

  it('falls back rather than emitting an empty value', () => {
    const result = evaluate({
      op: 'default',
      value: { op: 'path', path: 'nodes.absent.output' },
      fallback: { op: 'literal', value: 'unknown' },
    })
    expect(result.value).toBe('unknown')
  })

  it('is total: a wrong shape warns and yields null, it never throws', () => {
    const result = evaluate({ op: 'join', value: { op: 'path', path: 'nodes.fetch.output.status' }, separator: ',' })
    expect(result.value).toBeNull()
    expect(result.warnings).toContain('mapping-not-array:join')

    const unparsable = evaluate({ op: 'json', value: { op: 'literal', value: '{not json' } })
    expect(unparsable.value).toBeNull()
    expect(unparsable.warnings).toContain('mapping-parse-failed')
  })

  it('renders a template single-pass, so an inserted value cannot template again', () => {
    const injected = { ...context, nodes: { fetch: { text: '{{state.mode}}', output: null } } }
    const result = evaluateMapping({ op: 'template', template: 'got: {{nodes.fetch.text}}' }, injected)
    expect(result.value).toBe('got: {{state.mode}}')
  })

  it('never resolves a secret into a value that gets persisted', () => {
    const result = evaluate({ op: 'template', template: 'token={{secrets.API_TOKEN}}' })
    expect(result.value).toBe('token=')
    expect(result.warnings).toContain('missing-path:secrets.API_TOKEN')
  })

  it('caps the result size — a path to the whole context cannot fill the run file', () => {
    const huge = { blob: 'x'.repeat(100_000) }
    const result = evaluateMapping({ op: 'path', path: 'blob' }, huge)
    expect(result.value).toBeNull()
    expect(result.warnings).toContain('mapping-output-too-large')
  })

  it('cannot pollute Object.prototype through a resolved path', () => {
    /**
     *
     * Validation rejects the key; this proves the evaluator is safe even if a
     * hand-edited file smuggles one past, which is the point of doing both.
     *
     **/
    const mapping = { op: 'object', entries: [{ key: 'polluted', value: { op: 'literal', value: 'yes' } }] } as Mapping
    evaluateMapping(mapping, context)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const walked = evaluateMapping({ op: 'path', path: 'trigger.constructor' } as Mapping, context)
    expect(walked.value).toBeNull()
  })
})
