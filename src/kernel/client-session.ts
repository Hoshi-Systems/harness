import type { MachineTokenScope } from '../wire/index.js'
import { jwtVerify } from 'jose'
import type { H3Event } from 'h3'
import { getCookie, getHeader } from 'h3'

import { sessionSecret } from './session-secret.js'

/** The platform's session cookie name — also read by the WebSocket upgrade
 *  path, which sees raw headers instead of an H3 event. */
export const SESSION_COOKIE = 'session'
/** The preview proxy's own auth cookie — set on the machine host when the
 *  embedded browser enters `/proxy/{port}/` with a `?hoshi_token=` (an iframe
 *  can't send an Authorization header), then honored here like a bearer. */
export const PREVIEW_AUTH_COOKIE = 'hoshi-preview-auth'
/** The embedded editor's credential. Separate from preview auth so untrusted
 * preview content cannot use its own ambient cookie to enter the editor. */
export const EDITOR_AUTH_COOKIE = 'hoshi-editor-auth'
/** Alternate bearer channel: a previewed app reached through the preview proxy
 *  may already spend its own `Authorization` header on its own auth scheme.
 *  This header carries the exact same credential a normal `Authorization:
 *  Bearer` would — honored everywhere a bearer is, never a second, weaker
 *  path in. */
export const HOSHI_TOKEN_HEADER = 'x-hoshi-token'
const SECRET = new TextEncoder().encode(sessionSecret())

/** A GUEST token's scope claim (job 12): one session, one level, one grant.
 *  Declared once in `@hoshi/shared` and aliased on both sides — this machine
 *  verifies exactly what the Platform signs (docs/STRUCTURE_REVIEW.md P-05). */
export type { MachineTokenScope } from '../wire/index.js'

export interface SessionPayload {
  userId: number
  email: string
  /** Present ONLY on a guest token. Its presence is what makes this credential
   *  narrow: `requireAuth` (utils/auth.ts) refuses any session carrying it, so a
   *  scoped token reaches nothing except the one path that explicitly opts in
   *  via `requireSessionAccess`. Absent on every owner credential. */
  scope?: MachineTokenScope
  /** This machine is flagged internal on the Platform (Admin → Machines), so
   *  Hoshi's own seeded skills, agents and commands are visible and editable
   *  here instead of hidden and locked.
   *
   *  A CLAIM, not machine state, and that is the point: it is signed by the
   *  Platform with the secret this machine verifies against, so a client cannot
   *  award itself the flag by asking, and an admin turning it off takes effect
   *  on the next minted token rather than on the next re-provision. */
  internal?: boolean
}

/** Read the `scope` claim, strictly.
 *
 *  Returns `undefined` for "no scope" and `null` for "a scope was claimed but is
 *  not well-formed". The caller must treat null as REJECT rather than as absent:
 *  silently dropping an unparsable scope would turn a malformed guest token into
 *  a full owner token, which is the one failure this whole design exists to
 *  prevent. */
function readScope(claim: unknown): MachineTokenScope | null | undefined {
  if (claim === undefined || claim === null) return undefined
  if (typeof claim !== 'object') return null
  const scope = claim as Record<string, unknown>
  if (typeof scope.machineId !== 'string' || !scope.machineId) return null
  if (typeof scope.sessionId !== 'string' || !scope.sessionId) return null
  if (typeof scope.grantId !== 'string' || !scope.grantId) return null
  if (scope.level !== 'observe' && scope.level !== 'control') return null
  return {
    machineId: scope.machineId,
    sessionId: scope.sessionId,
    level: scope.level,
    grantId: scope.grantId,
  }
}

/** Validate a platform-issued session JWT — from the `session` cookie (web) or
 *  an `Authorization: Bearer` header (CLI/Electron/automation). Both are JWTs
 *  signed with the shared SESSION_SECRET, so the machine verifies them by
 *  signature alone — no DB, no round-trip to the platform.
 *
 *  Opaque PATs (`hoshi_…`) are deliberately NOT accepted here: they can only be
 *  checked against the platform's token table, which the machine has no access
 *  to. A programmatic client exchanges its PAT for a short-lived machine token
 *  at the platform's `POST /machines/[id]/token` and sends *that* as the bearer.
 *  `jwtVerify` enforces `exp`, so an expired token returns null → 401, which is
 *  the client's signal to mint a fresh one. */
export async function getAuthSession(event: H3Event): Promise<SessionPayload | null> {
  /**
   *
   * Deliberately NOT the preview-auth cookie: it is a full machine credential
   * but must only authorize the preview surface (see `requirePreviewAuth` in
   * utils/auth.ts). On the path-prefix preview the previewed app is same-origin
   * with the Machine API, so honoring `hoshi-preview-auth` here would let a
   * script in an untrusted previewed page ride it to /opencode, /secrets, …
   *
   **/
  const token = bearerJwt(event) ?? getCookie(event, SESSION_COOKIE)
  if (!token) return null
  return verifySessionJwt(token)
}

/** Verify one raw token value as a platform session JWT — shared by the H3
 *  path above and the WebSocket upgrade path (which has no event). */
export async function verifySessionJwt(token: string): Promise<SessionPayload | null> {
  try {
    /**
     *
     * The machine's clock and the Platform's aren't the same clock — a minute
     * of tolerance keeps a slightly-skewed machine from 401ing tokens that are
     * genuinely valid (the client reads those 401s as "machine broken").
     *
     **/
    const { payload } = await jwtVerify(token, SECRET, { algorithms: ['HS256'], clockTolerance: 60 })
    if (typeof payload.userId !== 'number' || typeof payload.email !== 'string') return null
    /**
     *
     * A claimed-but-malformed scope is a rejection, never an omission — see
     * readScope. Dropping it would promote a broken guest token to an owner one.
     *
     **/
    const scope = readScope(payload.scope)
    if (scope === null) return null
    /**
     *
     * Never on a guest token. A shared session hands someone one conversation on
     * someone else's machine; inheriting the owner's internal flag along with it
     * would hand them the machine's insides too.
     *
     **/
    return scope
      ? { userId: payload.userId, email: payload.email, scope }
      : {
          userId: payload.userId,
          email: payload.email,
          ...(payload.internal === true ? { internal: true } : {}),
        }
  } catch {
    return null
  }
}

/** The bearer value when it's a verifiable JWT. A `hoshi_` PAT is opaque to the
 *  machine, so it's ignored here and the request falls through to the cookie
 *  (and ultimately 401) rather than being mistaken for a session.
 *
 *  {@link HOSHI_TOKEN_HEADER} is checked FIRST, ahead of `Authorization`. That
 *  ordering is the whole point of the header: a client that carries its own
 *  bearer for its own service still has a `Bearer ` prefix, so treating
 *  `Authorization` as the preferred source made the fallback unreachable for
 *  exactly the case it exists for — the foreign token was then verified as a
 *  session JWT and 401'd. An explicit
 *  `X-Hoshi-Token` is unambiguous; `Authorization` may belong to somebody else.
 *  Last comes {@link basicAuthToken}, for a client that only speaks HTTP Basic. */
function bearerJwt(event: H3Event): string | null {
  const header = getHeader(event, 'authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  const token = getHeader(event, HOSHI_TOKEN_HEADER) || bearer || basicAuthToken(event) || null
  return token && !token.startsWith('hoshi_') ? token : null
}

/** Some clients only speak HTTP Basic — `opencode attach` pointed at this
 *  proxy by hand is the canonical one (its CLI has no flag for a raw
 *  bearer/custom header, only `--username`/`--password`). Treat the password
 *  half of Basic auth as the exact same token a `Bearer` header would carry
 *  (the username is ignored — any value works). The Hoshi SSH gateway's own
 *  TUI sends a real Bearer header; this path stays for Basic-only clients.
 *  Exported for {@link ../utils/auth}'s static-token check, which accepts the
 *  same shape of credential. */
export function basicAuthToken(event: H3Event): string | null {
  const header = getHeader(event, 'authorization')
  if (!header?.startsWith('Basic ')) return null
  let decoded: string
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return null
  }
  const colon = decoded.indexOf(':')
  return colon === -1 ? null : decoded.slice(colon + 1)
}
