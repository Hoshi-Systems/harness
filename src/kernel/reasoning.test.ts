import { describe, expect, it } from 'vitest'
import { reasoningBody } from './reasoning.js'

/**
 * ── One setting, three wires ─────────────────────────────────────────────────
 *
 * Models do not agree on what "think harder" is. The open catalogue publishes
 * three controls — a named effort (2188 models), a bare on/off toggle (1016), a
 * token budget (496) — and the first version of this feature sent all three the
 * same `reasoning_effort` field. A Nemotron, whose only settings are on and
 * off, was being told `medium`.
 *
 * The failure is silent from every direction: the request is either refused
 * with a provider error nobody connects to a settings chip, or the field is
 * ignored and the model reasons exactly as it always did. So the mapping is
 * pinned here, one case each.
 *
 **/

describe('the request a thinking setting becomes', () => {
  it('is reasoning_effort for a model with named levels', () => {
    expect(reasoningBody('high', { mode: 'effort' })).toEqual({ reasoning_effort: 'high' })
  })

  it('is a template switch for a toggle model, both ways', () => {
    /**
     *
     * `chat_template_kwargs`, not a sampling parameter: for the hybrid models
     * (Nemotron, Qwen3) thinking is a chat-template branch, and that is where
     * vLLM, SGLang and NIM read it from.
     *
     **/
    expect(reasoningBody('on', { mode: 'toggle' })).toEqual({ chat_template_kwargs: { thinking: true } })
    expect(reasoningBody('off', { mode: 'toggle' })).toEqual({ chat_template_kwargs: { thinking: false } })
  })

  it('never sends an effort word to a toggle model', () => {
    /**
     *
     * The actual bug: `medium` is not a level a toggle model has. Whatever a
     * client sends, what leaves the machine must be the switch.
     *
     **/
    expect(reasoningBody('medium', { mode: 'toggle' })).toEqual({ chat_template_kwargs: { thinking: true } })
  })

  it('is a token allowance for a budget model, never below its minimum', () => {
    expect(reasoningBody('medium', { mode: 'budget' })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16_384 },
    })
    expect(reasoningBody('low', { mode: 'budget', budgetMin: 8_192 })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8_192 },
    })
  })

  it('sends nothing for auto, whatever the model is', () => {
    for (const mode of ['effort', 'toggle', 'budget', null] as const) {
      expect(reasoningBody('auto', { mode }), `auto leaked a field for ${mode}`).toBeNull()
    }
  })

  it('falls back to the ordinary field when the catalogue says nothing', () => {
    /**
     *
     * A self-hosted model has no catalogue entry, and silence is not "cannot
     * think" — the common OpenAI field is the best available guess and the one
     * such endpoints understand if they understand anything.
     *
     **/
    expect(reasoningBody('high', { mode: null })).toEqual({ reasoning_effort: 'high' })
  })
})
