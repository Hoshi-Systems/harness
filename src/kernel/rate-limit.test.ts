import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rateLimit, rateLimitIp, resetRateLimits } from './rate-limit.js'

/**
 *
 * The cap on the machine's unauthenticated surface (security/SECURITY_AUDIT.md L9).
 *
 * Almost nothing on a machine needs this — it serves one owner and proves them
 * on every route but a handful. The exception is an endpoint whose URL IS the
 * credential, and the webhook fire URL is the whole list. What is asserted here
 * is the limiter itself: that the window is FIXED rather than sliding (a
 * blocked caller who keeps hammering must still be let through when the window
 * turns over, or a hot sender is locked out forever), that keys do not bleed
 * into each other, and that the 429 carries a `retryAfter` a sender can obey.
 *
 **/

beforeEach(() => {
  resetRateLimits()
  vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

const status = (thrown: unknown) => (thrown as { statusCode?: number }).statusCode
const attempt = (key: string, limit = 3, windowMs = 60_000) => {
  try {
    rateLimit(key, limit, windowMs)
    return undefined
  } catch (thrown) {
    return thrown
  }
}

describe('rateLimit', () => {
  it('admits exactly `limit` hits, then refuses', () => {
    for (let hit = 0; hit < 3; hit += 1) expect(attempt('fire'), `hit ${hit}`).toBeUndefined()
    expect(status(attempt('fire'))).toBe(429)
  })

  it('tells the caller how long to wait', () => {
    /** A 429 with no `retryAfter` is a sender's cue to retry immediately, which
     *  is how a throttle turns into a hot loop. */
    for (let hit = 0; hit < 3; hit += 1) attempt('fire')
    vi.advanceTimersByTime(20_000)
    const error = attempt('fire') as { data?: { params?: { retryAfter?: number } } }
    expect(error.data?.params?.retryAfter).toBe(40)
  })

  it('lets the caller back in when the window turns over', () => {
    for (let hit = 0; hit < 3; hit += 1) attempt('fire')
    expect(status(attempt('fire'))).toBe(429)
    vi.advanceTimersByTime(60_001)
    expect(attempt('fire')).toBeUndefined()
  })

  it('does not extend the window by being hammered inside it', () => {
    /** A FIXED window, not a sliding one: attempts made while blocked must not
     *  push the reset out, or a sender that retries on a timer never recovers. */
    for (let hit = 0; hit < 3; hit += 1) attempt('fire')
    for (let hit = 0; hit < 50; hit += 1) {
      vi.advanceTimersByTime(1_000)
      attempt('fire')
    }
    vi.advanceTimersByTime(11_000)
    expect(attempt('fire')).toBeUndefined()
  })

  it('keeps separate keys separate', () => {
    for (let hit = 0; hit < 3; hit += 1) attempt('one')
    expect(status(attempt('one'))).toBe(429)
    expect(attempt('two')).toBeUndefined()
  })
})

describe('rateLimitIp', () => {
  /** A minimal event carrying only what `getRequestIP` reads: `context`, the
   *  `x-forwarded-for` header, and the socket's peer address. */
  const eventFrom = (ip: string | null) =>
    ({
      context: {},
      node: { req: { socket: { remoteAddress: undefined }, headers: ip ? { 'x-forwarded-for': ip } : {} } },
    }) as never

  it('throttles one caller without touching another', () => {
    for (let hit = 0; hit < 3; hit += 1) rateLimitIp(eventFrom('10.0.0.1'), 'fire', 3, 60_000)
    expect(() => rateLimitIp(eventFrom('10.0.0.1'), 'fire', 3, 60_000)).toThrow()
    expect(() => rateLimitIp(eventFrom('10.0.0.2'), 'fire', 3, 60_000)).not.toThrow()
  })

  it('throttles callers it cannot identify as one bucket, rather than not at all', () => {
    /** An unidentifiable peer is the case a limiter is most tempted to skip.
     *  Sharing one `unknown` bucket is stricter than skipping and is the safe
     *  direction to be wrong in. */
    for (let hit = 0; hit < 3; hit += 1) rateLimitIp(eventFrom(null), 'fire', 3, 60_000)
    expect(() => rateLimitIp(eventFrom(null), 'fire', 3, 60_000)).toThrow()
  })

  it('keeps separate actions separate for the same caller', () => {
    for (let hit = 0; hit < 3; hit += 1) rateLimitIp(eventFrom('10.0.0.1'), 'fire', 3, 60_000)
    expect(() => rateLimitIp(eventFrom('10.0.0.1'), 'other', 3, 60_000)).not.toThrow()
  })
})
