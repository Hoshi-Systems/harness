import { describe, expect, it } from 'vitest'
import { compactionThreshold } from './compaction.js'

/**
 * ── When a conversation gets folded ──────────────────────────────────────────
 *
 * Two limits, because they answer different problems: a fraction of the window
 * (leave room for the answer) and a flat ceiling (a million-token history is a
 * bill and a wait, whatever the window allows). The lower one wins.
 *
 * These are the numbers a person can check against their own model, which is
 * the point of testing arithmetic at all.
 *
 **/

describe('the compaction threshold', () => {
  it('is nine-tenths of a small window', () => {
    expect(compactionThreshold(200_000)).toBe(180_000)
    expect(compactionThreshold(128_000)).toBe(115_200)
  })

  it('is the 450k ceiling once nine-tenths would exceed it', () => {
    /**
     *
     * A million-token window: 900k would fit, but re-sending 900k tokens every
     * turn is the cost problem the ceiling exists for.
     *
     **/
    expect(compactionThreshold(1_000_000)).toBe(450_000)
    expect(compactionThreshold(2_000_000)).toBe(450_000)
  })

  it('meets exactly at a 500k window, where the two rules agree', () => {
    expect(compactionThreshold(500_000)).toBe(450_000)
  })

  it('leaves room to answer in every case', () => {
    for (const window of [8_000, 32_000, 128_000, 200_000, 1_000_000]) {
      expect(compactionThreshold(window)).toBeLessThan(window)
    }
  })
})
