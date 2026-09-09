import { describe, expect, it, beforeEach } from 'vitest'
import { bootNarration, narrateBoot, resetBootNarration } from './boot-narration.js'

/**
 * ── The machine's half of the boot story ─────────────────────────────────────
 *
 * The Platform's boot log ends at "the container is answering", which is where
 * the user's wait often begins. This is what the machine itself says while it
 * comes up, replayed to whoever connects mid-boot.
 *
 * It produced nothing at all for a while: the narration lived in a Nitro boot
 * plugin, the plugin went with the app, and `narrateBoot` came into the package
 * uncalled — so `machine.boot.snapshot` answered every client with an empty
 * list and no error was raised anywhere (docs/STRUCTURE_REVIEW.md H-10).
 *
 **/

beforeEach(() => {
  resetBootNarration()
})

describe('boot narration', () => {
  it('starts empty, which is also what a machine that has said nothing looks like', () => {
    expect(bootNarration()).toEqual([])
  })

  it('keeps what it was told, in order', () => {
    narrateBoot('info', 'Starting up')
    narrateBoot('success', 'Listening on 127.0.0.1:4200')
    expect(bootNarration().map((line) => line.message)).toEqual(['Starting up', 'Listening on 127.0.0.1:4200'])
    expect(bootNarration().map((line) => line.level)).toEqual(['info', 'success'])
  })

  it('counts a repeated line instead of appending it', () => {
    /**
     *
     * A 2s retry tick should read as "×14", not as fourteen lines of noise —
     * the same dedupe rule the Platform's own log keeps, so the two render as
     * one continuous feed.
     *
     **/
    narrateBoot('info', 'Waiting for the Platform')
    narrateBoot('info', 'Waiting for the Platform')
    narrateBoot('info', 'Waiting for the Platform')
    expect(bootNarration()).toHaveLength(1)
    expect(bootNarration()[0]?.count).toBe(3)
  })

  it('treats the same words at a different level as a different line', () => {
    narrateBoot('info', 'Fetching the model catalogue')
    narrateBoot('error', 'Fetching the model catalogue')
    expect(bootNarration()).toHaveLength(2)
  })

  it('is bounded, keeping the most recent lines', () => {
    for (let i = 0; i < 100; i++) narrateBoot('info', `line ${i}`)
    const lines = bootNarration()
    expect(lines.length).toBeLessThanOrEqual(60)
    expect(lines.at(-1)?.message).toBe('line 99')
  })

  it('forgets the previous boot when a new one starts', () => {
    narrateBoot('info', 'the last boot')
    resetBootNarration()
    expect(bootNarration()).toEqual([])
  })
})
