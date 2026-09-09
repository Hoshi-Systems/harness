/**
 * ── GitHub Copilot: a GitHub token is not a Copilot token ────────────────────
 *
 * The open catalogue lists `github-copilot` as an OpenAI-compatible provider at
 * `api.githubcopilot.com` reading `GITHUB_TOKEN`, and that description is true
 * of the wire and false of the credential. The endpoint refuses a GitHub
 * token — a device-flow login's `gho_…` or a personal access token alike — and
 * accepts only a short-lived Copilot token minted FROM one, plus the headers an
 * editor integration sends. Every third-party Copilot client (VS Code itself,
 * OpenCode, copilot-api) does this exchange; a machine that sent the GitHub
 * token straight through was a provider that connected, listed 33 models, and
 * failed every turn with a 401 nothing upstream could explain.
 *
 * So this module is the one place that knows the difference. `copilotFetch`
 * wraps the request the SDK builds: it mints or reuses the Copilot token, swaps
 * the bearer, adds the editor headers, and re-points the request at the API
 * host the token names — an individual, business or enterprise subscription
 * each has its own — because the catalogue's address is only the individual
 * one.
 *
 * The GitHub side is overridable for the wire-level census, which stands in
 * for github.com the way it stands in for the model catalogue.
 *
 **/

export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot'

export type ProviderLoginKind = 'github'

/** Which providers can be connected by signing in to an account, and how
 *  (kernel/provider-login.ts runs the flow). Null is the ordinary case: a key,
 *  or nothing. Here rather than beside the flow because the provider listing
 *  reads it, and the flow reaches back into the listing's world to announce
 *  its outcome. */
export function providerLogin(providerId: string): ProviderLoginKind | null {
  return providerId === GITHUB_COPILOT_PROVIDER_ID ? 'github' : null
}

const githubApiUrl = (): string => (process.env.HOSHI_GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')

/** What the exchange presents itself as. GitHub keys Copilot access on the
 *  editor integration making the request, so the version pair is load-bearing
 *  and pinned to one GitHub is known to serve. */
const EDITOR_VERSION = 'vscode/1.99.3'
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.7'
const USER_AGENT = 'GitHubCopilotChat/0.26.7'
const GITHUB_API_VERSION = '2025-04-01'

/** The headers GitHub's own API is asked with. Shared by the token exchange
 *  here; the device flow itself speaks to github.com, not the API. */
function githubHeaders(githubToken: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `token ${githubToken}`,
    'editor-version': EDITOR_VERSION,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'x-github-api-version': GITHUB_API_VERSION,
  }
}

export class CopilotTokenError extends Error {}

interface CopilotToken {
  token: string
  /** Unix milliseconds. */
  expiresAt: number
  /** The API host this subscription is served from, when GitHub named one. */
  apiBase: string | null
}

/** Minted tokens, keyed by the GitHub token they came from. Process memory on
 *  purpose: a Copilot token lives about half an hour, and the GitHub token it
 *  is minted from is the durable credential (the vault's `GITHUB_TOKEN`). */
const tokens = new Map<string, CopilotToken>()

/** Re-mint this far ahead of expiry, so a request never goes out with a token
 *  that dies mid-stream. */
const RENEW_MARGIN_MS = 60_000

export function clearCopilotTokens(): void {
  tokens.clear()
}

/** A usable Copilot token for this GitHub token — cached until shortly before
 *  it expires, minted otherwise. Throws when GitHub will not issue one, which
 *  is the honest answer for an account with no Copilot subscription. */
export async function copilotToken(githubToken: string): Promise<CopilotToken> {
  const cached = tokens.get(githubToken)
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) return cached

  const res = await fetch(`${githubApiUrl()}/copilot_internal/v2/token`, {
    headers: githubHeaders(githubToken),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new CopilotTokenError(
      res.status === 401 || res.status === 403
        ? `GitHub did not issue a Copilot token (${res.status}). Sign in to GitHub Copilot again, and check that the account has a Copilot subscription.`
        : `GitHub did not issue a Copilot token (${res.status}).`,
    )
  }
  const body = (await res.json()) as { token?: unknown; expires_at?: unknown; endpoints?: { api?: unknown } }
  if (typeof body.token !== 'string' || !body.token) {
    throw new CopilotTokenError('GitHub answered the Copilot token request without a token.')
  }
  const minted: CopilotToken = {
    token: body.token,
    /**
     *
     * `expires_at` is unix seconds. A missing one is treated as a short life
     * rather than a long one: re-minting a token that was still good costs a
     * request, and keeping one that was not costs a turn.
     *
     **/
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at * 1000 : Date.now() + 5 * 60_000,
    apiBase:
      typeof body.endpoints?.api === 'string' && body.endpoints.api ? body.endpoints.api.replace(/\/+$/, '') : null,
  }
  tokens.set(githubToken, minted)
  return minted
}

interface ChatMessage {
  role?: unknown
  content?: unknown
}

/** What the request says about itself, read off its body: whether the turn is
 *  the person's own message or the agent continuing after a tool, and whether
 *  it carries a picture. Both are headers Copilot expects, and the second one
 *  gates image input outright. */
function requestTraits(body: unknown): { initiator: 'user' | 'agent'; vision: boolean } {
  if (typeof body !== 'string') return { initiator: 'user', vision: false }
  let parsed: { messages?: unknown }
  try {
    parsed = JSON.parse(body) as { messages?: unknown }
  } catch {
    return { initiator: 'user', vision: false }
  }
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : []
  return {
    initiator: messages.some((message) => message.role === 'assistant' || message.role === 'tool') ? 'agent' : 'user',
    vision: messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => (part as { type?: unknown })?.type === 'image_url'),
    ),
  }
}

/** The fetch a Copilot model is built with.
 *
 *  `baseUrl` is what the SDK was given and will prefix every request with;
 *  `inner` is the fetch that actually sends — the reasoning hook when a person
 *  chose an effort, the global one otherwise — so the two wrappers compose
 *  rather than one silently replacing the other. */
export function copilotFetch(
  githubToken: string,
  baseUrl: string,
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const prefix = baseUrl.replace(/\/+$/, '')
  return async (input, init) => {
    const { token, apiBase } = await copilotToken(githubToken)
    const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = apiBase && original.startsWith(prefix) ? `${apiBase}${original.slice(prefix.length)}` : original

    const { initiator, vision } = requestTraits(init?.body)
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.set('copilot-integration-id', 'vscode-chat')
    headers.set('editor-version', EDITOR_VERSION)
    headers.set('editor-plugin-version', EDITOR_PLUGIN_VERSION)
    headers.set('user-agent', USER_AGENT)
    headers.set('openai-intent', 'conversation-panel')
    headers.set('x-github-api-version', GITHUB_API_VERSION)
    headers.set('x-initiator', initiator)
    if (vision) headers.set('copilot-vision-request', 'true')
    return inner(url, { ...init, headers })
  }
}
