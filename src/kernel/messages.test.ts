import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { appendMessage, readMessages, settleInterruptedMessages } from './messages.js'

/**
 *
 * A turn lives in the process's memory and nowhere else. So a message still
 * showing `completedAt: null` after a boot is not in flight — it is what a turn
 * that died with the previous process left behind, and nothing will ever
 * finish it.
 *
 * The failure that made this worth fixing was silent in every log: a workflow
 * run adopting such a turn held the machine's one run slot and starved every
 * queued run behind it. The symptom was a machine that had simply stopped
 * running workflows.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-messages-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

let session = 0
function nextSession(): string {
  return `ses_${++session}`
}

beforeEach(() => {
  session += 100
})

describe('settling what a restart interrupted', () => {
  it('ends an assistant turn that never finished, and says why', async () => {
    const id = nextSession()
    await appendMessage(id, { id: 'm1', role: 'user', parts: [], createdAt: new Date().toISOString() })
    await appendMessage(id, { id: 'm2', role: 'assistant', parts: [], createdAt: new Date().toISOString() })

    expect(await settleInterruptedMessages()).toBeGreaterThanOrEqual(1)

    const answer = (await readMessages(id)).find((message) => message.id === 'm2')!
    expect(answer.completedAt).toBeTruthy()
    /**
     *
     * An error, not a quiet completion: the reply really was cut off
     * mid-sentence, and saying so is what lets a person or a retry act.
     *
     **/
    expect(answer.error?.name).toBe('MachineRestartedError')
  })

  it('leaves a finished turn exactly as it was', async () => {
    const id = nextSession()
    const completedAt = '2026-01-01T00:00:00.000Z'
    await appendMessage(id, {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'done' }],
      createdAt: completedAt,
      completedAt,
    })

    await settleInterruptedMessages()

    const answer = (await readMessages(id))[0]!
    expect(answer.completedAt).toBe(completedAt)
    expect(answer.error).toBeUndefined()
  })

  it('never touches a user message, which has no turn to interrupt', async () => {
    const id = nextSession()
    await appendMessage(id, { id: 'm1', role: 'user', parts: [], createdAt: new Date().toISOString() })

    await settleInterruptedMessages()

    expect((await readMessages(id))[0]!.completedAt).toBeUndefined()
  })

  it('is safe to run twice — a settled turn is not settled again', async () => {
    const id = nextSession()
    await appendMessage(id, { id: 'm1', role: 'assistant', parts: [], createdAt: new Date().toISOString() })

    await settleInterruptedMessages()
    const first = (await readMessages(id))[0]!.completedAt
    expect(await settleInterruptedMessages()).toBe(0)
    expect((await readMessages(id))[0]!.completedAt).toBe(first)
  })
})
