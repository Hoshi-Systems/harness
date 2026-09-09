import { publishMachineEvent } from './events.js'
import { publishProvidersChanged } from './machine-state.js'
import { setSecret } from './secrets.js'

/**
 * ── Connecting a provider by signing in ──────────────────────────────────────
 *
 * Most providers take a key. A subscription does not have one: what a person
 * pays GitHub for is an ACCOUNT, and the only way to use it from a machine is
 * to sign that account in. This is the device flow — the machine asks GitHub
 * for a short code, the person types it at github.com/login/device from any
 * browser, and the machine, polling on their behalf, receives the token the
 * moment they approve. It lands in the vault under the provider's own env var
 * (`GITHUB_TOKEN`), so from then on it is a credential like any other and the
 * key route could have put it there.
 *
 * The MACHINE polls, not the client. A browser tab that polled would have to
 * stay open and would stop the moment it navigated; the machine keeps asking
 * for as long as the code is valid (fifteen minutes) and announces the outcome
 * on its event bus, which is the rule for anything a client watches live. A
 * client that started a login and closed the dialog still gets the provider.
 *
 * Only GitHub today. The old runtime offered seven such flows and the machine
 * proxied every one of them; when the runtime went, so did they, and this is
 * the first one rebuilt — as a machine capability rather than a proxy.
 *
 **/

const githubUrl = (): string => (process.env.HOSHI_GITHUB_URL ?? 'https://github.com').replace(/\/+$/, '')

/** The OAuth app the device flow is run as. GitHub registers no public app for
 *  Copilot access: this is the id of the Copilot editor integration, which is
 *  what every third-party Copilot client presents and the one GitHub issues
 *  Copilot tokens to. Overridable for an installation that has its own. */
const clientId = (): string => process.env.HOSHI_GITHUB_COPILOT_CLIENT_ID ?? 'Iv1.b507a08c87ecfe98'
const SCOPE = 'read:user'

export type ProviderLoginStatus = 'pending' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'failed'

export interface ProviderLoginStart {
  /** What the person types at `url`. */
  code: string
  url: string
  /** ISO time after which the code no longer works. */
  expiresAt: string
}

export class ProviderLoginError extends Error {}

interface PendingLogin {
  providerId: string
  keyEnvVar: string
  deviceCode: string
  expiresAt: number
  intervalMs: number
  timer: ReturnType<typeof setTimeout> | null
  cancelled: boolean
}

const pending = new Map<string, PendingLogin>()

function announce(providerId: string, status: ProviderLoginStatus, message?: string): void {
  publishMachineEvent('provider.login', { providerId, status, ...(message ? { message } : {}) })
}

/** Begin a sign-in for a provider. Answers with what the person needs — the
 *  code and where to type it — and keeps polling GitHub in the background until
 *  they approve, refuse, or the code expires. A second start for the same
 *  provider replaces the first: one code per provider at a time. */
export async function startProviderLogin(providerId: string, keyEnvVar: string): Promise<ProviderLoginStart> {
  cancelProviderLogin(providerId)

  const res = await fetch(`${githubUrl()}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId(), scope: SCOPE }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw new ProviderLoginError(
      `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (!res.ok) throw new ProviderLoginError(`GitHub refused to start a sign-in (${res.status}).`)
  const body = (await res.json()) as {
    device_code?: unknown
    user_code?: unknown
    verification_uri?: unknown
    expires_in?: unknown
    interval?: unknown
  }
  if (
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string'
  ) {
    throw new ProviderLoginError('GitHub answered the sign-in request without a code.')
  }

  const expiresAt = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 900) * 1000
  const login: PendingLogin = {
    providerId,
    keyEnvVar,
    deviceCode: body.device_code,
    expiresAt,
    /**
     *
     * GitHub names the minimum, and asks for `slow_down` when it is not
     * honoured; a second on top keeps a clock skew from reading as impatience.
     *
     **/
    intervalMs: ((typeof body.interval === 'number' ? body.interval : 5) + 1) * 1000,
    timer: null,
    cancelled: false,
  }
  pending.set(providerId, login)
  schedule(login)
  announce(providerId, 'pending')
  return { code: body.user_code, url: body.verification_uri, expiresAt: new Date(expiresAt).toISOString() }
}

/** Stop polling for a provider. Returns whether anything was pending. */
export function cancelProviderLogin(providerId: string): boolean {
  const login = pending.get(providerId)
  if (!login) return false
  login.cancelled = true
  if (login.timer) clearTimeout(login.timer)
  pending.delete(providerId)
  announce(providerId, 'cancelled')
  return true
}

/** Whether a sign-in is currently waiting on the person. */
export function providerLoginPending(providerId: string): boolean {
  return pending.has(providerId)
}

function schedule(login: PendingLogin): void {
  login.timer = setTimeout(() => {
    login.timer = null
    void poll(login)
  }, login.intervalMs)
  /**
   *
   * The poll must never be what keeps the process alive: a daemon asked to
   * stop mid-login stops, and the person signs in again.
   *
   **/
  login.timer.unref?.()
}

function finish(
  login: PendingLogin,
  status: Exclude<ProviderLoginStatus, 'pending' | 'cancelled'>,
  message?: string,
): void {
  if (pending.get(login.providerId) === login) pending.delete(login.providerId)
  announce(login.providerId, status, message)
}

async function poll(login: PendingLogin): Promise<void> {
  if (login.cancelled) return
  if (Date.now() > login.expiresAt) {
    finish(login, 'expired', 'The code expired before it was used.')
    return
  }

  let body: { access_token?: unknown; error?: unknown; error_description?: unknown }
  try {
    const res = await fetch(`${githubUrl()}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId(),
        device_code: login.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    body = (await res.json()) as typeof body
  } catch {
    /**
     *
     * A network blip is not an answer. The code is still valid, so ask again
     * next interval; the expiry above bounds how long this can go on.
     *
     **/
    if (!login.cancelled) schedule(login)
    return
  }
  if (login.cancelled) return

  if (typeof body.access_token === 'string' && body.access_token) {
    try {
      await setSecret(login.keyEnvVar, body.access_token)
    } catch (error) {
      finish(login, 'failed', error instanceof Error ? error.message : 'The token could not be stored.')
      return
    }
    finish(login, 'connected')
    await publishProvidersChanged(login.providerId)
    return
  }

  switch (body.error) {
    case 'authorization_pending':
      schedule(login)
      return
    case 'slow_down':
      login.intervalMs += 5_000
      schedule(login)
      return
    case 'expired_token':
      finish(login, 'expired', 'The code expired before it was used.')
      return
    case 'access_denied':
      finish(login, 'denied', 'The sign-in was refused on GitHub.')
      return
    default:
      finish(
        login,
        'failed',
        typeof body.error_description === 'string'
          ? body.error_description
          : `GitHub answered with "${String(body.error)}".`,
      )
  }
}
