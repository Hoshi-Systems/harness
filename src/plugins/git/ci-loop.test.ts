import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CiForgeAccess, CiVerdictInput, CiWatch } from './ci-loop.js'
import type { Preferences } from '../../kernel/index.js'

/**
 * ── The closed loop's guards ─────────────────────────────────────────────────
 *
 * Every test here is a way of NOT starting a fix run, plus the two ways of
 * ending one. That bias is the point: the loop's whole risk is that it pushes a
 * commit onto a branch it shouldn't, and each guard below is a separate answer
 * to "why wouldn't it?".
 *
 * The four collaborators are mocked because none of them is what is being
 * tested — the queue would start a real OpenCode session, the alert reporter
 * would call the Platform, the preferences reader would fetch OpenCode's global
 * config over HTTP, and the forge access would shell out to `gh`. What is being
 * tested is the DECISION, and the decision is pure once those four answer.
 *
 * ~/.hoshi is redirected to a scratch HOME per test (kernel/store.ts
 * resolves it off HOME, and the store captures its path at module scope), so
 * the ledger never touches the developer's own machine and no test inherits
 * another's watches.
 *
 **/

const enqueued: Array<Record<string, unknown>> = []
const alerts: Array<Record<string, unknown>> = []

let preferences: Preferences
let blocked: boolean
let policyEffect: 'deny' | 'ask' | null

/**
 *
 * The loop's four collaborators are PORTS now, not modules, so the test
 * installs a host instead of mocking imports. That is the honest shape: this
 * is exactly how a machine with no organization behind it differs from one
 * with a policy and a budget, and the guards below are all about that
 * difference (kernel/ports.ts).
 * Imported INSIDE, after `vi.resetModules()`: a reset gives every module a
 * fresh instance, so a host installed through the test file's own copy of the
 * port registry would be written into a registry the code under test can no
 * longer see. The symptom is every guard refusing for want of a dispatcher.
 *
 **/
async function installHost(): Promise<void> {
  const { configureKernel, ports: kernelPorts } = await import('../../kernel/host-ports.js')
  /** What `startPlugins` does for a running plugin. A getter, not a snapshot:
   *  `configureKernel` below runs after this and the plugin must see it. */
  const { bind } = await import('./host.js')
  bind({
    get ports() {
      return kernelPorts()
    },
  })
  configureKernel({
    dispatch: async (task) => {
      enqueued.push(task as unknown as Record<string, unknown>)
      return { id: 'task_1' }
    },
    notify: (alert) => {
      alerts.push(alert as unknown as Record<string, unknown>)
    },
    spendBlocked: () => blocked,
    mayProceed: async () => ({ effect: policyEffect, ruleId: policyEffect ? 'rule_1' : null }),
  })
}

/**
 *
 * Preferences live in the kernel, so this one still replaces an export of the
 * package rather than a local module — everything else it provides has to stay
 * real, or this test would be standing up a machine with no kernel.
 *
 **/
vi.mock('../../kernel/preferences.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kernel/preferences.js')>()),
  getPreferences: vi.fn(async () => preferences),
}))

const roots: string[] = []
const originalHome = process.env.HOME

let ciLoop: typeof import('./ci-loop.js')

/** A forge that answers with whatever the test set, and records what it was
 *  asked for — the rerun path has no other observable effect. */
let logs: string[]
let rerunOk: boolean
const reruns: Array<string | null> = []

const forge: CiForgeAccess = {
  failingLog: async () => logs.shift() ?? null,
  rerun: async (_watch: CiWatch, runId: string | null) => {
    reruns.push(runId)
    return rerunOk
  },
}

const DIR = '/workspace/acme/api'
const REPO = 'acme/api'
const BRANCH = 'hoshi/fix-the-thing'
const AGENT_SHA = 'a'.repeat(40)
const HUMAN_SHA = 'b'.repeat(40)

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hoshi-ci-loop-'))
  roots.push(root)
  process.env.HOME = root
  enqueued.length = 0
  alerts.length = 0
  reruns.length = 0
  logs = []
  rerunOk = true
  preferences = { ciFix: true, ciMaxAttempts: 2 } as Preferences
  blocked = false
  policyEffect = null
  vi.resetModules()
  ciLoop = await import('./ci-loop.js')
  await installHost()
})

/**
 *
 * The ledger persists fire-and-forget (utils/json-store.ts), so a test's last
 * write can still be in flight when its scratch HOME is deleted — which logs
 * after the run has ended and vitest counts as an unhandled error. Drained per
 * TEST, not once at the end: `vi.resetModules()` above gives every test its own
 * module instance with its own write queue, so flushing only the last one would
 * leave every earlier queue unwaited.
 *
 **/
afterEach(async () => {
  await ciLoop.flushCiLedger()
})

afterAll(() => {
  process.env.HOME = originalHome
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Register the branch the way `openPullRequest` does. */
async function watchBranch(headSha: string | null = AGENT_SHA) {
  return ciLoop.registerCiWatch({
    forge: 'github',
    repo: REPO,
    branch: BRANCH,
    directory: DIR,
    prNumber: 42,
    prUrl: 'https://github.com/acme/api/pull/42',
    headSha,
  })
}

function verdict(overrides: Partial<CiVerdictInput> = {}): CiVerdictInput {
  return {
    forge: 'github',
    repo: REPO,
    branch: BRANCH,
    verdict: 'failed',
    checkName: 'test',
    runUrl: 'https://github.com/acme/api/actions/runs/1',
    runId: '1',
    headSha: AGENT_SHA,
    prNumber: 42,
    prUrl: 'https://github.com/acme/api/pull/42',
    ...overrides,
  }
}

const apply = (input: Partial<CiVerdictInput> = {}) => ciLoop.applyCiVerdict(verdict(input), forge)

describe('a pull request the machine did not open', () => {
  it('is never touched, however red it goes', async () => {
    expect(await apply()).toEqual({ acted: 'ignored-unknown-branch' })
    expect(enqueued).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it('stays untouched even when another branch in the same repo IS watched', async () => {
    await watchBranch()
    const outcome = await apply({ branch: 'someone-elses-branch' })
    expect(outcome).toEqual({ acted: 'ignored-unknown-branch' })
    expect(enqueued).toHaveLength(0)
  })
})

describe('the fix loop', () => {
  it('starts exactly one run on the first failure, carrying the failing log tail', async () => {
    await watchBranch()
    logs = ['Error: expected 3 to equal 4\n  at api.test.ts:12']

    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 1 })
    expect(enqueued).toHaveLength(1)
    const task = enqueued[0]!
    expect(task.source).toBe('ci')
    expect(task.directory).toBe(DIR)
    expect(String(task.prompt)).toContain('expected 3 to equal 4')
    expect(String(task.prompt)).toContain('attempt 1 of 2')
    /**
     *
     * The honesty rule cuts both ways: the run is told it may not land.
     *
     **/
    expect(String(task.prompt)).toContain('Do NOT merge')
    expect(alerts).toHaveLength(0)
  })

  it('says so plainly when the log could not be read, rather than pretending it has one', async () => {
    await watchBranch()
    logs = []

    await apply()
    expect(String(enqueued[0]!.prompt)).toContain('could not be read')
  })

  it('spends a second attempt on a DIFFERENT failure, then escalates on the third', async () => {
    await watchBranch()
    logs = ['first failure: assertion A', 'second failure: assertion B', 'third failure: assertion C']

    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 1 })
    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 2 })
    expect(await apply()).toEqual({ acted: 'escalated', reason: 'attemptsSpent' })

    expect(enqueued).toHaveLength(2)
    expect(alerts).toHaveLength(1)
    /**
     *
     * The reason travels in the text now, because the port speaks alerts, not
     * CI: whoever raises it has to be readable by whoever receives it.
     *
     **/
    expect(alerts[0]!.kind).toBe('error')
    expect(String(alerts[0]!.detail)).toContain('attemptsSpent')
  })

  it('bails early when the same failure repeats, rather than burning the second attempt', async () => {
    await watchBranch()
    /**
     *
     * The same failure, reported by two runs — different run ids, different
     * timestamps, identical assertion.
     *
     **/
    logs = [
      '2026-08-04T10:00:00Z FAIL api.test.ts:12 expected 3 to equal 4 (1.20s)',
      '2026-08-04T10:44:31Z FAIL api.test.ts:12 expected 3 to equal 4 (0.98s)',
    ]

    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 1 })
    expect(await apply({ runId: '2' })).toEqual({ acted: 'escalated', reason: 'noProgress' })
    expect(enqueued).toHaveLength(1)
  })

  it('never re-escalates once it has given up', async () => {
    await watchBranch()
    logs = ['a', 'b', 'c', 'd']
    await apply()
    await apply()
    await apply()
    expect(await apply()).toEqual({ acted: 'ignored-settled', reason: 'attemptsSpent' })
    expect(alerts).toHaveLength(1)
  })
})

describe('a human on the branch', () => {
  it('stops the loop immediately', async () => {
    await watchBranch()
    expect(await apply({ headSha: HUMAN_SHA })).toEqual({ acted: 'stopped-human-pushed', reason: 'humanPushed' })
    expect(enqueued).toHaveLength(0)
  })

  it('stops it permanently — a later failure on an agent commit does not resume it', async () => {
    await watchBranch()
    await apply({ headSha: HUMAN_SHA })
    expect(await apply({ headSha: AGENT_SHA })).toEqual({ acted: 'ignored-settled', reason: 'humanPushed' })
    expect(enqueued).toHaveLength(0)
  })

  it('survives re-opening the pull request — that is not consent to start editing again', async () => {
    await watchBranch()
    await apply({ headSha: HUMAN_SHA })
    await watchBranch()
    expect(await apply({ headSha: AGENT_SHA })).toEqual({ acted: 'ignored-settled', reason: 'humanPushed' })
  })

  it('treats a verdict with no head sha at all as unknown provenance', async () => {
    await watchBranch()
    expect(await apply({ headSha: null })).toEqual({ acted: 'stopped-human-pushed', reason: 'humanPushed' })
  })

  it('recognizes a commit the agent made through gitCommit as its own', async () => {
    await watchBranch(null)
    const second = 'c'.repeat(40)
    await ciLoop.recordAgentCommit(DIR, BRANCH, second)
    logs = ['boom']
    expect(await apply({ headSha: second })).toEqual({ acted: 'fix-dispatched', attempt: 1 })
  })
})

describe('going green', () => {
  it('notifies once, not once per attempt', async () => {
    await watchBranch()
    logs = ['a', 'b']
    await apply()
    await apply()

    expect(await apply({ verdict: 'passed' })).toEqual({ acted: 'green' })
    /**
     *
     * A second workflow reporting green on the same commit must not notify again.
     *
     **/
    await apply({ verdict: 'passed' })
    expect(alerts.filter((alert) => alert.kind === 'complete')).toHaveLength(1)
  })

  it('says nothing when CI was green all along', async () => {
    await watchBranch()
    expect(await apply({ verdict: 'passed' })).toEqual({ acted: 'green' })
    expect(alerts).toHaveLength(0)
  })
})

describe('a run that never reached a verdict', () => {
  it('is rerun once instead of being handed to an agent with no failing assertion', async () => {
    await watchBranch()
    expect(await apply({ verdict: 'retryable' })).toEqual({ acted: 'rerun-requested' })
    expect(reruns).toEqual(['1'])
    expect(enqueued).toHaveLength(0)
  })

  it('does not spend a code attempt doing it', async () => {
    await watchBranch()
    await apply({ verdict: 'retryable' })
    logs = ['a']
    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 1 })
  })

  it('escalates rather than rerunning forever', async () => {
    await watchBranch()
    await apply({ verdict: 'retryable' })
    expect(await apply({ verdict: 'retryable' })).toEqual({ acted: 'escalated', reason: 'rerunsSpent' })
  })
})

describe('the refusals', () => {
  it('refuses when the org policy denies unattended CI fixes, and names the rule', async () => {
    await watchBranch()
    policyEffect = 'deny'
    await installHost()

    expect(await apply()).toEqual({ acted: 'escalated', reason: 'policyDenied' })
    expect(enqueued).toHaveLength(0)
    /**
     *
     * The reason and the rule reach the owner in the alert's text: a refusal
     * nobody can attribute to a rule is indistinguishable from a bug.
     *
     **/
    expect(String(alerts[0]!.detail)).toContain('policyDenied')
    expect(String(alerts[0]!.detail)).toContain('rule_1')
  })

  it('refuses to START on an exceeded budget, and touches nothing already running', async () => {
    await watchBranch()
    blocked = true
    await installHost()

    expect(await apply()).toEqual({ acted: 'escalated', reason: 'budgetExceeded' })
    expect(enqueued).toHaveLength(0)
  })

  it('does nothing at all when the machine has the loop switched off', async () => {
    await watchBranch()
    preferences = { ...preferences, ciFix: false }
    expect(await apply()).toEqual({ acted: 'ignored-disabled', reason: 'disabled' })
    expect(enqueued).toHaveLength(0)
    expect(alerts).toHaveLength(0)
  })

  it('keeps the ledger while switched off, so turning it back on resumes rather than restarts', async () => {
    await watchBranch()
    logs = ['a', 'b']
    await apply()
    preferences = { ...preferences, ciFix: false }
    await apply()
    preferences = { ...preferences, ciFix: true }
    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 2 })
  })

  it('honours a lowered attempt cap', async () => {
    await watchBranch()
    preferences = { ...preferences, ciMaxAttempts: 1 }
    logs = ['a', 'b']
    expect(await apply()).toEqual({ acted: 'fix-dispatched', attempt: 1 })
    expect(await apply()).toEqual({ acted: 'escalated', reason: 'attemptsSpent' })
  })
})

describe('failureFingerprint', () => {
  it('reads two runs of the same failure as the same failure', async () => {
    const a = ciLoop.failureFingerprint(
      'test',
      '2026-08-04T10:00:00Z run 8817263 FAIL api.test.ts:12 expected 3 to equal 4 (1.20s)',
    )
    const b = ciLoop.failureFingerprint(
      'test',
      '2026-08-04T11:31:02Z run 9911774 FAIL api.test.ts:12 expected 3 to equal 4 (0.98s)',
    )
    expect(a).toBe(b)
  })

  it('reads a different assertion as a different failure', async () => {
    const a = ciLoop.failureFingerprint('test', 'FAIL expected 3 to equal 4')
    const b = ciLoop.failureFingerprint('test', 'FAIL cannot read property name of undefined')
    expect(a).not.toBe(b)
  })

  it('separates the same text from two different checks', async () => {
    expect(ciLoop.failureFingerprint('lint', 'boom')).not.toBe(ciLoop.failureFingerprint('test', 'boom'))
  })
})
