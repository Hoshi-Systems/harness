import { createCachedStore } from '../../kernel/index.js'
import { deleteSecret, readSecretValue, setSecret } from '../../kernel/secrets.js'
import type { AuthorizationServerMetadata, ClientRegistration, TokenSet } from './oauth.js'

/**
 * ── Where an MCP connector's authorization lives ─────────────────────────────
 *
 * Two stores with two different reasons to exist.
 *
 * The BOOKKEEPING — which authorization server a connector uses, which client id
 * this machine registered there, when the token expires — is ordinary state in
 * `mcp-oauth.json`. None of it is secret and all of it is needed to decide what
 * to show and when to refresh.
 *
 * The TOKENS are in the machine's own vault, encrypted at rest, and reached only
 * by key. They never enter `mcp.json`, never appear in an API response, and the
 * status a client sees is a word — `authenticated`, `needs-auth`, `expired` —
 * rather than anything derived from the token itself. That split is the whole
 * reason this file is not simply part of the store next door: a config read must
 * not be able to surface a credential, and the only way to be sure of that is
 * for the credential not to be in the config.
 *
 * The registration is keyed on the AUTHORIZATION SERVER, not the connector: the
 * spec intends one registration per AS, and several MCP servers behind one
 * identity provider should mean one consent screen rather than five.
 *
 **/

export type AuthStatus = 'authenticated' | 'needs-auth' | 'expired'

interface OAuthState {
  /** issuer -> the client this machine registered there. */
  registrations: Record<string, ClientRegistration>
  /** connector name -> everything but the tokens. */
  connectors: Record<string, ConnectorAuth>
}

export interface ConnectorAuth {
  issuer: string
  /** The canonical resource identifier, as the protected-resource metadata gave
   *  it — sent on every token request so a token minted for this server cannot
   *  be replayed against another behind the same authorization server. */
  resource: string
  metadata: AuthorizationServerMetadata
  expiresAt: string | null
  /** Set when a refresh failed. The connector keeps its definition and its
   *  place in the list — it is asking to be re-authorized, not to be deleted. */
  needsAuth: boolean
}

const store = createCachedStore<OAuthState>('mcp-oauth.json', (stored) => {
  const state = (stored ?? {}) as Partial<OAuthState>
  return {
    registrations: state.registrations ?? {},
    connectors: state.connectors ?? {},
  }
})

/** Vault keys. Uppercase because that is what the vault accepts, and prefixed so
 *  a person reading Customize → Secrets can see what they belong to. */
function tokenKey(connector: string, kind: 'ACCESS' | 'REFRESH'): string {
  return `MCP_OAUTH_${connector.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_${kind}`
}

export async function registrationFor(issuer: string): Promise<ClientRegistration | null> {
  return (await store.load()).registrations[issuer] ?? null
}

export async function rememberRegistration(issuer: string, registration: ClientRegistration): Promise<void> {
  const state = await store.load()
  state.registrations[issuer] = registration
  store.persist()
}

export async function connectorAuth(name: string): Promise<ConnectorAuth | null> {
  return (await store.load()).connectors[name] ?? null
}

export async function saveTokens(name: string, auth: ConnectorAuth, tokens: TokenSet): Promise<void> {
  await setSecret(tokenKey(name, 'ACCESS'), tokens.accessToken)
  if (tokens.refreshToken) await setSecret(tokenKey(name, 'REFRESH'), tokens.refreshToken)
  const state = await store.load()
  state.connectors[name] = { ...auth, expiresAt: tokens.expiresAt, needsAuth: false }
  store.persist()
}

export async function readTokens(name: string): Promise<{ access: string | null; refresh: string | null }> {
  return {
    access: await readSecretValue(tokenKey(name, 'ACCESS')),
    refresh: await readSecretValue(tokenKey(name, 'REFRESH')),
  }
}

/** A refresh that failed. The definition stays; the connector says so. */
export async function markNeedsAuth(name: string): Promise<void> {
  const state = await store.load()
  const existing = state.connectors[name]
  if (!existing) return
  state.connectors[name] = { ...existing, needsAuth: true }
  store.persist()
}

/** Forget everything local about a connector's authorization. Always runs, even
 *  when server-side revocation failed — losing our own copy is the part the
 *  person actually asked for. */
export async function forgetAuth(name: string): Promise<void> {
  await deleteSecret(tokenKey(name, 'ACCESS'))
  await deleteSecret(tokenKey(name, 'REFRESH'))
  const state = await store.load()
  delete state.connectors[name]
  store.persist()
}

/** Every connector this machine holds authorization for — what the refresh tick
 *  walks. */
export async function authorizedConnectors(): Promise<Array<{ name: string; auth: ConnectorAuth }>> {
  const state = await store.load()
  return Object.entries(state.connectors).map(([name, auth]) => ({ name, auth }))
}

export function authStatus(auth: ConnectorAuth | null, now = Date.now()): AuthStatus | null {
  if (!auth) return null
  if (auth.needsAuth) return 'needs-auth'
  if (auth.expiresAt) {
    const at = Date.parse(auth.expiresAt)
    if (Number.isFinite(at) && at <= now) return 'expired'
  }
  return 'authenticated'
}
