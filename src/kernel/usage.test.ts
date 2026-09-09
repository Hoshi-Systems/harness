import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 *
 * Two properties of the rollup push, tested on the machine side:
 *   • Days are bucketed by UTC — the same clock the Platform, the budgets and
 *     every other machine in the org use, so one turn can't land in two
 *     different "months" depending on who reads it.
 *   • A day's bucket is the WHOLE truth about that day. That is what makes the
 *     push idempotent (the Platform replaces rather than accumulates) and what
 *     makes boot catch-up free: a machine stopped for days recomputes them.
 *
 * kernel/store.ts resolves ~/.hoshi off HOME, and kernel/usage.ts captures
 * its file path at module scope — so each test gets a scratch HOME and a fresh
 * module, which keeps the store off the developer's own machine and keeps the
 * tests independent of each other.
 *
 **/

const roots: string[] = []
const originalHome = process.env.HOME

let usage: typeof import('./usage.js')

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hoshi-usage-'))
  roots.push(root)
  process.env.HOME = root
  vi.resetModules()
  usage = await import('./usage.js')
})

/**
 *
 * Persists are fire-and-forget, so a test's last write can still be in flight
 * when its scratch HOME is deleted; that logs after the run has ended, which
 * vitest counts as an unhandled error and CI reads as a failing suite (a real,
 * if rare, flake before this). Drained per TEST because `vi.resetModules()`
 * above gives every test its own module instance with its own write queue.
 *
 **/
afterEach(async () => {
  await usage.flushUsage()
})

afterAll(() => {
  process.env.HOME = originalHome
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

let seq = 0
async function turn(model: string | null, cost: number | null, messageId?: string, sessionId = 'ses_1') {
  await usage.recordUsageEvent({
    ocSessionId: sessionId,
    messageId: messageId ?? `msg_${++seq}`,
    model,
    inputTokens: 10,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost,
  })
}

describe('getDailyBuckets', () => {
  it('folds turns into one bucket per (UTC day, model), counting turns', async () => {
    await turn('opus', 1)
    await turn('opus', 2)
    await turn('haiku', 0.5)

    const buckets = await usage.getDailyBuckets()
    const today = new Date().toISOString().slice(0, 10)
    expect(buckets).toHaveLength(2)
    expect(buckets.every((bucket) => bucket.periodStart === today)).toBe(true)

    const opus = buckets.find((bucket) => bucket.model === 'opus')!
    expect(opus.cost).toBeCloseTo(3)
    expect(opus.turns).toBe(2)
    expect(opus.inputTokens).toBe(20)
  })

  it('reports a model-less turn under the same "unknown" name the summary uses', async () => {
    await turn(null, 1)
    expect((await usage.getDailyBuckets())[0]!.model).toBe('unknown')
  })

  it('reconciles exactly with the machine’s own Settings → Usage totals', async () => {
    await turn('opus', 1.25)
    await turn('haiku', 0.75)
    await turn(null, 0.5)

    const buckets = await usage.getDailyBuckets()
    const summary = await usage.getUsageSummary()
    expect(buckets.reduce((sum, bucket) => sum + bucket.cost, 0)).toBeCloseTo(summary.totals.cost)
    expect(buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0)).toBe(summary.totals.inputTokens)
    expect(buckets.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(3)
  })

  it('is stable — recomputing yields the identical aggregate, so a re-push is a no-op', async () => {
    await turn('opus', 1)
    expect(await usage.getDailyBuckets()).toEqual(await usage.getDailyBuckets())
  })

  it('dedupes a replayed turn, so a client retry never inflates a bucket', async () => {
    await turn('opus', 2, 'msg_replay')
    await turn('opus', 2, 'msg_replay')

    const buckets = await usage.getDailyBuckets()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.turns).toBe(1)
    expect(buckets[0]!.cost).toBeCloseTo(2)
  })

  it('is empty before anything has run', async () => {
    expect(await usage.getDailyBuckets()).toEqual([])
  })
})

describe('an unpriced turn', () => {
  it('is counted as unpriced, never as free', async () => {
    /**
     *
     * The whole point: a machine running a self-hosted model must not report
     * that it has spent nothing. Zero and unknown are different answers.
     *
     **/
    await turn('local/qwen', null)
    const totals = (await usage.getUsageSummary()).totals
    expect(totals.cost).toBe(0)
    expect(totals.unpricedTurns).toBe(1)
  })

  it('leaves a priced turn beside it exact, and marks the total a floor', async () => {
    await turn('opus', 1.5)
    await turn('local/qwen', null)
    const totals = (await usage.getUsageSummary()).totals
    expect(totals.cost).toBeCloseTo(1.5)
    expect(totals.unpricedTurns).toBe(1)
  })
})

describe('getSpendBySession', () => {
  it('keeps each conversation’s spend to itself', async () => {
    await turn('opus', 1, undefined, 'ses_a')
    await turn('opus', 2, undefined, 'ses_a')
    await turn('opus', 0.5, undefined, 'ses_b')

    const spend = await usage.getSpendBySession()
    expect(spend.ses_a!.cost).toBeCloseTo(3)
    expect(spend.ses_b!.cost).toBeCloseTo(0.5)
  })

  it('reports a session that only ran unpriced turns as a floor of zero', async () => {
    await turn(null, null, undefined, 'ses_c')
    expect(await usage.getSpendBySession()).toMatchObject({ ses_c: { cost: 0, unpricedTurns: 1 } })
  })
})
