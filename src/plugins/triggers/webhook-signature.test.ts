import { describe, expect, it } from 'vitest'
import { generateSigningSecret, signWebhookBody, verifyWebhookSignature } from './webhook-signature.js'

const SECRET = 'a'.repeat(64)
const BODY = '{"action":"opened","issue":{"id":42}}'

/** A fresh timestamp per case — the replay cache is module state keyed by
 *  signature, so two cases signing the same body at the same second would
 *  collide on purpose-built "replayed" verdicts. */
let tick = 0
function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1_000) - tick++)
}

function signed(body = BODY, secret = SECRET) {
  const timestamp = freshTimestamp()
  return { timestamp, signature: signWebhookBody(secret, timestamp, body) }
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed request', () => {
    const { timestamp, signature } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp })).toBeNull()
  })

  it('rejects an unsigned request', () => {
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: undefined, timestamp: undefined })).toBe(
      'missing',
    )
    const { timestamp } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: undefined, timestamp })).toBe('missing')
  })

  it('rejects a replay of a request it already honoured', () => {
    const { timestamp, signature } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp })).toBeNull()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp })).toBe('replayed')
  })

  it('rejects a stale timestamp — a capture replayed later is outside the window', () => {
    const now = Date.now()
    const timestamp = String(Math.floor(now / 1_000) - 3_600)
    const signature = signWebhookBody(SECRET, timestamp, BODY)
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp, now })).toBe('stale')
  })

  it('rejects a timestamp too far in the future', () => {
    const now = Date.now()
    const timestamp = String(Math.floor(now / 1_000) + 3_600)
    const signature = signWebhookBody(SECRET, timestamp, BODY)
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp, now })).toBe('stale')
  })

  it('rejects a body tampered with after signing', () => {
    const { timestamp, signature } = signed()
    const tampered = BODY.replace('42', '43')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: tampered, signature, timestamp })).toBe('mismatch')
  })

  it('rejects a signature made with another secret', () => {
    const timestamp = freshTimestamp()
    const signature = signWebhookBody('b'.repeat(64), timestamp, BODY)
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp })).toBe('mismatch')
  })

  it('rejects a signature moved onto a different timestamp', () => {
    const { signature } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: freshTimestamp() })).toBe(
      'mismatch',
    )
  })

  it('rejects headers that are not the documented shape', () => {
    const { timestamp } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: 'nonsense', timestamp })).toBe(
      'malformed',
    )
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature: `sha256=${'z'.repeat(64)}`, timestamp }),
    ).toBe('malformed')
    const { signature } = signed()
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signature, timestamp: 'yesterday' })).toBe(
      'malformed',
    )
  })

  it('signs an empty body — a fire with no payload is still a fire', () => {
    const { timestamp, signature } = signed('')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: '', signature, timestamp })).toBeNull()
  })
})

describe('generateSigningSecret', () => {
  it('mints 256 bits of hex, never the same twice', () => {
    const a = generateSigningSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(generateSigningSecret())
  })
})
