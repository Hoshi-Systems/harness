import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { EDITOR_AUTH_COOKIE, PREVIEW_AUTH_COOKIE } from './client-session.js'
import { sessionSecret } from './session-secret.js'
import { authorizeEditorUpgrade, authorizePreviewUpgrade, authorizeUpgrade } from './upgrade-auth.js'

/**
 * ── A scoped credential may not open a socket ────────────────────────────────
 *
 * One line in `authorizeRawToken` — `if (session.scope) return null` — is what
 * makes EVERY websocket on this machine owner-only: the editor bridge, the
 * preview proxy, voice dictation, and the agent's desktop. A guest holding a
 * session grant is exactly the credential it refuses.
 *
 * It had no test. The desktop is what made
 * that worth fixing: "can a guest watch the agent's screen" is answered by this
 * line and nothing else, and an answer that rests on one unguarded clause is
 * one refactor away from being wrong.
 *
 **/

/**
 *
 * `sessionSecret()` and not a literal. `client-session.ts` captures the secret
 * at MODULE LOAD, so a test that sets `SESSION_SECRET` in a hook signs with one
 * value while the code verifies with another — which is how the first draft of
 * this file "proved" that the owner's own token is refused.
 *
 **/
const SECRET = () => new TextEncoder().encode(sessionSecret())

async function token(claims: Record<string, unknown>): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(SECRET())
}

function upgrade(raw: string): Promise<boolean> {
  const url = new URL(`http://machine.test/desktop/stream?hoshi_token=${encodeURIComponent(raw)}`)
  return authorizeUpgrade(new Headers(), url)
}

describe('authorizing a websocket upgrade', () => {
  it('accepts the owner’s own session token', async () => {
    expect(await upgrade(await token({ userId: 1, email: 'owner@example.com' }))).toBe(true)
  })

  it('REFUSES a guest token, however valid its signature', async () => {
    /**
     *
     * A share grant's token is signed by the same secret and is not a forgery —
     * it is simply not a machine credential. This is the whole of why a
     * shared-session guest cannot reach the desktop stream.
     *
     **/
    const guest = await token({
      userId: 2,
      email: 'guest@example.com',
      scope: { machineId: 'm1', grantId: 'g1', sessionId: 's1', level: 'control' },
    })
    expect(await upgrade(guest)).toBe(false)
  })

  it('refuses an observe-level guest too — the level is not the point', async () => {
    const guest = await token({
      userId: 2,
      email: 'guest@example.com',
      scope: { machineId: 'm1', grantId: 'g1', sessionId: 's1', level: 'observe' },
    })
    expect(await upgrade(guest)).toBe(false)
  })

  it('refuses a MALFORMED scope as well — for a different reason, and it matters', async () => {
    /**
     *
     * `readScope` rejects a scope missing any of its four fields, so such a
     * token is refused before the owner-lock ever reads it. The first draft of
     * this file omitted `machineId` and therefore "proved" the guest refusal
     * while the clause it meant to pin was already deleted.
     *
     **/
    const malformed = await token({ userId: 2, email: 'guest@example.com', scope: { grantId: 'g1' } })
    expect(await upgrade(malformed)).toBe(false)
  })

  it('refuses a token signed with a different secret', async () => {
    const forged = await new SignJWT({ userId: 1, email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('not-the-machines-secret'))
    expect(await upgrade(forged)).toBe(false)
  })

  it('refuses no credential at all', async () => {
    expect(await authorizeUpgrade(new Headers(), new URL('http://machine.test/desktop/stream'))).toBe(false)
  })

  it('refuses a preview credential on whole-machine sockets', async () => {
    const owner = await token({ userId: 1, email: 'owner@example.com' })
    const headers = new Headers({ cookie: `${PREVIEW_AUTH_COOKIE}=${encodeURIComponent(owner)}` })

    expect(await authorizeUpgrade(headers, new URL('http://machine.test/desktop/stream'))).toBe(false)
    expect(await authorizePreviewUpgrade(headers, new URL('http://machine.test/proxy/3000/socket'))).toBe(true)
    expect(await authorizeEditorUpgrade(headers, new URL('http://machine.test/editor/socket'))).toBe(false)
  })

  it('keeps the editor credential on the editor socket', async () => {
    const owner = await token({ userId: 1, email: 'owner@example.com' })
    const headers = new Headers({ cookie: `${EDITOR_AUTH_COOKIE}=${encodeURIComponent(owner)}` })

    expect(await authorizeEditorUpgrade(headers, new URL('http://machine.test/editor/socket'))).toBe(true)
    expect(await authorizeUpgrade(headers, new URL('http://machine.test/desktop/stream'))).toBe(false)
    expect(await authorizePreviewUpgrade(headers, new URL('http://machine.test/proxy/3000/socket'))).toBe(false)
  })
})
