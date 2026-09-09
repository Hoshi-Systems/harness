import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 *
 * A production machine with no owner does not boot.
 *
 * `SESSION_SECRET` is shared fleet-wide, so a machine that verifies platform
 * JWTs but has no `MACHINE_OWNER_ID` accepts ANY signed-in user's token as its
 * owner — every route on it, for every account on the platform. The lock read
 * `if (OWNER_ID !== null && …)`, which is right for dev and a silent
 * cross-tenant opening in production (security/SECURITY_AUDIT.md M2).
 *
 * The guard reads its environment at MODULE LOAD, the way the lock itself does,
 * so each case re-imports rather than stubbing after the fact — a test that
 * mutated `process.env` and called the same instance would be testing a
 * constant that had already been read.
 *
 **/

const ENV_KEYS = ['NODE_ENV', 'MACHINE_OWNER_ID', 'MACHINE_STATIC_TOKEN', 'SESSION_SECRET'] as const
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  vi.resetModules()
})

/**
 *
 * Load a fresh copy of the guard under the given environment.
 *
 * `SESSION_SECRET` is supplied unless a case overrides it, and that is the
 * finding's premise rather than test scaffolding: M2 is about a machine that
 * HAS the fleet-wide secret and no owner id. (It is also load-bearing
 * mechanically — `client-session.ts` resolves the secret at module scope, so a
 * production import without one throws before the guard is reached.)
 *
 **/
async function guardUnder(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  /** Named so it announces itself: `check:secrets` recognises a self-describing
   *  fake by its VALUE, which its own header calls a better signal than any list
   *  of exempt paths. A fixture that needs an allowlist entry is a fixture that
   *  looks like a credential. */
  const withSecret = { SESSION_SECRET: 'not-a-real-secret-only-production-shaped', ...env }
  for (const key of ENV_KEYS) {
    if (withSecret[key] === undefined) delete process.env[key]
    else process.env[key] = withSecret[key]
  }
  vi.resetModules()
  return (await import('./auth.js')).assertOwnerLockConfigured
}

describe('assertOwnerLockConfigured', () => {
  it('refuses to boot a production machine with no owner id', async () => {
    const assert = await guardUnder({ NODE_ENV: 'production' })
    expect(assert).toThrow(/MACHINE_OWNER_ID/)
  })

  it('refuses one whose owner id is not a usable user id', async () => {
    /** `Number('')` is 0 and `Number('nope')` is NaN — both would sail past a
     *  bare `!== null` and leave the lock comparing against nonsense. */
    for (const MACHINE_OWNER_ID of ['0', '-1', 'nope', '1.5']) {
      const assert = await guardUnder({ NODE_ENV: 'production', MACHINE_OWNER_ID })
      expect(assert, MACHINE_OWNER_ID).toThrow(/MACHINE_OWNER_ID/)
    }
  })

  it('boots a production machine that names its owner', async () => {
    const assert = await guardUnder({ NODE_ENV: 'production', MACHINE_OWNER_ID: '42' })
    expect(assert).not.toThrow()
  })

  it('boots a static-token machine without one', async () => {
    /** The other authentication model entirely: a connected BYO machine never
     *  receives the platform secret, so there is no fleet-wide credential for a
     *  missing owner id to leave unguarded — its bearer IS the proof. */
    const assert = await guardUnder({ NODE_ENV: 'production', MACHINE_STATIC_TOKEN: 'shared-token' })
    expect(assert).not.toThrow()
  })

  it('leaves development alone', async () => {
    /** `pnpm dev:machine` sets no owner id and must keep working. */
    const assert = await guardUnder({ NODE_ENV: 'development' })
    expect(assert).not.toThrow()
  })
})
