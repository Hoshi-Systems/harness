import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureKernel, extendKernel, ports } from './host-ports.js'

/**
 *
 * `claimsCompletion` is the one port more than one plugin answers, and the only
 * one they COMPOSE. Two plugins claim sessions for the same reason — somebody
 * else is going to report this outcome — and whichever started second would
 * erase the other's claim if it simply assigned.
 *
 * The failure that would cause is quiet and annoying rather than loud: a
 * machine that tells its owner about every step of a five-node workflow, until
 * the notifications are noise nobody reads.
 *
 **/

beforeEach(() => {
  configureKernel({})
})

afterEach(() => {
  configureKernel({})
})

/** What a plugin's `host.provide((current) => …)` does, without a whole plugin. */
function claim(sessions: string[]): void {
  extendKernel((current) => ({
    ...current,
    claimsCompletion: async (sessionId) =>
      (await current.claimsCompletion?.(sessionId)) || sessions.includes(sessionId),
  }))
}

describe('claiming a session', () => {
  it('is nobody at all on a machine running neither goals nor workflows', async () => {
    /**
     *
     * The default has to be "no": a lone machine still tells its owner when a
     * turn finishes, which is the whole point of the alert.
     *
     **/
    expect(ports().claimsCompletion).toBeUndefined()
  })

  it('keeps every claimant, not just the last one to arrive', async () => {
    claim(['ses_goal'])
    claim(['ses_run'])

    expect(await ports().claimsCompletion?.('ses_goal')).toBe(true)
    expect(await ports().claimsCompletion?.('ses_run')).toBe(true)
  })

  it('leaves an unclaimed session unclaimed', async () => {
    claim(['ses_goal'])
    claim(['ses_run'])
    expect(await ports().claimsCompletion?.('ses_plain')).toBe(false)
  })

  it('stops asking once somebody has claimed it', async () => {
    /**
     *
     * Short-circuiting matters: each claimant reads its own store, and a
     * machine with a busy workflow ledger should not pay for every one of them
     * on every turn that settles.
     *
     **/
    let asked = 0
    extendKernel((current) => ({
      ...current,
      claimsCompletion: async (sessionId) => {
        asked += 1
        return (await current.claimsCompletion?.(sessionId)) || sessionId === 'ses_first'
      },
    }))
    claim(['ses_second'])

    await ports().claimsCompletion?.('ses_second')
    expect(asked).toBe(1)
  })
})
