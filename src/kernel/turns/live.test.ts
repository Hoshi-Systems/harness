import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { LiveTurn } from './types.js'

/**
 * ── The registry, and the question that used to be a cycle ───────────────────
 *
 * `history.addContext` defers when a turn is running: something the model should
 * know arrives mid-generation — a button pressed on a generative-UI card — and
 * appending it to the model's memory underneath a turn that is already reading
 * that memory is how a message goes missing or lands twice.
 *
 * That question, `isTurnRunning`, lived in `turns.ts`, and `turns.ts` reads
 * history to build the next turn. It was the single reverse edge behind four
 * recorded cycles. The behaviour it guards had no test at all, which is how a
 * "genuine mutual recursion" that was one Map in the wrong file stayed
 * unexamined — so this covers the property, not the placement.
 *
 * `HOME` is captured at module scope by the store, so history is imported after
 * it is pointed at a scratch directory.
 *
 **/
let live: typeof import('./live.js')
let history: typeof import('../history.js')
let home: string

function fakeTurn(): LiveTurn {
  return { subscribers: new Set(), text: '', done: false, controller: new AbortController() } as unknown as LiveTurn
}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'hoshi-live-'))
  process.env.HOME = home
  live = await import('./live.js')
  history = await import('../history.js')
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

beforeEach(() => {
  live.unregisterTurn('s1')
  live.unregisterTurn('s2')
})

describe('the live-turn registry', () => {
  it('answers no for a session that is not generating', () => {
    expect(live.isTurnRunning('s1')).toBe(false)
    expect(live.anyTurnRunning()).toBe(false)
  })

  it('answers yes once a turn is registered, and no after it ends', () => {
    live.registerTurn('s1', fakeTurn())

    expect(live.isTurnRunning('s1')).toBe(true)
    expect(live.anyTurnRunning()).toBe(true)

    live.unregisterTurn('s1')
    expect(live.isTurnRunning('s1')).toBe(false)
    expect(live.anyTurnRunning()).toBe(false)
  })

  it('is per session — one generating does not make another busy', () => {
    live.registerTurn('s1', fakeTurn())

    expect(live.isTurnRunning('s2')).toBe(false)
    expect(live.anyTurnRunning()).toBe(true)
  })

  it('hands back the turn itself, which is what attach and abort need', () => {
    const turn = fakeTurn()
    live.registerTurn('s1', turn)

    expect(live.liveTurn('s1')).toBe(turn)
    expect(live.liveTurn('s2')).toBeUndefined()
  })
})

describe('addContext against the registry', () => {
  it('writes straight through when nothing is generating', async () => {
    await expect(history.addContext('s1', 'the user picked option B')).resolves.toEqual({ deferred: false })
  })

  it('defers while a turn is running, rather than writing under it', async () => {
    live.registerTurn('s1', fakeTurn())

    await expect(history.addContext('s1', 'the user picked option B')).resolves.toEqual({ deferred: true })
  })

  it('defers per session, not machine-wide', async () => {
    live.registerTurn('s1', fakeTurn())

    await expect(history.addContext('s2', 'unrelated session')).resolves.toEqual({ deferred: false })
  })
})
