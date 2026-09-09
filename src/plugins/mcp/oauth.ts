import { createHash, randomBytes } from 'node:crypto'

/**
 * ── MCP authorization: discovery, registration, PKCE ─────────────────────────
 *
 * The 2026 MCP specification mandates OAuth 2.1 for remote servers, with
 * Protected Resource Metadata, Dynamic Client Registration and Resource
 * Indicators. Before this, a Hoshi machine could reach a remote MCP server only
 * with static headers — which excluded most of the ecosystem, and capped exactly
 * the presets whose whole value is connectors.
 *
 * DYNAMIC CLIENT REGISTRATION IS THE PART THAT MATTERS. Without it, connecting a
 * machine to a remote server means a person registering an OAuth client by hand,
 * per server, per machine. Nobody does that, so "supports OAuth" without DCR is
 * the same as not supporting it.
 *
 * This module is deliberately pure protocol: it builds URLs, parses metadata and
 * exchanges codes, and it takes `fetch` as an argument. Nothing here reads the
 * vault, writes config or knows what a machine is — which is what lets the whole
 * flow be tested against a local authorization server rather than only against
 * somebody's production one.
 *
 **/

export interface ProtectedResourceMetadata {
  /** The authorization servers this resource accepts tokens from. */
  authorizationServers: string[]
  /** The canonical resource identifier to send as the `resource` indicator. */
  resource: string
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  /** Advertised PKCE methods. S256 is required by OAuth 2.1; a server that
   *  advertises only `plain` is one we refuse rather than downgrade for. */
  codeChallengeMethods: string[]
}

export interface ClientRegistration {
  clientId: string
  clientSecret: string | null
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  /** Absolute ISO expiry, or null when the server did not say. */
  expiresAt: string | null
  tokenType: string
}

export class OAuthError extends Error {}

type Fetch = typeof fetch

/** RFC 9728 well-known path, derived from the resource URL rather than guessed:
 *  the path component is preserved after the well-known segment, which is what
 *  lets one host serve several protected resources. */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl)
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}/.well-known/oauth-protected-resource${path}`
}

/** RFC 8414, with the same path-preserving rule. A server that serves neither
 *  is not one we can talk to, and the caller says so plainly. */
function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/, '')
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ]
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new OAuthError(`${what} responded ${response.status}`)
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new OAuthError(`${what} did not return JSON`)
  }
}

export async function discoverProtectedResource(
  resourceUrl: string,
  doFetch: Fetch = fetch,
): Promise<ProtectedResourceMetadata> {
  const body = await readJson(
    await doFetch(protectedResourceMetadataUrl(resourceUrl), { headers: { accept: 'application/json' } }),
    'The protected-resource metadata endpoint',
  )
  const servers = Array.isArray(body.authorization_servers)
    ? body.authorization_servers.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (servers.length === 0) throw new OAuthError('That server advertises no authorization server.')
  return {
    authorizationServers: servers,
    resource: typeof body.resource === 'string' ? body.resource : resourceUrl,
  }
}

export async function discoverAuthorizationServer(
  issuer: string,
  doFetch: Fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  let last: unknown
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    try {
      const body = await readJson(
        await doFetch(candidate, { headers: { accept: 'application/json' } }),
        'The authorization-server metadata endpoint',
      )
      const authorizationEndpoint = body.authorization_endpoint
      const tokenEndpoint = body.token_endpoint
      if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
        throw new OAuthError('The authorization server metadata is missing its endpoints.')
      }
      return {
        issuer: typeof body.issuer === 'string' ? body.issuer : issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: typeof body.registration_endpoint === 'string' ? body.registration_endpoint : null,
        revocationEndpoint: typeof body.revocation_endpoint === 'string' ? body.revocation_endpoint : null,
        codeChallengeMethods: Array.isArray(body.code_challenge_methods_supported)
          ? body.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string')
          : [],
      }
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new OAuthError('No authorization server metadata found.')
}

/**
 *
 * Register this machine as a client, once per authorization server.
 *
 * Keyed on the AS rather than on the server URL, so several MCP servers behind
 * one authorization server reuse a single registration — which is both what the
 * spec intends and the difference between one consent screen and five.
 *
 **/
export async function registerClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  clientName: string,
  doFetch: Fetch = fetch,
): Promise<ClientRegistration> {
  if (!metadata.registrationEndpoint) {
    throw new OAuthError(
      'That authorization server does not support dynamic client registration, so this machine cannot register itself with it.',
    )
  }
  const body = await readJson(
    await doFetch(metadata.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }),
    'Dynamic client registration',
  )
  if (typeof body.client_id !== 'string') throw new OAuthError('Registration returned no client id.')
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null,
  }
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** RFC 7636 S256. `plain` is never produced: OAuth 2.1 requires S256, and a
 *  downgrade here would be invisible at exactly the moment it mattered. */
export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function authorizationUrl(input: {
  metadata: AuthorizationServerMetadata
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  resource: string
  scope?: string | null
}): string {
  if (input.metadata.codeChallengeMethods.length > 0 && !input.metadata.codeChallengeMethods.includes('S256')) {
    throw new OAuthError('That authorization server does not support S256 PKCE, which OAuth 2.1 requires.')
  }
  const url = new URL(input.metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  /**
   *
   * The resource indicator (RFC 8707) is what stops a token minted for one MCP
   * server being replayed against another behind the same authorization server.
   * Omitting it is the kind of shortcut that works everywhere until it is a
   * vulnerability.
   *
   **/
  url.searchParams.set('resource', input.resource)
  if (input.scope) url.searchParams.set('scope', input.scope)
  return url.toString()
}

function readTokens(body: Record<string, unknown>, previousRefresh: string | null = null): TokenSet {
  if (typeof body.access_token !== 'string') throw new OAuthError('The token endpoint returned no access token.')
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null
  return {
    accessToken: body.access_token,
    /**
     *
     * A refresh response is allowed to omit the refresh token, and it means
     * "keep the one you have" rather than "you no longer have one". Dropping it
     * would turn every second refresh into a re-authorization.
     *
     **/
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previousRefresh,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1_000).toISOString(),
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
  }
}

export async function exchangeCode(
  input: {
    metadata: AuthorizationServerMetadata
    clientId: string
    clientSecret: string | null
    redirectUri: string
    code: string
    verifier: string
    resource: string
  },
  doFetch: Fetch = fetch,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
    resource: input.resource,
  })
  if (input.clientSecret) form.set('client_secret', input.clientSecret)
  return readTokens(
    await readJson(
      await doFetch(input.metadata.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      }),
      'The token endpoint',
    ),
  )
}

export async function refreshTokens(
  input: {
    metadata: AuthorizationServerMetadata
    clientId: string
    clientSecret: string | null
    refreshToken: string
    resource: string
  },
  doFetch: Fetch = fetch,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
  })
  if (input.clientSecret) form.set('client_secret', input.clientSecret)
  return readTokens(
    await readJson(
      await doFetch(input.metadata.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      }),
      'The token endpoint',
    ),
    input.refreshToken,
  )
}

/** Best-effort: an authorization server with no revocation endpoint, or one that
 *  refuses, must not stop the local disconnect. Losing our own copy is the part
 *  the user asked for. */
export async function revokeToken(
  metadata: AuthorizationServerMetadata,
  clientId: string,
  token: string,
  doFetch: Fetch = fetch,
): Promise<boolean> {
  if (!metadata.revocationEndpoint) return false
  try {
    const response = await doFetch(metadata.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId }).toString(),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Refresh a little before the token actually dies, so a tool call never races
 *  the expiry it could have avoided. */
export function needsRefresh(tokens: TokenSet, skewMs = 60_000, now = Date.now()): boolean {
  if (!tokens.expiresAt) return false
  const at = Date.parse(tokens.expiresAt)
  return Number.isFinite(at) && at - skewMs <= now
}
