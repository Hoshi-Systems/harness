import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 *
 * The agent's mirror, on its own.
 *
 * Everything here is about the shape of what reaches the shell, because that is
 * the part with no other check: the census proves a terminal survives its
 * client, but nothing proves that a half-typed line is not submitted for the
 * person who typed it, or that a directory's first command opens the shell
 * instead of vanishing. Both are one-line mistakes with no visible symptom until
 * somebody loses what they were writing.
 *
 **/

const registry = vi.hoisted(() => ({
  agentTerminalFor: vi.fn(),
  echoTerminal: vi.fn(),
  openTerminal: vi.fn(),
  terminalIsBeingTyped: vi.fn(),
  terminalsAvailable: vi.fn(),
  writeTerminal: vi.fn(),
}))

vi.mock('./terminals.js', () => registry)

const { mirrorAgentCall } = await import('./agent-shell.js')

const DIR = '/workspace/project'

beforeEach(() => {
  for (const fn of Object.values(registry)) fn.mockReset()
  registry.terminalsAvailable.mockReturnValue(true)
  registry.openTerminal.mockResolvedValue({ id: 'new', shell: '/bin/zsh', directory: DIR, createdAt: '' })
  registry.terminalIsBeingTyped.mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the agent shell mirror', () => {
  it('opens the directory a shell on its first call, and echoes nothing yet', async () => {
    registry.agentTerminalFor.mockReturnValue(undefined)

    expect(mirrorAgentCall(DIR, 'ls')).toBeNull()
    expect(registry.openTerminal).toHaveBeenCalledWith({ directory: DIR, agent: true })
    expect(registry.echoTerminal).not.toHaveBeenCalled()
  })

  it('does not open a second shell while the first is still opening', () => {
    registry.agentTerminalFor.mockReturnValue(undefined)

    mirrorAgentCall(DIR, 'ls')
    mirrorAgentCall(DIR, 'pwd')

    expect(registry.openTerminal).toHaveBeenCalledTimes(1)
  })

  it('offers nothing at all on a machine that cannot host a shell', () => {
    registry.agentTerminalFor.mockReturnValue(undefined)
    registry.terminalsAvailable.mockReturnValue(false)

    expect(mirrorAgentCall(DIR, 'ls')).toBeNull()
    expect(registry.openTerminal).not.toHaveBeenCalled()
  })

  it('echoes the command before it runs, and its output after', () => {
    registry.agentTerminalFor.mockReturnValue({ id: 'shell-1', directory: DIR, shell: '/bin/zsh', agent: true })

    const call = mirrorAgentCall(DIR, 'echo hi')
    expect(registry.echoTerminal.mock.calls[0]?.[1]).toContain('$ echo hi')

    call?.done({ stdout: 'hi\n', stderr: '', exitCode: 0 })
    const written = registry.echoTerminal.mock.calls.map((c) => c[1]).join('')
    expect(written).toContain('hi')
    /** Every line ends CRLF: a bare \n in a PTY moves down without returning. */
    expect(written).not.toMatch(/[^\r]\n/)
  })

  it('says so when the call failed, rather than showing nothing', () => {
    registry.agentTerminalFor.mockReturnValue({ id: 'shell-1', directory: DIR, shell: '/bin/zsh', agent: true })

    mirrorAgentCall(DIR, 'boom')?.done(null)

    expect(registry.echoTerminal.mock.calls.map((c) => c[1]).join('')).toContain('the call failed')
  })

  it('shows a non-zero exit', () => {
    registry.agentTerminalFor.mockReturnValue({ id: 'shell-1', directory: DIR, shell: '/bin/zsh', agent: true })

    mirrorAgentCall(DIR, 'false')?.done({ stdout: '', stderr: '', exitCode: 3 })

    expect(registry.echoTerminal.mock.calls.map((c) => c[1]).join('')).toContain('exit 3')
  })

  it('nudges the prompt down once the output has landed', () => {
    registry.agentTerminalFor.mockReturnValue({ id: 'shell-1', directory: DIR, shell: '/bin/zsh', agent: true })

    mirrorAgentCall(DIR, 'echo hi')?.done({ stdout: 'hi\n', stderr: '', exitCode: 0 })

    expect(registry.writeTerminal).toHaveBeenCalledWith('shell-1', '\r')
  })

  it('never submits a line somebody is half-way through typing', () => {
    registry.agentTerminalFor.mockReturnValue({ id: 'shell-1', directory: DIR, shell: '/bin/zsh', agent: true })
    registry.terminalIsBeingTyped.mockReturnValue(true)

    mirrorAgentCall(DIR, 'echo hi')?.done({ stdout: 'hi\n', stderr: '', exitCode: 0 })

    expect(registry.writeTerminal).not.toHaveBeenCalled()
    /** The output still shows — only the nudge is held back. */
    expect(registry.echoTerminal).toHaveBeenCalled()
  })
})
