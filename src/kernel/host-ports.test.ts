import { describe, expect, it, beforeEach } from 'vitest'
import { configureKernel, extendKernel, ports } from './host-ports.js'

/**
 *
 * A machine with no organization behind it is the DEFAULT case, not an edge
 * one: every self-hosted harness is that machine. So the safe answers have to
 * be what you get when nobody installs anything — and "safe" here means the
 * caller finds out there is nobody to ask, rather than reading silence as yes.
 *
 **/

beforeEach(() => {
  configureKernel({})
})

describe('a harness with no host', () => {
  it('has nobody to notify, and says nothing rather than failing', () => {
    expect(ports().notify).toBeUndefined()
  })

  it('forbids nothing — an unanswered policy is not a denial', () => {
    /**
     *
     * The other reading would brick a lone machine: with no org to publish
     * rules, every tool call would be refused by a policy that does not exist.
     *
     **/
    expect(ports().mayProceed).toBeUndefined()
  })

  it('blocks no spend, because it has no budget to have exceeded', () => {
    expect(ports().spendBlocked).toBeUndefined()
  })

  it('has no dispatcher, and that is discoverable rather than silent', () => {
    /**
     *
     * The one port whose absence must NOT be shrugged off: work that was
     * supposed to run unattended and simply never started is the failure
     * nobody notices. The plugin host turns this into a thrown error.
     *
     **/
    expect(ports().dispatch).toBeUndefined()
  })
})

describe('installing the host', () => {
  it('takes the answers a machine with an organization gives', async () => {
    configureKernel({
      spendBlocked: () => true,
      mayProceed: async () => ({ effect: 'deny', ruleId: 'no-force-push' }),
    })
    expect(ports().spendBlocked?.()).toBe(true)
    expect(await ports().mayProceed?.({ tool: 'bash', subjects: ['git push --force'] })).toEqual({
      effect: 'deny',
      ruleId: 'no-force-push',
    })
  })
})

describe('extending', () => {
  it('adds to what is installed instead of erasing it', () => {
    /**
     *
     * Two things legitimately answer the same ports — the machine hosting the
     * kernel, and the plugins inside it. `configureKernel` alone would let the
     * second silently wipe the first, and the symptom would be a machine that
     * quietly stopped enforcing its organization's rules.
     *
     **/
    configureKernel({ spendBlocked: () => true })
    extendKernel((current) => ({ ...current, extraToolNames: () => ['browser_open'] }))

    expect(ports().spendBlocked?.()).toBe(true)
    expect(ports().extraToolNames?.()).toEqual(['browser_open'])
  })

  it('hands the extender what is already there, so it can compose', () => {
    configureKernel({ extraToolNames: () => ['widget_form'] })
    extendKernel((current) => ({
      ...current,
      extraToolNames: () => [...(current.extraToolNames?.() ?? []), 'browser_open'],
    }))
    expect(ports().extraToolNames?.()).toEqual(['widget_form', 'browser_open'])
  })
})
