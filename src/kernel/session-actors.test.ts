import { describe, expect, it, beforeEach } from 'vitest'
import { __resetSessionActors, sessionActor, setSessionActor } from './session-actors.js'

/**
 * ── Who is acting in a session ───────────────────────────────────────────────
 *
 * The org audit trail attributes every action to a user, and falls back to the
 * machine's owner when it does not know. That fallback is why this registry
 * exists: a guest's prompt attributed to the owner is worse than no trail,
 * because it is confidently wrong about the only question an audit is asked.
 *
 * The registry was write-never for a while — the retired proxy wrote it, the
 * package carried `setSessionActor` across with no caller, and the audit read
 * `null` for everybody (docs/STRUCTURE_REVIEW.md H-10). These are the
 * behaviours the reader depends on.
 *
 **/

beforeEach(() => {
  __resetSessionActors()
})

describe('session actors', () => {
  it('does not know about a session nobody has prompted', () => {
    expect(sessionActor('ses_unknown')).toBeNull()
  })

  it('remembers who prompted', () => {
    setSessionActor('ses_1', 42)
    expect(sessionActor('ses_1')).toBe(42)
  })

  it('takes the LATEST actor, so an owner taking a session back stops attributing to the guest', () => {
    setSessionActor('ses_1', 42)
    setSessionActor('ses_1', 7)
    expect(sessionActor('ses_1')).toBe(7)
  })

  it('answers null for no session at all rather than throwing', () => {
    expect(sessionActor(null)).toBeNull()
    expect(sessionActor(undefined)).toBeNull()
    expect(sessionActor('')).toBeNull()
  })

  it('is bounded, and evicts the least recently prompted first', () => {
    /**
     *
     * A long-lived machine must not grow this without limit, and an evicted
     * session falls back to the owner — the answer it had before the feature
     * existed. What must NOT happen is evicting the session somebody is
     * actively prompting, which is why re-prompting counts as recency.
     *
     **/
    for (let i = 0; i < 500; i++) setSessionActor(`ses_${i}`, i)
    /** Touch the oldest so it is no longer the oldest. */
    setSessionActor('ses_0', 999)
    setSessionActor('ses_500', 500)

    expect(sessionActor('ses_0')).toBe(999)
    expect(sessionActor('ses_500')).toBe(500)
    expect(sessionActor('ses_1')).toBeNull()
  })
})
