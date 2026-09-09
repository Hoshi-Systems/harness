import {
  EDITOR_AUTH_COOKIE,
  HOSHI_TOKEN_HEADER,
  PREVIEW_AUTH_COOKIE,
  SESSION_COOKIE,
  verifySessionJwt,
} from './client-session.js'
import { authorizeRawToken } from './auth.js'

/**
 * ── Authorizing a websocket upgrade ──────────────────────────────────────────
 *
 * The front door for a connection that is not an ordinary request: an upgrade
 * carries no body and cannot be answered with a 401 the way a route can, so it
 * is decided here, once, before any plugin's hooks see it.
 *
 * Kernel rather than a plugin's helper because MORE THAN ONE plugin upgrades
 * sockets — the editor bridge, the preview proxy, voice dictation — and a
 * shared answer copied into each of them is an auth check that drifts.
 *
 **/

/** One cookie out of a raw header — an upgrade has no parsed cookie jar. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

async function authorizeUpgradeWithCookie(headers: Headers, url: URL, surfaceCookie?: string): Promise<boolean> {
  const authHeader = headers.get('authorization')
  const cookieHeader = headers.get('cookie')
  const candidates = [
    authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null,
    headers.get(HOSHI_TOKEN_HEADER),
    url.searchParams.get('hoshi_token'),
    cookieValue(cookieHeader, SESSION_COOKIE),
    surfaceCookie ? cookieValue(cookieHeader, surfaceCookie) : null,
  ]
  for (const candidate of candidates) {
    if (await authorizeRawToken(candidate)) return true
  }
  return false
}

/** Owner credentials only. Whole-machine websocket surfaces must use this. */
export function authorizeUpgrade(headers: Headers, url: URL): Promise<boolean> {
  return authorizeUpgradeWithCookie(headers, url)
}

/** Preview credentials are accepted only by the preview proxy bridge. */
export function authorizePreviewUpgrade(headers: Headers, url: URL): Promise<boolean> {
  return authorizeUpgradeWithCookie(headers, url, PREVIEW_AUTH_COOKIE)
}

/** Editor credentials are accepted only by the embedded editor bridge. */
export function authorizeEditorUpgrade(headers: Headers, url: URL): Promise<boolean> {
  return authorizeUpgradeWithCookie(headers, url, EDITOR_AUTH_COOKIE)
}
