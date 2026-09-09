import { describe, expect, it } from 'vitest'
import { buildUserMessage } from './attachments.js'

/**
 * ── A message that is only an attachment ─────────────────────────────────────
 *
 * "Look at this" is a complete thing to say, and the composer has always agreed:
 * it enables Send the moment anything is staged. The machine did not — the send
 * route demanded text and answered 400 — so the picture sat on screen with no
 * way to hand it over, which reads as an upload that failed rather than as a
 * rule nobody mentioned.
 *
 **/

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const file = { filename: 'shot.png', mime: 'image/png', url: PNG }

function content(message: ReturnType<typeof buildUserMessage>) {
  if (typeof message === 'string') return []
  const parts = message[0]?.content
  return Array.isArray(parts) ? parts : []
}

describe('an attachment with no words', () => {
  it('is a message: the file goes, and nothing else is invented', () => {
    const parts = content(buildUserMessage('', [file]))
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('image')
  })

  it('carries no empty text part — a blank line is not a question', () => {
    /**
     *
     * An empty string beside the picture is something the model has to
     * interpret, and something the transcript renders as a bubble the person
     * never wrote.
     *
     **/
    const parts = content(buildUserMessage('   ', [file]))
    expect(parts.some((part) => part.type === 'text' && !part.text.trim())).toBe(false)
  })

  it('still puts the words after the material when there are words', () => {
    const parts = content(buildUserMessage('what is this?', [file]))
    expect(parts.map((part) => part.type)).toEqual(['image', 'text'])
  })
})
