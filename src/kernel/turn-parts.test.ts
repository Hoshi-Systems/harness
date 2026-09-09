import { describe, expect, it } from 'vitest'

import { turnParts } from './turn-parts.js'

/**
 *
 * The regression these pin: a turn that asked questions mid-answer used to be
 * stored as [all tools, one text block] — so at turn end every `ui_ask` form
 * jumped above the prose and the dialog flattened into two piles. The stored
 * shape must follow the order things happened in, which `textAt` records.
 *
 **/

const tool = (callId: string, textAt?: number) => ({
  callId,
  name: 'ui_ask',
  status: 'completed',
  ...(textAt !== undefined ? { textAt } : {}),
})

describe('turnParts — the transcript keeps the order things happened in', () => {
  it('splits the prose at each tool call', () => {
    const parts = turnParts({
      reasoning: '',
      text: 'Which region?And done.',
      tools: [tool('c1', 14)],
    })
    expect(parts).toEqual([
      { type: 'text', text: 'Which region?A'.slice(0, 14) },
      expect.objectContaining({ type: 'tool', callId: 'c1' }),
      { type: 'text', text: 'nd done.' },
    ])
  })

  it('keeps consecutive tools adjacent — no empty text between them', () => {
    const parts = turnParts({ reasoning: '', text: 'intro', tools: [tool('c1', 5), tool('c2', 5)] })
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'tool'])
  })

  it('drops the trailing text part when a tool ends the turn', () => {
    const parts = turnParts({ reasoning: '', text: 'ask:', tools: [tool('c1', 4)] })
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool'])
  })

  it('keeps the seeded empty text shape for a turn with no tools', () => {
    expect(turnParts({ reasoning: '', text: '', tools: [] })).toEqual([{ type: 'text', text: '' }])
  })

  it('puts reasoning first, folded away from the answer', () => {
    const parts = turnParts({ reasoning: 'hm', text: 'a', tools: [tool('c1', 0)] })
    expect(parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'text'])
  })

  it('degrades a record with no anchor to the old tools-first shape rather than misplacing it', () => {
    const parts = turnParts({ reasoning: '', text: 'later prose', tools: [tool('c1')] })
    expect(parts.map((p) => p.type)).toEqual(['tool', 'text'])
  })

  it('clamps an anchor past the text instead of slicing out of range', () => {
    const parts = turnParts({ reasoning: '', text: 'ab', tools: [tool('c1', 99)] })
    expect(parts).toEqual([{ type: 'text', text: 'ab' }, expect.objectContaining({ type: 'tool' })])
  })

  it('carries the full tool state through', () => {
    const [part] = turnParts({
      reasoning: '',
      text: '',
      tools: [{ callId: 'c1', name: 'bash', status: 'completed', input: { cmd: 'ls' }, output: 'ok', ms: 12 }],
    })
    expect(part).toEqual({
      type: 'tool',
      name: 'bash',
      callId: 'c1',
      state: { status: 'completed', input: { cmd: 'ls' }, output: 'ok', ms: 12 },
    })
  })
})
