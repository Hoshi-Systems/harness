import { describe, expect, it } from 'vitest'
import type { TrackedProcess } from './processes.js'
import { attributeProject, deriveStatus, isWithin } from './services.js'

/** The checkout layout a machine actually has: several org-namespaced
 *  directories under one workspace root, one of them a prefix of another. */
const CHECKOUTS = [
  { id: 'shop', directory: '/workspace/acme/shop' },
  { id: 'shop-admin', directory: '/workspace/acme/shop-admin' },
  { id: 'nested', directory: '/workspace/acme/shop/packages/ui' },
]

describe('a working directory is attributed to the right checkout', () => {
  /**
   *
   * The bug this exists to prevent: a raw `startsWith` on the directory string
   * files shop-admin's dev server under `shop`, because "/workspace/acme/shop"
   * IS a string prefix of "/workspace/acme/shop-admin". The panel would then
   * show a service under a project it doesn't belong to — and, worse, the
   * "who took port 3000" answer would name the wrong project.
   *
   **/
  it('does not mistake a sibling whose name starts the same', () => {
    expect(attributeProject('/workspace/acme/shop-admin', CHECKOUTS)).toBe('shop-admin')
  })

  it('attributes the checkout directory itself', () => {
    expect(attributeProject('/workspace/acme/shop', CHECKOUTS)).toBe('shop')
  })

  it('attributes a directory deep inside a checkout', () => {
    expect(attributeProject('/workspace/acme/shop/apps/web', CHECKOUTS)).toBe('shop')
  })

  /**
   *
   * A checkout inside another checkout must claim its own processes, or a
   * monorepo package's dev server is reported against the outer repo.
   *
   **/
  it('gives a nested checkout precedence over the one containing it', () => {
    expect(attributeProject('/workspace/acme/shop/packages/ui', CHECKOUTS)).toBe('nested')
    expect(attributeProject('/workspace/acme/shop/packages/ui/src', CHECKOUTS)).toBe('nested')
  })

  /**
   *
   * The personal space is the workspace root itself — no checkout sits above
   * it, and null is what the client renders as "Personal".
   *
   **/
  it('returns null for the workspace root and for anything outside a checkout', () => {
    expect(attributeProject('/workspace', CHECKOUTS)).toBeNull()
    expect(attributeProject('/workspace/other-org/thing', CHECKOUTS)).toBeNull()
    expect(attributeProject('/tmp', CHECKOUTS)).toBeNull()
  })

  it('normalises unclean paths rather than failing to match them', () => {
    expect(attributeProject('/workspace/acme/shop/', CHECKOUTS)).toBe('shop')
    expect(attributeProject('/workspace/acme/shop/apps/../apps/web', CHECKOUTS)).toBe('shop')
  })
})

describe('isWithin compares path segments, not characters', () => {
  it('accepts a directory and its descendants', () => {
    expect(isWithin('/workspace', '/workspace')).toBe(true)
    expect(isWithin('/workspace', '/workspace/acme/shop')).toBe(true)
  })

  it('rejects a sibling sharing a textual prefix', () => {
    expect(isWithin('/workspace/acme/shop', '/workspace/acme/shop-admin')).toBe(false)
  })

  it('rejects an escape above the parent', () => {
    expect(isWithin('/workspace/acme/shop', '/workspace/acme')).toBe(false)
    expect(isWithin('/workspace/acme/shop', '/workspace/acme/shop/../..')).toBe(false)
  })
})

function proc(status: TrackedProcess['status']): TrackedProcess {
  return {
    id: 'p1',
    name: 'web',
    command: 'pnpm dev',
    cwd: '/workspace/acme/shop',
    pid: 4242,
    status,
    exitCode: null,
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: null,
  }
}

describe('a service reads its status off its backing process', () => {
  /**
   *
   * No process means the declaration outlived the run — never started, or the
   * machine rebooted under it (US-9). The row must read `stopped`, never a
   * ghost `running` with nothing behind it.
   *
   **/
  it('is stopped when no process backs it', () => {
    expect(deriveStatus(undefined)).toBe('stopped')
  })

  it('is running while its process is alive', () => {
    expect(deriveStatus(proc('running'))).toBe('running')
  })

  it('is failed when its process failed', () => {
    expect(deriveStatus(proc('failed'))).toBe('failed')
  })

  /**
   *
   * "I stopped this" and "this fell over" have to stay distinguishable — the
   * first is expected, the second is the one worth showing logs for.
   *
   **/
  it('separates a deliberate stop from an unattended exit', () => {
    expect(deriveStatus(proc('stopped'))).toBe('stopped')
    expect(deriveStatus(proc('exited'))).toBe('exited')
  })
})
