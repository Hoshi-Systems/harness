import { afterEach, describe, expect, it } from 'vitest'
import { echoTerminal, killAllTerminals, listTerminals, openTerminal, terminalsAvailable } from './terminals.js'

/**
 *
 * The registry, against a real PTY.
 *
 * Real rather than mocked on purpose: every property worth having here — that a
 * shell outlives its listeners, that the scrollback is what a reconnecting
 * client is handed, that echoed text never reaches the process — is a property
 * of an actual pseudo-terminal, and a fake one would only prove the fake.
 *
 * `node-pty` is native, so a machine that could not build it must still boot.
 * These skip rather than fail there, the same degrade the routes report.
 *
 **/

const shellAvailable = await openTerminal({ directory: process.cwd() })
  .then((terminal) => {
    void terminal
    return true
  })
  .catch(() => false)

afterEach(() => {
  killAllTerminals()
})

describe.skipIf(!shellAvailable)('the machine’s shells', () => {
  it('lists a shell it opened, with where and what it is running', async () => {
    const opened = await openTerminal({ directory: process.cwd() })

    const listed = listTerminals()
    expect(listed.map((terminal) => terminal.id)).toContain(opened.id)
    expect(opened.directory).toBe(process.cwd())
    expect(opened.shell).toBeTruthy()
    expect(terminalsAvailable()).toBe(true)
  })

  it('marks the agent’s shell as the agent’s, and nothing else', async () => {
    const mine = await openTerminal({ directory: process.cwd() })
    const agent = await openTerminal({ directory: process.cwd(), agent: true })

    const byId = new Map(listTerminals().map((terminal) => [terminal.id, terminal]))
    expect(byId.get(mine.id)?.agent).toBeUndefined()
    expect(byId.get(agent.id)?.agent).toBe(true)
  })

  it('keeps what the shell said for a client that was not there yet', async () => {
    const { id } = await openTerminal({ directory: process.cwd() })
    const { writeTerminal, attachTerminal } = await import('./terminals.js')

    writeTerminal(id, 'echo hoshi-replay-marker\r')
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const attached = attachTerminal(id, () => {})
    expect(attached?.replay).toContain('hoshi-replay-marker')
    attached?.detach()
  })

  it('echoes into the transcript WITHOUT running it', async () => {
    const { id } = await openTerminal({ directory: process.cwd() })
    const { attachTerminal } = await import('./terminals.js')
    await new Promise((resolve) => setTimeout(resolve, 600))

    /**
     *
     * The whole reason `echoTerminal` exists. Sent to the process instead, this
     * would create the file — which is what the agent's mirror would do to every
     * command it showed.
     *
     **/
    echoTerminal(id, 'touch hoshi-must-not-exist\r\n')
    await new Promise((resolve) => setTimeout(resolve, 600))

    const attached = attachTerminal(id, () => {})
    expect(attached?.replay).toContain('hoshi-must-not-exist')
    attached?.detach()

    const { existsSync } = await import('node:fs')
    expect(existsSync('hoshi-must-not-exist')).toBe(false)
  })

  it('keeps running after every listener has gone', async () => {
    const { id } = await openTerminal({ directory: process.cwd() })
    const { attachTerminal } = await import('./terminals.js')

    const attached = attachTerminal(id, () => {})
    attached?.detach()

    expect(listTerminals().map((terminal) => terminal.id)).toContain(id)
  })

  it('tells whoever is attached when the shell ends', async () => {
    const { id } = await openTerminal({ directory: process.cwd() })
    const { attachTerminal, killTerminal } = await import('./terminals.js')
    await new Promise((resolve) => setTimeout(resolve, 400))

    let ended: number | null = null
    const attached = attachTerminal(
      id,
      () => {},
      (code) => {
        ended = code
      },
    )
    killTerminal(id)
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(listTerminals().map((terminal) => terminal.id)).not.toContain(id)
    attached?.detach()
    expect(ended).not.toBeNull()
  })
})
