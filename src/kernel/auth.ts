import crypto from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie, getHeader } from 'h3'
import { apiError } from './api-error.js'
import {
  getAuthSession,
  verifySessionJwt,
  EDITOR_AUTH_COOKIE,
  PREVIEW_AUTH_COOKIE,
  HOSHI_TOKEN_HEADER,
  basicAuthToken,
  type SessionPayload,
} from './client-session.js'

/**
 *
 * A machine belongs to exactly one user. With per-machine ingress the machine is
 * publicly addressable, so a valid JWT for another user must NOT grant access.
 * Injected at provision time; unset in local/static dev → check is skipped.
 *
 **/
const OWNER_ID = process.env.MACHINE_OWNER_ID ? Number(process.env.MACHINE_OWNER_ID) : null

/**
 *
 * Refuse to boot a production machine that has no owner.
 *
 * `SESSION_SECRET` is shared fleet-wide, so a machine that verifies platform
 * JWTs but has no `MACHINE_OWNER_ID` accepts ANY signed-in user's token as its
 * owner — every route on it, for every account on the platform. The lock was
 * `if (OWNER_ID !== null && …)`, which is the right shape for dev and a silent
 * cross-tenant opening in production (security/SECURITY_AUDIT.md M2).
 *
 * `buildMachineEnv` has always injected the id, so the provisioning path was
 * never exposed. What was missing is what happens when something else starts a
 * machine — a custom image, a hand-run container, a provisioning variant that
 * copied the secret and forgot the id. That machine came up open and said
 * nothing. Now it does not come up.
 *
 * A static-token machine is exempt because it is the other authentication model
 * entirely: it never receives the platform secret, so there is no fleet-wide
 * credential for a missing owner id to leave unguarded — its bearer IS the
 * proof of ownership.
 *
 **/
export function assertOwnerLockConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return
  if (STATIC_TOKEN) return
  if (OWNER_ID !== null && Number.isInteger(OWNER_ID) && OWNER_ID > 0) return
  throw new Error(
    "MACHINE_OWNER_ID must be set to this machine owner's user id in production. Without it the " +
      'owner lock is skipped and any valid platform session — every account on the platform — is ' +
      'accepted as the owner of this machine. Set MACHINE_OWNER_ID, or run in static-token mode ' +
      '(MACHINE_STATIC_TOKEN) if this is a connected BYO machine.',
  )
}

/**
 *
 * A 'connect existing' machine isn't provisioned by the Platform, so it never
 * receives our SESSION_SECRET and can't verify platform JWTs. Instead the
 * operator runs it with a shared static token; the Platform stores that token and
 * the browser sends it as the bearer. When set, a bearer equal to it authorizes
 * the request as the owner. Unset on orchestrator-provisioned machines.
 *
 **/
const STATIC_TOKEN = process.env.MACHINE_STATIC_TOKEN || null

/** The OWNER's gate — every machine route except the session-scoped one.
 *
 *  A GUEST token (job 12) is refused here, unconditionally, by the mere presence
 *  of its `scope` claim. That is the load-bearing line of the whole feature: it
 *  means a guest credential is rejected by `/files`, `/secrets`, `/git`,
 *  `/processes`, `/memory`, `/skills`, `/mcp`, `/tools`, `/preferences` and
 *  every other route WITHOUT any of them having to know shared sessions exist.
 *  Nothing opts back in: the guest-aware variant that used to sit below this
 *  had no callers left once the OpenCode proxy went away, so a guest token now
 *  reaches nothing at all through this file.
 *
 *  Checking the scope explicitly rather than leaning on the owner lock is
 *  deliberate: `OWNER_ID` is unset on non-orchestrator machines (local dev,
 *  `static`), so on those the lock is skipped entirely and a scoped token would
 *  otherwise sail straight through as a full machine credential. */
export async function requireAuth(event: H3Event): Promise<SessionPayload> {
  /**
   *
   * Accept the operator's shared static token before the JWT path — a connected
   * machine has no SESSION_SECRET to verify a JWT against. The preview-auth
   * cookie is intentionally NOT accepted here: it is honored only on the preview
   * surface (see `requirePreviewAuth`), never on the Machine API's own routes.
   *
   **/
  if (STATIC_TOKEN) {
    const bearer = rawBearer(event)
    if (bearer && timingSafeEqualStr(bearer, STATIC_TOKEN)) {
      return { userId: OWNER_ID ?? 0, email: 'connected-client' }
    }
  }

  const session = await getAuthSession(event)
  if (!session) {
    apiError(401, 'auth.notSignedIn', 'Not signed in.')
  }
  if (session.scope) {
    apiError(403, 'auth.sessionScopedToken', 'This token is limited to a single shared session.')
  }
  if (OWNER_ID !== null && session.userId !== OWNER_ID) {
    apiError(403, 'auth.machineOwnedByAnother', 'This machine belongs to another user.')
  }
  return session
}

/** Authorize a request to the PREVIEW surface (the `/proxy/{port}/**` entry, the
 *  absolute-path root fallback, and the dedicated `p{port}--` preview host).
 *  Unlike {@link requireAuth} this additionally accepts the `hoshi-preview-auth`
 *  cookie — the one-shot machine bearer the iframe handshake persists so an
 *  iframe (which can't send an Authorization header) can load its subresources.
 *  Keeping that cookie OUT of {@link requireAuth} is what stops a script in a
 *  same-origin previewed page from riding it to the Machine API's own routes. */
export async function requirePreviewAuth(event: H3Event): Promise<SessionPayload> {
  const cookie = getCookie(event, PREVIEW_AUTH_COOKIE)
  if (cookie) {
    const viaPreviewCookie = await authorizeRawToken(cookie)
    if (viaPreviewCookie) return viaPreviewCookie
  }
  return requireAuth(event)
}

/** Authorize the embedded editor without accepting the preview surface's
 * credential. The cookie is path-scoped by the editor handshake. */
export async function requireEditorAuth(event: H3Event): Promise<SessionPayload> {
  const cookie = getCookie(event, EDITOR_AUTH_COOKIE)
  if (cookie) {
    const viaEditorCookie = await authorizeRawToken(cookie)
    if (viaEditorCookie) return viaEditorCookie
  }
  return requireAuth(event)
}

/** Authorize one raw token value outside an H3 event — the WebSocket upgrade
 *  path hands us headers, not an event. Same chain as {@link requireAuth}
 *  (static token, then platform JWT, then the owner lock), but returns null
 *  instead of throwing so the caller can try several candidates.
 *
 *  Scoped guest tokens are refused here for the same reason as in
 *  {@link requireAuth}: the surfaces this guards (voice dictation's WebSocket)
 *  are whole-machine capabilities, not session-scoped ones. */
export async function authorizeRawToken(token: string | null | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  if (STATIC_TOKEN && timingSafeEqualStr(token, STATIC_TOKEN)) {
    return { userId: OWNER_ID ?? 0, email: 'connected-client' }
  }
  const session = await verifySessionJwt(token)
  if (!session) return null
  if (session.scope) return null
  if (OWNER_ID !== null && session.userId !== OWNER_ID) return null
  return session
}

/** The raw credential (no JWT/PAT shape assumptions — the static token is an
 *  arbitrary operator-chosen string). {@link HOSHI_TOKEN_HEADER} takes
 *  precedence over `Authorization` for the same reason as in utils/session.ts:
 *  a client whose own bearer also uses the `Bearer ` scheme would otherwise
 *  never reach the fallback. Then `Authorization: Bearer`, then
 *  {@link basicAuthToken} for a client that only speaks HTTP Basic (e.g.
 *  `opencode attach`). */
function rawBearer(event: H3Event): string | null {
  const header = getHeader(event, 'authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  return getHeader(event, HOSHI_TOKEN_HEADER) || bearer || basicAuthToken(event) || null
}

/** Constant-time string compare, length-safe (timingSafeEqual throws on a length
 *  mismatch, which would itself leak length). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
