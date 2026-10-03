import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import {
  authorizationUrl,
  createPkce,
  discoverAuthorizationServer,
  discoverProtectedResource,
  exchangeCode,
  needsRefresh,
  OAuthError,
  protectedResourceMetadataUrl,
  refreshTokens,
  registerClient,
  revokeToken,
} from './oauth.js'
import { redirectUri } from './oauth-flow.js'

/**
 *
 * A REAL authorization server, small but honest: it serves the two discovery
 * documents, registers a client, checks the PKCE verifier against the challenge
 * it was given, refuses a wrong one, and issues and refreshes tokens over the
 * wire.
 *
 * Not a mocked `fetch`. A mock would assert that this file builds the requests
 * this file expects, which is a tautology — the questions worth answering are
 * whether the URLs are shaped the way RFC 9728 and 8414 say, whether the form
 * encoding is what a token endpoint actually parses, and whether the PKCE proof
 * verifies. Only a server can answer those.
 *
 * What it deliberately does NOT prove: that a real third party behaves this way.
 * That needs a named live server, and is not something a unit suite can hold.
 *
 **/

let server: Server
let origin: string
const issued = { challenge: '', resource: '', clientId: '' }
let revoked: string | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const form = async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      return new URLSearchParams(Buffer.concat(chunks).toString())
    }

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`,
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/register') {
      issued.clientId = 'client-abc'
      return json({ client_id: issued.clientId })
    }
    if (url.pathname === '/token') {
      return void form().then((body) => {
        if (body.get('grant_type') === 'refresh_token') {
          if (body.get('refresh_token') !== 'refresh-1') return json({ error: 'invalid_grant' }, 400)
          /** Deliberately omits refresh_token — the spec allows it, and a client
           *  that forgets the old one re-authorizes every second refresh. */
          return json({ access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' })
        }
        const verifier = body.get('code_verifier') ?? ''
        const proof = createHash('sha256').update(verifier).digest('base64url')
        if (proof !== issued.challenge) return json({ error: 'invalid_grant' }, 400)
        if (body.get('resource') !== issued.resource) return json({ error: 'invalid_target' }, 400)
        return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })
      })
    }
    if (url.pathname === '/revoke') {
      return void form().then((body) => {
        revoked = body.get('token')
        res.writeHead(200).end()
      })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('the well-known paths', () => {
  it('keeps the resource path after the well-known segment, so one host can serve several', () => {
    expect(protectedResourceMetadataUrl('https://x.test/mcp')).toBe(
      'https://x.test/.well-known/oauth-protected-resource/mcp',
    )
    expect(protectedResourceMetadataUrl('https://x.test/')).toBe('https://x.test/.well-known/oauth-protected-resource')
  })

  it('derives the callback from the initiating request headers, not a platform URL', () => {
    expect(redirectUri({ host: 'machine.test' })).toBe('https://machine.test/mcp/oauth/callback')
    expect(redirectUri({ host: 'internal:4200', 'x-forwarded-host': 'machine.test', 'x-forwarded-proto': 'https' })).toBe(
      'https://machine.test/mcp/oauth/callback',
    )
  })
})

describe('a full authorization, against a server', () => {
  it('discovers, registers, authorizes and exchanges', async () => {
    const resource = await discoverProtectedResource(`${origin}/mcp`)
    expect(resource.authorizationServers).toEqual([origin])

    const metadata = await discoverAuthorizationServer(resource.authorizationServers[0]!)
    expect(metadata.registrationEndpoint).toBe(`${origin}/register`)

    const client = await registerClient(metadata, 'https://machine.test/callback', 'Hoshi')
    expect(client.clientId).toBe('client-abc')

    const pkce = createPkce()
    issued.challenge = pkce.challenge
    issued.resource = resource.resource

    const authorize = new URL(
      authorizationUrl({
        metadata,
        clientId: client.clientId,
        redirectUri: 'https://machine.test/callback',
        state: 'state-1',
        challenge: pkce.challenge,
        resource: resource.resource,
      }),
    )
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('resource')).toBe(resource.resource)

    const tokens = await exchangeCode({
      metadata,
      clientId: client.clientId,
      clientSecret: null,
      redirectUri: 'https://machine.test/callback',
      code: 'code-1',
      verifier: pkce.verifier,
      resource: resource.resource,
    })
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
  })

  it('refuses an exchange whose PKCE verifier does not match', async () => {
    const metadata = await discoverAuthorizationServer(origin)
    issued.challenge = createPkce().challenge
    await expect(
      exchangeCode({
        metadata,
        clientId: 'client-abc',
        clientSecret: null,
        redirectUri: 'https://machine.test/callback',
        code: 'code-1',
        verifier: createPkce().verifier,
        resource: `${origin}/mcp`,
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('keeps the old refresh token when a refresh response omits one', async () => {
    const metadata = await discoverAuthorizationServer(origin)
    const refreshed = await refreshTokens({
      metadata,
      clientId: 'client-abc',
      clientSecret: null,
      refreshToken: 'refresh-1',
      resource: `${origin}/mcp`,
    })
    expect(refreshed.accessToken).toBe('access-2')
    expect(refreshed.refreshToken).toBe('refresh-1')
  })

  it('revokes through the server when it offers an endpoint', async () => {
    const metadata = await discoverAuthorizationServer(origin)
    expect(await revokeToken(metadata, 'client-abc', 'access-1')).toBe(true)
    expect(revoked).toBe('access-1')
  })
})

describe('the refusals that keep this safe', () => {
  it('refuses an authorization server that cannot do S256', () => {
    expect(() =>
      authorizationUrl({
        metadata: {
          issuer: 'https://as.test',
          authorizationEndpoint: 'https://as.test/a',
          tokenEndpoint: 'https://as.test/t',
          registrationEndpoint: null,
          revocationEndpoint: null,
          codeChallengeMethods: ['plain'],
        },
        clientId: 'c',
        redirectUri: 'https://m.test/cb',
        state: 's',
        challenge: 'x',
        resource: 'https://as.test/mcp',
      }),
    ).toThrow(OAuthError)
  })

  it('refuses to pretend a server without dynamic registration can be used', async () => {
    await expect(
      registerClient(
        {
          issuer: 'https://as.test',
          authorizationEndpoint: 'https://as.test/a',
          tokenEndpoint: 'https://as.test/t',
          registrationEndpoint: null,
          revocationEndpoint: null,
          codeChallengeMethods: ['S256'],
        },
        'https://m.test/cb',
        'Hoshi',
      ),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('refreshes ahead of expiry, and never for a token with no expiry', () => {
    const base = { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' }
    expect(needsRefresh({ ...base, expiresAt: new Date(Date.now() + 30_000).toISOString() })).toBe(true)
    expect(needsRefresh({ ...base, expiresAt: new Date(Date.now() + 600_000).toISOString() })).toBe(false)
    expect(needsRefresh({ ...base, expiresAt: null })).toBe(false)
  })
})
