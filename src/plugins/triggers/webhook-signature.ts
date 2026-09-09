import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * ── Signed webhook fires ─────────────────────────────────────────────────────
 *
 * A workflow-mode webhook is a PUBLIC endpoint that dispatches agent work from
 * an unauthenticated request body: the id+secret pair in the URL is the whole
 * auth story, and a URL leaks the way URLs leak — a proxy log, a screenshot, a
 * pasted curl. Turning on a signing secret makes the CALLER prove it holds a
 * second secret that never travels in the URL, and pins each call to a moment
 * in time so a captured request can't be replayed later.
 *
 * The scheme is the industry-standard one (Stripe/GitHub shaped), so a sender
 * that already signs webhooks needs no new code:
 *
 *   X-Hoshi-Timestamp: <unix seconds>
 *   X-Hoshi-Signature: sha256=<hex HMAC-SHA256("<timestamp>.<raw body>")>
 *
 * Verification runs against the RAW body, before any parsing — a signature over
 * re-serialized JSON would verify something the sender never sent.
 *
 **/

export const WEBHOOK_SIGNATURE_HEADER = 'x-hoshi-signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-hoshi-timestamp'

/** How far a caller's clock may be off. Also the replay window: a request is
 *  only reusable while its timestamp is still fresh, and the cache below
 *  covers exactly that stretch. */
const MAX_SKEW_SECONDS = 300

/** Why a signed fire was rejected. The route answers a uniform 401 — this is
 *  for the server log, not the caller. */
export type WebhookSignatureFailure =
  /** No signature/timestamp header at all — an unsigned call to a signed hook. */
  | 'missing'
  /** Headers present but not the documented shape. */
  | 'malformed'
  /** Timestamp outside the skew window. */
  | 'stale'
  /** Correct shape, wrong digest. */
  | 'mismatch'
  /** A byte-identical request already fired inside its own freshness window. */
  | 'replayed'

/** Mint a signing secret. 256 bits of hex: long enough that the digest is the
 *  only realistic attack, short enough to paste into a sender's config field. */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex')
}

/** The signature a caller must send. Exported because it is the contract — the
 *  tests sign with it, and it is what the UI's copyable snippet describes. */
export function signWebhookBody(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

/**
 *
 * Signatures already honoured, with the instant they stop being replayable.
 * Bounded by the skew window rather than by count: entries expire on their own,
 * and every insert sweeps what has expired.
 *
 **/
const seen = new Map<string, number>()

function rememberSignature(signature: string, expiresAt: number): void {
  const now = Date.now()
  for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key)
  seen.set(signature, expiresAt)
}

function equalDigest(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  /**
   *
   * timingSafeEqual throws on a length mismatch, which is itself a comparison —
   * but the length of a fixed-format digest carries nothing secret.
   *
   **/
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Verify a signed fire. Returns null when the request is good (and records it
 *  against replay), or the reason it was rejected. */
export function verifyWebhookSignature(input: {
  secret: string
  rawBody: string
  signature: string | undefined
  timestamp: string | undefined
  /** Injectable clock — the tests pin skew boundaries with it. */
  now?: number
}): WebhookSignatureFailure | null {
  const { secret, rawBody, signature, timestamp } = input
  if (!signature || !timestamp) return 'missing'

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt) || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return 'malformed'

  const now = input.now ?? Date.now()
  const skewSeconds = Math.abs(now / 1_000 - sentAt)
  if (skewSeconds > MAX_SKEW_SECONDS) return 'stale'

  if (!equalDigest(signature.toLowerCase(), signWebhookBody(secret, timestamp, rawBody).toLowerCase())) {
    return 'mismatch'
  }
  /**
   *
   * Only a VALID signature is worth remembering — caching rejected ones would
   * let anyone fill the map with garbage.
   *
   **/
  if (seen.has(signature.toLowerCase())) return 'replayed'
  rememberSignature(signature.toLowerCase(), now + MAX_SKEW_SECONDS * 1_000)
  return null
}
