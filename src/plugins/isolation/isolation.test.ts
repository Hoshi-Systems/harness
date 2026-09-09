import { describe, expect, it } from 'vitest'
import { parseReading } from './isolation.js'

/**
 *
 * The probe itself is Linux-only — it calls `prctl` and reads `/proc/cpuinfo` —
 * so it cannot run on any host this repo's suites run on, and its own logic is
 * pinned by its own `--self-test` (which runs in `pnpm --filter @hoshi/infra
 * test`). What is testable HERE is the seam: what this machine does with what
 * the probe said, including when it said nothing useful.
 *
 * That split is deliberate. Without it the only way to learn that a malformed
 * reading reaches a client as a blank card would be to ship it to a host with
 * an old image.
 *
 **/

const READING = {
  kernel: '6.1.0-18-amd64',
  arch: 'x86_64',
  seccomp: 'filtered (mode 2)',
  lsms: 'capability,landlock,yama',
  landlock: { abi: 4, error: null, enforces: true, detail: 'ok' },
  userNamespace: { permitted: false, detail: 'refused' },
  microvm: {
    cpuVirt: 'Intel VT-x (vmx)',
    hardware: true,
    isGuest: true,
    nested: false,
    nestedDetail: 'off',
    kvmDevice: 'absent from this container',
    verdict: 'nested-off',
    reading: 'This host is itself a VM and its KVM has nested=off.',
  },
}

describe('reading what the probe said', () => {
  it('passes a well-formed reading through', () => {
    const result = parseReading(JSON.stringify(READING))
    expect(result.available).toBe(true)
    expect(result.available && result.reading.microvm.verdict).toBe('nested-off')
  })

  it('accepts every verdict the probe can emit', () => {
    /** Kept in step with `MICROVM_READING` in infra/machine/probe-isolation.py.
     *  A verdict added there and not here would be rejected as unrecognised on
     *  every machine — silently, since the route answers 200 either way. */
    for (const verdict of ['no-hardware', 'no-kvm-module', 'nested-off', 'ready']) {
      const result = parseReading(JSON.stringify({ ...READING, microvm: { ...READING.microvm, verdict } }))
      expect(result.available, verdict).toBe(true)
    }
  })

  it('refuses a verdict it does not recognise, rather than passing it on', () => {
    /** It would reach a client as an unrenderable tone and a missing sentence.
     *  "We do not understand this" is a better card than a blank one. */
    const result = parseReading(JSON.stringify({ ...READING, microvm: { ...READING.microvm, verdict: 'maybe' } }))
    expect(result.available).toBe(false)
  })

  it('treats output that is not JSON as unavailable, not as a crash', () => {
    /** An older image ships a probe with no --json flag; it prints its human
     *  report and exits 0. */
    const result = parseReading('── Hoshi machine isolation probe ───\nkernel 6.1.0\n')
    expect(result.available).toBe(false)
    expect(result.available === false && result.reason).toContain('readable output')
  })

  it('treats a reading with no microvm section as unavailable', () => {
    expect(parseReading(JSON.stringify({ kernel: '6.1.0' })).available).toBe(false)
  })

  it('does not throw on empty output', () => {
    expect(parseReading('').available).toBe(false)
  })
})
