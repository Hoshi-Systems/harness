import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ModelMessage } from 'ai'

/**
 * ── Reading a conversation without its pictures ──────────────────────────────
 *
 * A text-only model cannot be handed an image: the provider rejects the whole
 * request, so one picture anywhere in the history ends the session. The
 * imageless view exists to keep that session usable.
 *
 * What it must NOT do is make the damage permanent. The library loads the
 * conversation, appends to it and saves the lot — so a stripped load plus any
 * save writes the placeholders into the stored history for good, and the next
 * model, however capable, is blind for the rest of the session. That is exactly
 * what happened: a vision model insisting it cannot look at pictures.
 *
 **/

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hoshi-history-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const PICTURE: ModelMessage = {
  role: 'user',
  content: [
    { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' },
    { type: 'text', text: 'what is this?' },
  ],
}

async function stores() {
  const { historyStore, imagelessHistory } = await import('./history.js')
  return { historyStore, imagelessHistory }
}

describe('the imageless view of a conversation', () => {
  it('hides the picture from a model that cannot read it', async () => {
    const { historyStore, imagelessHistory } = await stores()
    await historyStore.save('ses_a', [PICTURE])

    const seen = await imagelessHistory.load('ses_a')
    const parts = Array.isArray(seen?.[0]?.content) ? seen[0].content : []
    expect(parts.some((part) => part.type === 'image')).toBe(false)
    expect(parts.some((part) => part.type === 'text')).toBe(true)
  })

  it('leaves the stored picture in place when the turn saves back', async () => {
    const { historyStore, imagelessHistory } = await stores()
    await historyStore.save('ses_b', [PICTURE])

    /**
     *
     * What a turn does: load through the view, append its own messages, save.
     *
     **/
    const seen = (await imagelessHistory.load('ses_b')) ?? []
    await imagelessHistory.save('ses_b', [...seen, { role: 'assistant', content: 'I cannot see it.' }])

    const stored = (await historyStore.load('ses_b')) ?? []
    const parts = Array.isArray(stored[0]?.content) ? stored[0].content : []
    expect(parts.some((part) => part.type === 'image')).toBe(true)
    /**
     *
     * The turn's own new message is not a picture and must survive as written.
     *
     **/
    expect(stored).toHaveLength(2)
    expect(stored[1]?.content).toBe('I cannot see it.')
  })

  it('so a model that CAN see still gets the picture afterwards', async () => {
    const { historyStore, imagelessHistory } = await stores()
    await historyStore.save('ses_c', [PICTURE])
    const seen = (await imagelessHistory.load('ses_c')) ?? []
    await imagelessHistory.save('ses_c', [...seen, { role: 'assistant', content: 'blind' }])

    const forVisionModel = (await historyStore.load('ses_c')) ?? []
    const parts = Array.isArray(forVisionModel[0]?.content) ? forVisionModel[0].content : []
    expect(parts.some((part) => part.type === 'image')).toBe(true)
  })
})
