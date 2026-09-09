import { describe, expect, it } from 'vitest'
import { buildApprover, toolNames } from './tools.js'

/**
 * ── The machine's own plumbing is not a permission question ──────────────────
 *
 * Gating these produced the worst failure this codebase has: a permission
 * nobody can answer does not degrade the turn, it hangs the turn — forever.
 * `ui_ask` made that circular, because it is the tool for asking the person
 * something: the machine blocked waiting for permission to ask, on a card that
 * only appears if the asking worked.
 *
 * So the assertion is not "these are allowed" but "these are never asked about,
 * and never offered as something to configure".
 *
 **/

const SYSTEM = ['ui_render', 'ui_ask', 'ui_html', 'user_whoami', 'task_route', 'skill', 'task']

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
     * definition that set `ui_ask: deny` would leave an agent told to ask the
     * user with no way to ask them.
     *
     **/
    const approve = buildApprover('ses_1', '/workspace', {
      name: 'strict',
      description: '',
      prompt: '',
      model: null,
      tools: {},
      permission: { ui_ask: 'deny', task: 'deny' },
      readOnly: false,
      builtIn: false,
      customised: true,
    })
    await expect(approve({ toolName: 'ui_ask', toolCallId: 'call_1', input: {} })).resolves.toBe(true)
    await expect(approve({ toolName: 'task', toolCallId: 'call_2', input: {} })).resolves.toBe(true)
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
