import { describe, expect, it } from 'vitest'
import { extractProfileEmphasis } from './profile.js'

/**
 * ── Reading the emphasis back out of the agent file ──────────────────────────
 *
 * The seeder writes it between markers; the agent card reads it from between
 * the same markers. Everything outside them is the agent's own instructions and
 * must never leak onto a card.
 *
 **/

const AGENT = `---
description: The user's personal agent
---

You are the user's personal agent.

## 6. Profile emphasis

<!-- hoshi:profile-emphasis -->
This is a **developer** machine: lean toward shipping code.
<!-- /hoshi:profile-emphasis -->
`

describe('extractProfileEmphasis', () => {
  it('returns only what sits between the markers', () => {
    expect(extractProfileEmphasis(AGENT)).toBe('This is a **developer** machine: lean toward shipping code.')
  })

  it('is null for a file without markers, and for an empty region', () => {
    expect(extractProfileEmphasis('You are the personal agent.')).toBeNull()
    expect(extractProfileEmphasis('<!-- hoshi:profile-emphasis -->\n\n<!-- /hoshi:profile-emphasis -->')).toBeNull()
  })

  it('is null when the closing marker is missing rather than reading to the end', () => {
    expect(extractProfileEmphasis('<!-- hoshi:profile-emphasis -->\nsomething\nand the rest of the file')).toBeNull()
  })
})
