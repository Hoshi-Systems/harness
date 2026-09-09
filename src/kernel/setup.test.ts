import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ── The first-run flag ───────────────────────────────────────────────────────
 *
 * The store writes under `$HOME/.hoshi`, so HOME is pointed at a scratch path
 * before the module loads — the suite never touches a real machine's state.
 *
 **/
let api: typeof import('./setup.js')
let home: string

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'hoshi-setup-test-'))
  process.env.HOME = home
  api = await import('./setup.js')
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('the first-run flag', () => {
  it('is off on a machine that has never been set up', async () => {
    expect(await api.readSetupCompleted()).toBe(false)
  })

  it('turns on when setup completes, and stays on', async () => {
    await api.markSetupComplete()
    expect(await api.readSetupCompleted()).toBe(true)

    /**
     *
     * A second completion is a no-op, not a rewrite: the timestamp records when
     * the machine was set up, and that happened once.
     *
     **/
    const first = JSON.parse(await readFile(path.join(home, '.hoshi', 'setup.json'), 'utf8')) as { completedAt: string }
    await api.markSetupComplete()
    const second = JSON.parse(await readFile(path.join(home, '.hoshi', 'setup.json'), 'utf8')) as {
      completedAt: string
    }
    expect(second.completedAt).toBe(first.completedAt)
  })
})
