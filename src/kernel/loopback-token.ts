import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { createCachedStore } from './json-store.js'

/**
 * ── The loopback credential ──────────────────────────────────────────────────
 *
 * A skill runs inside OpenCode, on this machine, with no browser and no
 * session — so it cannot present the cookie or bearer every other sidecar route
 * expects. It still needs to reach exactly one route: the OAuth token minter.
 *
 * This is that credential. Three properties keep it small:
 *
 *  1. It is only accepted from LOOPBACK. A request arriving over the machine's
 *     public ingress is refused even with the correct value, so the token being
 *     readable by anything on the box is the intended blast radius rather than
 *     an accident — it is a marker of "I am already inside", not a grant.
 *  2. It authorizes NOTHING by itself. The route it opens mints a provider
 *     token whose account is resolved upstream from the machine's owner; the
 *     caller cannot influence which one. Holding this token is equivalent to
 *     being able to run a command on the machine, which the agent already can.
 *  3. It is machine-local and never leaves. It is not a Platform credential and
 *     is not accepted by the Platform.
 *
 * It reaches the agent the same way every other credential does — the vault
 * writes it into OpenCode's `.env` — which is safe here precisely because it is
 * long-lived by design, unlike the provider tokens it exists to fetch.
 *
 **/

/** The vault key the agent reads it from. */
export const LOOPBACK_TOKEN_KEY = 'HOSHI_MACHINE_TOKEN'

interface LoopbackStore {
  token: string | null
}

const store = createCachedStore<LoopbackStore>('loopback.json', (stored) => {
  const parsed = stored as LoopbackStore | null
  return parsed && typeof parsed.token === 'string' ? parsed : { token: null }
})

/** Get or mint this machine's loopback token. Stable across restarts, because
 *  rotating it would silently break every already-seeded skill until the pack
 *  was reinstalled. */
export async function loopbackToken(): Promise<string> {
  const state = await store.load()
  if (!state.token) {
    state.token = randomBytes(32).toString('base64url')
    store.persist()
  }
  return state.token
}

/** Whether the request came from this machine itself. IPv6-mapped IPv4 is the
 *  common shape on a dual-stack listener and is genuinely loopback, so it
 *  counts; anything else does not. */
function fromLoopback(event: H3Event): boolean {
  const address = event.node.req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether this request carries the loopback credential AND arrived over
 *  loopback. Both, always — the origin check is what makes the credential's
 *  local readability acceptable. */
export async function isLoopbackCall(event: H3Event): Promise<boolean> {
  if (!fromLoopback(event)) return false
  const authorization = getHeader(event, 'authorization') ?? ''
  const presented = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  if (!presented) return false

  const expected = await loopbackToken()
  /**
   *
   * Same length by construction, so a plain comparison leaks nothing useful;
   * kept explicit so a future change to the token's shape stays safe.
   *
   **/
  return presented.length === expected.length && presented === expected
}
