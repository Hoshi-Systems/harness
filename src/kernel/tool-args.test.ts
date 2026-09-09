import { describe, expect, it } from 'vitest'
import { jsonish, z } from '../plugins/define-tool.js'

/**
 * ── Arguments a model actually sends ─────────────────────────────────────────
 *
 * Double-encoding is a routine model mistake: an array of objects arrives as an
 * array of JSON strings. `memory_consolidate` met it in the wild — zod refused,
 * the tool never ran, and the model read the validation error, misunderstood it,
 * and told the person their memory had been consolidated. The refusal was
 * correct and the outcome was a confident lie, which is the worst pair.
 *
 * Tested from here because this is where the gate runs: the plugin package has
 * no suite of its own, and adding one that neither `pnpm verify` nor CI knows
 * about would be a test nobody runs.
 *
 **/

const entry = z.object({ name: z.string(), content: z.string() })

describe('an argument that arrived as JSON text', () => {
  it('is parsed into the object it was meant to be', () => {
    expect(jsonish(entry).parse('{"name":"name","content":"Vlad"}')).toEqual({ name: 'name', content: 'Vlad' })
  })

  it('leaves a real object alone', () => {
    const value = { name: 'name', content: 'Vlad' }
    expect(jsonish(entry).parse(value)).toEqual(value)
  })

  it('still refuses text that is genuinely the wrong shape', () => {
    /**
     *
     * Tolerance is for encoding, never for meaning: JSON that parses into the
     * wrong thing must fail with the real schema's own message, which is what
     * the model needs in order to correct itself.
     *
     **/
    expect(() => jsonish(entry).parse('{"name":"name"}')).toThrow()
    expect(() => jsonish(entry).parse('not json at all')).toThrow()
  })

  it('handles the exact call that failed', () => {
    const replace = z.array(jsonish(entry))
    expect(replace.parse(['{"name":"name","content":"Vlad"}'])).toEqual([{ name: 'name', content: 'Vlad' }])
  })
})
