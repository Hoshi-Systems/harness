import { needsRefresh, refreshTokens, revokeToken, type AuthorizationServerMetadata, type TokenSet } from './oauth.js'
import {
  authorizedConnectors,
  connectorAuth,
  forgetAuth,
  markNeedsAuth,
  readTokens,
  registrationFor,
  saveTokens,
  type ConnectorAuth,
} from './oauth-store.js'
import { publishMachineEvent } from '../../kernel/index.js'

/**
 * ── Turning an authorization into a working connector ────────────────────────
 *
 * The join between the protocol and the thing that dials the server. An OAuth
 * access token IS an `Authorization` header, and `HttpMCPServer` already carries
 * headers — so nothing in `@openharness/core` had to change and no third
 * transport had to be invented. What was missing was somewhere to keep a token
 * and someone to refresh it.
 *
 * Headers-auth and stdio connectors are untouched by all of this: a connector
 * with no authorization record gets exactly the config it always got.
 *
 **/

/** Refreshed a minute before expiry so a tool call never races a token it could
 *  have renewed. */
const SKEW_MS = 60_000

async function currentAccessToken(name: string, auth: ConnectorAuth): Promise<string | null> {
  const { access, refresh } = await readTokens(name)
  if (!access) return null
  if (
    !needsRefresh(
      { accessToken: access, refreshToken: refresh, expiresAt: auth.expiresAt, tokenType: 'Bearer' },
      SKEW_MS,
    )
  ) {
    return access
  }
  if (!refresh) {
    /**
     *
     * Expired with nothing to renew it. Marked rather than retried: there is no
     * request that can fix this, only a person re-authorizing.
     *
     **/
    await markNeedsAuth(name)
    publishMachineEvent('mcp.changed', { name, auth: 'needs-auth' })
    return null
  }
  return await renew(name, auth, refresh)
}

async function renew(name: string, auth: ConnectorAuth, refresh: string): Promise<string | null> {
  const registration = await registrationFor(auth.issuer)
  if (!registration) {
    await markNeedsAuth(name)
    publishMachineEvent('mcp.changed', { name, auth: 'needs-auth' })
    return null
  }
  try {
    const tokens = await refreshTokens({
      metadata: auth.metadata,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      refreshToken: refresh,
      resource: auth.resource,
    })
    await saveTokens(name, auth, tokens)
    publishMachineEvent('mcp.changed', { name, auth: 'authenticated' })
    return tokens.accessToken
  } catch {
    /**
     *
     * NOT retried forever. A refresh token that the authorization server has
     * stopped accepting will not start again, and a machine quietly hammering
     * somebody's identity provider every few minutes is how an integration gets
     * an account suspended. Marked, published, and left for the person.
     *
     **/
    await markNeedsAuth(name)
    publishMachineEvent('mcp.changed', { name, auth: 'needs-auth' })
    return null
  }
}

/**
 *
 * The header this connector should be dialled with, or null when it has no
 * OAuth authorization (headers-auth and stdio connectors, and any connector
 * whose authorization has lapsed).
 *
 **/
export async function authorizationHeader(name: string): Promise<Record<string, string> | null> {
  const auth = await connectorAuth(name)
  if (!auth) return null
  const token = await currentAccessToken(name, auth)
  return token ? { Authorization: `Bearer ${token}` } : null
}

/**
 *
 * Walk every authorized connector and renew what is close to expiring. Runs on
 * the machine's own timer — the no-polling rule is about the client↔machine
 * wire, and a client is never told to tick this.
 *
 **/
export async function refreshExpiringTokens(): Promise<void> {
  for (const { name, auth } of await authorizedConnectors()) {
    if (auth.needsAuth) continue
    const { access, refresh } = await readTokens(name)
    if (!access || !refresh) continue
    if (
      !needsRefresh(
        { accessToken: access, refreshToken: refresh, expiresAt: auth.expiresAt, tokenType: 'Bearer' },
        SKEW_MS,
      )
    ) {
      continue
    }
    await renew(name, auth, refresh)
  }
}

/** Disconnect: revoke where the server supports it, and always forget locally. */
export async function disconnectAuth(name: string): Promise<void> {
  const auth = await connectorAuth(name)
  if (!auth) return
  const registration = await registrationFor(auth.issuer)
  const { access } = await readTokens(name)
  if (registration && access) await revokeToken(auth.metadata, registration.clientId, access)
  await forgetAuth(name)
  publishMachineEvent('mcp.changed', { name, auth: null })
}

export type { AuthorizationServerMetadata, TokenSet }
