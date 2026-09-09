import { afterEach, describe, expect, it } from 'vitest'
import { buildApprover, toolNames } from './tools.js'
import { configureKernel } from './host-ports.js'

/**
 * ── The machine's own plumbing is not a permission question ──────────────────
 *
 * Gating these produced the worst failure this codebase has: a permission
 * nobody can answer does not degrade the turn, it hangs the turn — forever.
 *
 * So the assertion is not "these are allowed" but "these are never asked about,
 * and never offered as something to configure".
 *
 **/

const SYSTEM = ['user_whoami', 'task_route', 'skill', 'task']

afterEach(() => configureKernel({}))

describe('system tools', () => {
  it('are approved without consulting anything', async () => {
    const approve = buildApprover('ses_1', '/workspace')
    for (const name of SYSTEM) {
      await expect(approve({ toolName: name, toolCallId: 'call_1', input: {} })).resolves.toBe(true)
    }
  })

  it('cannot be re-gated by an agent definition', async () => {
    /**
     *
     * An agent may tighten the machine's levels — but not into a deadlock. A
     * definition that set a system tool to deny would leave an agent unable to
     * perform the machine plumbing it needs.
     *
     **/
    const approve = buildApprover('ses_1', '/workspace', {
      name: 'strict',
      description: '',
      prompt: '',
      model: null,
      tools: {},
      permission: { task: 'deny' },
      readOnly: false,
      builtIn: false,
      customised: true,
    })
    await expect(approve({ toolName: 'task', toolCallId: 'call_1', input: {} })).resolves.toBe(true)
  })

  it('honours a product plugin declaring its conversation-only tools', async () => {
    configureKernel({ systemToolNames: () => ['conversation_card'] })
    const approve = buildApprover('ses_1', '/workspace')

    await expect(approve({ toolName: 'conversation_card', toolCallId: 'call_1', input: {} })).resolves.toBe(true)
    expect(toolNames()).not.toContain('conversation_card')
  })

  it('are absent from the list Customize governs', () => {
    /**
     *
     * Not hidden as a trick: the screen asks "allow, ask or deny", and for these
     * there is no answer that means anything.
     *
     **/
    const governed = toolNames()
    for (const name of SYSTEM) expect(governed).not.toContain(name)
  })

  it('leaves everything that touches the world governable', () => {
    /**
     *
     * The guarantee this must not quietly weaken. Delegation is ungated, but
     * what a specialist DOES is gated exactly as it would be in the parent.
     *
     **/
    const governed = toolNames()
    for (const name of ['bash', 'write', 'edit']) expect(governed).toContain(name)
  })
})
