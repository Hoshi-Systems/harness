import { describe, expect, it } from 'vitest'
import { buildUserMessage } from './attachments.js'

/**
 * ── An attachment a model cannot read ────────────────────────────────────────
 *
 * A picture sent to a text-only model does not produce a worse answer. The
 * provider rejects the whole request — `unknown variant \`image_url\`, expected
 * \`text\`` — and because the picture stays in the conversation, every later turn
 * in that session dies the same way. One attachment ends the session.
 *
 * So the question these ask is not "is the image included" but "does the turn
 * survive", and separately "is the model told what it is missing" — a model that
 * silently receives nothing invents a description of a picture it never saw.
 *
 **/

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function partsOf(message: ReturnType<typeof buildUserMessage>) {
  if (typeof message === 'string') return []
  const content = message[0]?.content
  return Array.isArray(content) ? content : []
}

describe('an image for a model that cannot read images', () => {
  it('never reaches the provider as an image part', () => {
    const parts = partsOf(
      buildUserMessage('what is this?', [{ filename: 'shot.png', mime: 'image/png', url: PNG }], {
        acceptsImages: false,
      }),
    )
    expect(parts.some((part) => part.type === 'image')).toBe(false)
  })

  it('is described in words, naming the file', () => {
    const parts = partsOf(
      buildUserMessage('what is this?', [{ filename: 'shot.png', mime: 'image/png', url: PNG }], {
        acceptsImages: false,
      }),
    )
    const text = parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    expect(text).toContain('shot.png')
    expect(text).toContain('cannot read images')
    /**
     *
     * The question itself still has to be in there — a turn that loses the
     * user's words to an attachment problem is a worse failure than the one
     * being fixed.
     *
     **/
    expect(text).toContain('what is this?')
  })

  it('still sends the picture to a model that can read it', () => {
    const parts = partsOf(
      buildUserMessage('what is this?', [{ filename: 'shot.png', mime: 'image/png', url: PNG }], {
        acceptsImages: true,
      }),
    )
    expect(parts.some((part) => part.type === 'image')).toBe(true)
  })

  it('defaults to sending it, because silence is not "text only"', () => {
    /**
     *
     * A custom endpoint has no catalogue entry at all. Reading that as "no
     * images" would take a working feature away from every self-hosted model.
     *
     **/
    const parts = partsOf(buildUserMessage('what is this?', [{ filename: 'shot.png', mime: 'image/png', url: PNG }]))
    expect(parts.some((part) => part.type === 'image')).toBe(true)
  })
})
