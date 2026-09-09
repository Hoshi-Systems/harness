import type { AuthorizationServerMetadata } from './oauth.js'

/**
 * ── Authorizations in flight ─────────────────────────────────────────────────
 *
 * The `state` parameter and the PKCE verifier that go with it, held only
 * between the moment a person is sent to their identity provider and the moment
 * they come back.
 *
 * IN MEMORY ON PURPOSE, and it is the security property rather than a shortcut.
 * A verifier written to disk outlives the browser tab it belongs to, and a
 * restart mid-flow SHOULD invalidate the flow — the alternative is a machine
 * that will still accept an authorization code minted before it was rebooted.
 * The cost is one retried "Connect" click; the alternative is a replay window
 * measured in days.
 *
 **/

export interface PendingFlow {
  name: string
  issuer: string
  resource: string
  metadata: AuthorizationServerMetadata
  verifier: string
  startedAt: number
}

/** Long enough for a consent screen with a password manager and a second
 *  factor; far short of a window worth attacking. */
const FLOW_TTL_MS = 10 * 60_000

const pending = new Map<string, PendingFlow>()

export function beginFlow(state: string, flow: Omit<PendingFlow, 'startedAt'>): void {
  pending.set(state, { ...flow, startedAt: Date.now() })
}

/**
 *
 * Claim a flow by its state, ONCE. Removing it on read is what makes an
 * authorization code single-use from this side too: a callback replayed with
 * the same state finds nothing, which is the behaviour the CSRF protection
 * exists for.
 *
 **/
export function claimFlow(state: string): PendingFlow | null {
  const flow = pending.get(state)
  if (!flow) return null
  pending.delete(state)
  if (Date.now() - flow.startedAt > FLOW_TTL_MS) return null
  return flow
}

/** The machine's own origin, taken from the request the person's browser is
 *  making — not from configuration, which is how a redirect URI ends up
 *  pointing at the wrong host on a machine reached through an ingress. */
export function redirectUri(event: { node: { req: { headers: Record<string, unknown> } } }): string {
  const headers = event.node.req.headers
  const forwardedProto = String(headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? 'localhost')
  const proto = forwardedProto || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}/mcp/oauth/callback`
}
