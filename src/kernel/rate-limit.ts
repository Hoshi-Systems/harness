import { getRequestIP, type H3Event } from 'h3'
import { apiError } from './api-error.js'

/**
 * ── Throttling the machine's unauthenticated surface ─────────────────────────
 *
 * Almost nothing here needs this: a machine serves ONE owner, and every route
 * but a handful proves that owner before it does any work. The exceptions are
 * the endpoints whose URL *is* the credential — the webhook fire URL is the
 * whole list today — and those are exactly the ones an unauthenticated caller
 * may hit as fast as the network allows.
 *
 * A 122-bit UUID secret is not going to be guessed, and that is the reason this
 * was Low rather than High (security/SECURITY_AUDIT.md L9). But "the secret is
 * long" is an argument about ONE attack. An unthrottled public endpoint that
 * dispatches agent work is also a way to spend somebody's model budget, to fill
 * a disk with turn history, and to keep a machine busy — none of which need the
 * secret to be guessed, only leaked once.
 *
 * Fixed windows in process memory, the same shape as the Platform API's
 * `utils/rate-limit.ts`. A machine is a single process by construction, so
 * there is nothing to share state with.
 *
 **/

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key)
  }
}, 60_000)
sweep.unref?.()

/** Count one hit against `key`; throw 429 once it exceeds `limit` per `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return
  }
  bucket.count += 1
  if (bucket.count > limit) {
    apiError(429, 'rateLimit.tooManyAttempts', 'Too many requests — please wait a moment and try again.', {
      retryAfter: Math.ceil((bucket.resetAt - now) / 1_000),
    })
  }
}

/** Throttle an action by client IP. */
export function rateLimitIp(event: H3Event, action: string, limit: number, windowMs: number): void {
  rateLimit(`${action}:ip:${getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'}`, limit, windowMs)
}

/**
 *
 * Reset every bucket. Test-only: the windows are minutes long, so a suite that
 * asserts a limit would otherwise poison every case after the first.
 *
 **/
export function resetRateLimits(): void {
  buckets.clear()
}
