import { defineEventHandler, getRouterParam } from 'h3'
import { randomBytes } from 'node:crypto'
import { apiError, requireAuth } from '../../kernel/index.js'
import { listServers } from './servers.js'
import type { McpDcrAuthorizationRequest } from '../../mcp-connectors.js'
import {
  authorizationUrl,
  createPkce,
  discoverAuthorizationServer,
  discoverProtectedResource,
  OAuthError,
  registerClient,
} from './oauth.js'
import { registrationFor, rememberRegistration } from './oauth-store.js'
import { beginFlow, redirectUri } from './oauth-flow.js'

/**
 *
 * Start an OAuth authorization for one connector: discover, register this
 * machine if it has never registered with that authorization server, and hand
 * back the URL for the person's browser.
 *
 * The machine does the discovering rather than the client, and that is not an
 * implementation detail: the tokens are per-machine data-plane state, and a
 * client that fetched them would put a credential through a surface that has no
 * business holding one.
 *
 **/
export async function beginDcrAuthorization(input: McpDcrAuthorizationRequest): Promise<{ url: string }> {
  const server = (await listServers()).find((entry) => entry.name === input.name)
  if (!server) throw new McpAuthorizationError('notFound', 'No connector by that name.')
  const config = server.config
  if (config.type === 'stdio') {
    throw new McpAuthorizationError('local', 'A local connector runs as a command and has nothing to authorize.')
  }

  try {
    const resource = await discoverProtectedResource(config.url)
    const issuer = resource.authorizationServers[0]!
    const metadata = await discoverAuthorizationServer(issuer)

    /**
     *
     * Registered once per authorization server, then reused. Several MCP
     * servers behind one identity provider should mean one consent screen, and
     * re-registering per connector is how a machine ends up with a dozen
     * identical clients on somebody's account.
     *
     **/
    let registration = await registrationFor(metadata.issuer)
    if (!registration) {
      registration = await registerClient(metadata, redirectUri(input.request.headers), 'Hoshi machine')
      await rememberRegistration(metadata.issuer, registration)
    }

    const pkce = createPkce()
    const state = randomBytes(24).toString('base64url')
    beginFlow(state, {
      name: input.name,
      issuer: metadata.issuer,
      resource: resource.resource,
      metadata,
      verifier: pkce.verifier,
    })

    const scopes = input.scopes?.filter((scope) => typeof scope === 'string' && scope.trim()).join(' ')
    return {
      url: authorizationUrl({
        metadata,
        clientId: registration.clientId,
        redirectUri: redirectUri(input.request.headers),
        state,
        challenge: pkce.challenge,
        resource: resource.resource,
        ...(scopes ? { scope: scopes } : {}),
      }),
    }
  } catch (error) {
    if (error instanceof OAuthError) throw new McpAuthorizationError('failed', error.message)
    throw error
  }
}

export class McpAuthorizationError extends Error {
  constructor(
    readonly kind: 'notFound' | 'local' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  try {
    return await beginDcrAuthorization({
      name: getRouterParam(event, 'name')!,
      request: { headers: event.node.req.headers as Record<string, string | string[] | undefined> },
    })
  } catch (error) {
    if (error instanceof McpAuthorizationError) {
      const status = error.kind === 'notFound' ? 404 : 400
      const code = error.kind === 'notFound' ? 'mcp.notFound' : error.kind === 'local' ? 'mcp.oauthLocal' : 'mcp.oauthFailed'
      apiError(status, code, error.message)
    }
    throw error
  }
})
