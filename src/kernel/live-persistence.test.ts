import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * ── The answer is on disk before the turn ends ───────────────────────────────
 *
 * The transcript used to be written once, at the end. Everything before that
 * lived in the process and went out as events — so a reload mid-turn read the
 * stored message, found it empty, and showed "Thinking" under an answer the
 * person had been watching arrive for a minute. A refresh lost it; a machine
 * restart lost it permanently, because there was nothing on disk to recover.
 *
 * These test the store's half of that: an in-flight message can be updated and
 * read back, repeatedly, and the last write wins. The throttling itself lives in
 * turns.ts and is not what makes or breaks the guarantee — persisting at all is.
 *
 **/

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hoshi-live-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function store() {
  return await import('./messages.js')
}

describe('an answer still being written', () => {
  it('is readable from the transcript while the turn is running', async () => {
    const { appendMessage, updateMessage, readMessages } = await store()
    await appendMessage('ses_live', {
      id: 'msg_1',
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      createdAt: new Date().toISOString(),
    })

    /**
     *
     * What the turn does every second as tokens arrive.
     *
     **/
    await updateMessage('ses_live', 'msg_1', { parts: [{ type: 'text', text: 'Half an ans' }] })

    const [message] = await readMessages('ses_live')
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'Half an ans' })
    /**
     *
     * Still in flight: no completion stamp yet, which is how a client tells a
     * partial answer from a finished one.
     *
     **/
    expect(message?.completedAt ?? null).toBeNull()
  })

  it('grows rather than being replaced, and settles on the final text', async () => {
    const { appendMessage, updateMessage, readMessages } = await store()
    await appendMessage('ses_live', {
      id: 'msg_1',
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      createdAt: new Date().toISOString(),
    })

    for (const text of ['One', 'One two', 'One two three']) {
      await updateMessage('ses_live', 'msg_1', { parts: [{ type: 'text', text }] })
    }
    await updateMessage('ses_live', 'msg_1', {
      parts: [{ type: 'text', text: 'One two three' }],
      completedAt: new Date().toISOString(),
    })

    const [message] = await readMessages('ses_live')
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'One two three' })
    expect(message?.completedAt).toBeTruthy()
  })

  it('keeps a finished tool call even if the turn never completes', async () => {
    /**
     *
     * The expensive half: minutes of a build, a command that changed the disk.
     * A machine that dies mid-turn must still be able to say what it did.
     *
     **/
    const { appendMessage, updateMessage, readMessages } = await store()
    await appendMessage('ses_live', {
      id: 'msg_1',
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      createdAt: new Date().toISOString(),
    })
    await updateMessage('ses_live', 'msg_1', {
      parts: [
        { type: 'tool', name: 'bash', callId: 'c1', state: { status: 'completed', output: 'built', ms: 92_000 } },
        { type: 'text', text: '' },
      ],
    })

    const [message] = await readMessages('ses_live')
    const tool = message?.parts.find((part) => part.type === 'tool')
    expect(tool).toMatchObject({ name: 'bash', state: { status: 'completed', ms: 92_000 } })
  })
})
