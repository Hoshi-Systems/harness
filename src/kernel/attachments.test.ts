import { describe, expect, it } from 'vitest'
import { AttachmentTooLargeError, buildUserMessage, MAX_IMAGE_BYTES, textBudgetFor } from './attachments.js'

const dataUrl = (mime: string, body: string) => `data:${mime};base64,${Buffer.from(body, 'utf8').toString('base64')}`

describe('buildUserMessage', () => {
  it('leaves an ordinary turn exactly as it was', () => {
    /**
     *
     * No attachments must mean no change in what the model receives — this is
     * the path every other turn in the product takes.
     *
     **/
    expect(buildUserMessage('hello', [])).toBe('hello')
  })

  it('inlines a text document under its own name', () => {
    const message = buildUserMessage('What is the release name?', [
      { filename: 'notes.txt', mime: 'text/plain', url: dataUrl('text/plain', 'Release name: BIG-PICKLE') },
    ])
    expect(Array.isArray(message)).toBe(true)
    const parts = (message as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content
    expect(parts[0]).toEqual({
      type: 'text',
      text: '<file name="notes.txt">\nRelease name: BIG-PICKLE\n</file>',
    })
    /**
     *
     * The question comes after the material it is about.
     *
     **/
    expect(parts.at(-1)).toEqual({ type: 'text', text: 'What is the release name?' })
  })

  it('hands an image over as an image, not as text', () => {
    const url = dataUrl('image/png', 'not really a png')
    const message = buildUserMessage('what is this?', [{ filename: 'shot.png', mime: 'image/png', url }])
    const parts = (message as Array<{ content: Array<{ type: string; image?: string }> }>)[0]!.content
    expect(parts[0]).toEqual({ type: 'image', image: url })
  })

  it('passes anything else through as a file part with its type', () => {
    const message = buildUserMessage('summarise', [
      { filename: 'report.pdf', mime: 'application/pdf', url: dataUrl('application/pdf', '%PDF-1.7') },
    ])
    const parts = (message as Array<{ content: Array<{ type: string; mediaType?: string }> }>)[0]!.content
    expect(parts[0]!.type).toBe('file')
    expect(parts[0]!.mediaType).toBe('application/pdf')
  })

  it('refuses more than it can carry rather than truncating a document', () => {
    /**
     *
     * Half a document answers the wrong question, and confidently.
     *
     **/
    const huge = 'x'.repeat(textBudgetFor(undefined) + 1)
    expect(() =>
      buildUserMessage('read this', [{ filename: 'huge.txt', mime: 'text/plain', url: dataUrl('text/plain', huge) }]),
    ).toThrow(AttachmentTooLargeError)
  })

  it('lets a big model take a bigger document, because that is what actually limits it', () => {
    /**
     *
     * The point of the whole change: one fixed number said no to a file a
     * 200k-window model reads without noticing. Text is limited by the window
     * it has to fit into, so a bigger window means a bigger file — and the same
     * file is still refused on a small one.
     *
     **/
    /**
     *
     * 300KB is roughly 75k tokens: comfortable inside half of a 200k window,
     * hopeless against an 8k one. The numbers are the point — this is
     * arithmetic against a real window, not a constant somebody picked.
     *
     **/
    const document = 'x'.repeat(300 * 1024)
    const file = { filename: 'log.txt', mime: 'text/plain', url: dataUrl('text/plain', document) }

    expect(() => buildUserMessage('read this', [file], { contextLimit: 200_000 })).not.toThrow()
    expect(() => buildUserMessage('read this', [file], { contextLimit: 8_000 })).toThrow(AttachmentTooLargeError)
  })

  it('judges an image against the provider, not against the context window', () => {
    /**
     *
     * A picture is not read into the prompt — the provider bounds it. A model
     * with a huge window still cannot be handed an image past that bound, and
     * an ordinary screenshot must not be refused by a text rule.
     *
     **/
    const ordinary = { filename: 'shot.png', mime: 'image/png', url: dataUrl('image/png', 'x'.repeat(3 * 1024 * 1024)) }
    const enormous = {
      filename: 'huge.png',
      mime: 'image/png',
      url: dataUrl('image/png', 'x'.repeat(MAX_IMAGE_BYTES + 1)),
    }

    expect(() => buildUserMessage('look', [ordinary], { contextLimit: 8_000 })).not.toThrow()
    expect(() => buildUserMessage('look', [enormous], { contextLimit: 200_000 })).toThrow(AttachmentTooLargeError)
  })

  it('ignores an attachment that is not a data URL', () => {
    /**
     *
     * A client sending something else gets its text turn, not a broken request.
     *
     **/
    expect(buildUserMessage('hi', [{ filename: 'x', mime: 'text/plain', url: 'https://example.com/x' }])).toBe('hi')
  })
})
