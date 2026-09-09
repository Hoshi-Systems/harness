import { defineEventHandler, getRouterParam } from 'h3'
import { randomBytes } from 'node:crypto'
import { apiError, requireAuth } from '../../kernel/index.js'
import { listServers } from './servers.js'
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
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const name = getRouterParam(event, 'name')!
  const server = (await listServers()).find((entry) => entry.name === name)
  if (!server) apiError(404, 'mcp.notFound', 'No connector by that name.')
  const config = server.config
  if (config.type === 'stdio') {
    apiError(400, 'mcp.oauthLocal', 'A local connector runs as a command and has nothing to authorize.')
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
      registration = await registerClient(metadata, redirectUri(event), 'Hoshi machine')
      await rememberRegistration(metadata.issuer, registration)
    }

    const pkce = createPkce()
    const state = randomBytes(24).toString('base64url')
    beginFlow(state, {
      name,
      issuer: metadata.issuer,
      resource: resource.resource,
      metadata,
      verifier: pkce.verifier,
    })

    return {
      url: authorizationUrl({
        metadata,
        clientId: registration.clientId,
        redirectUri: redirectUri(event),
        state,
        challenge: pkce.challenge,
        resource: resource.resource,
      }),
    }
  } catch (error) {
    if (error instanceof OAuthError) apiError(400, 'mcp.oauthFailed', error.message)
    throw error
  }
})
