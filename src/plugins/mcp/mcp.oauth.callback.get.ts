import { defineEventHandler, getQuery, setResponseHeader } from 'h3'
import { requireAuth, publishMachineEvent } from '../../kernel/index.js'
import { exchangeCode, OAuthError } from './oauth.js'
import { registrationFor, saveTokens } from './oauth-store.js'
import { claimFlow, redirectUri } from './oauth-flow.js'
import { reconnectServer } from './servers.js'

/**
 *
 * Where the identity provider sends the person back.
 *
 * THREE THINGS GUARD THIS ROUTE, and each closes a different door. It requires
 * the machine's own session, so a stranger who guesses the URL is refused before
 * anything is read — the callback is on the machine's origin, which is
 * authenticated, rather than on some public endpoint. The `state` must match a
 * flow this machine started, which is the CSRF binding. And claiming a flow
 * REMOVES it, so a callback replayed with the same state finds nothing.
 *
 * It answers HTML rather than JSON, because the thing reading it is a browser
 * tab the person is looking at, and "{"ok":true}" is not an answer to somebody
 * who just clicked Allow.
 *
 **/

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0b0c;color:#e7e7e8">
<div style="max-width:28rem;padding:2rem;text-align:center">
<h1 style="font-size:1.1rem;font-weight:600;margin:0 0 .5rem">${title}</h1>
<p style="margin:0;color:#9c9ca0">${detail}</p>
</div></body>`
}

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')

  const query = getQuery(event)
  const state = typeof query.state === 'string' ? query.state : ''
  const code = typeof query.code === 'string' ? query.code : ''

  if (typeof query.error === 'string') {
    return page('Not connected', `The provider refused: ${query.error}. You can close this tab and try again.`)
  }

  const flow = state ? claimFlow(state) : null
  if (!flow || !code) {
    /**
     *
     * Deliberately the same answer for a missing state, an unknown one, an
     * expired one and a replayed one. Telling them apart would tell somebody
     * probing this route which of their guesses was closer.
     *
     **/
    return page('That link has expired', 'Start the connection again from Customize → Connectors.')
  }

  const registration = await registrationFor(flow.issuer)
  if (!registration) return page('Not connected', 'This machine is no longer registered with that provider.')

  try {
    const tokens = await exchangeCode({
      metadata: flow.metadata,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      redirectUri: redirectUri(event.node.req.headers as Record<string, string | string[] | undefined>),
      code,
      verifier: flow.verifier,
      resource: flow.resource,
    })
    await saveTokens(
      flow.name,
      { issuer: flow.issuer, resource: flow.resource, metadata: flow.metadata, expiresAt: null, needsAuth: false },
      tokens,
    )
    publishMachineEvent('mcp.changed', { name: flow.name, auth: 'authenticated' })
    /** Dial it now, so the tools appear without the person going back and
     *  pressing anything. */
    void reconnectServer(flow.name).catch(() => undefined)
    return page('Connected', `${flow.name} is authorized. You can close this tab.`)
  } catch (error) {
    const detail = error instanceof OAuthError ? error.message : 'The provider did not complete the exchange.'
    return page('Not connected', detail)
  }
})
