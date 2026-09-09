import { defineEventHandler, getHeader, setResponseHeaders, setResponseStatus } from 'h3'
const explicitOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/** The desktop app serves the bundled web UI from this loopback origin — always
 *  trusted so a desktop client can drive the machine without the operator
 *  editing CORS_ORIGINS. Auth still applies; this only unlocks the browser-level
 *  gate. Mirrored in apps/api (the two APIs share no code). */
const DESKTOP_ORIGIN = 'http://127.0.0.1:17423'

/** The mobile app's bundled web UI runs inside the native WebView, which (unlike
 *  Electron) has no loopback server to give it one fixed origin — iOS's WKWebView
 *  reports `capacitor://localhost` and Android is pinned to `https://localhost` via
 *  capacitor.config.ts's `server.androidScheme`. Always trusted for the same reason
 *  as DESKTOP_ORIGIN above. Mirrored in apps/api. */
const MOBILE_ORIGINS = ['capacitor://localhost', 'https://localhost']

function isAllowed(origin: string): boolean {
  if (origin === DESKTOP_ORIGIN || MOBILE_ORIGINS.includes(origin)) return true
  if (explicitOrigins.length > 0) return explicitOrigins.includes(origin)
  /**
   *
   * Dev convenience only: trust localhost when nothing is configured. The sidecar
   * is publicly addressable, so in production a missing CORS_ORIGINS must fail
   * closed rather than reflect any localhost page with credentials.
   *
   **/
  if (process.env.NODE_ENV === 'production') return false
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/** CORS for every client that is not on this machine's own origin — the web
 *  app, desktop, mobile. Applied to EVERY request before the router sees it: an
 *  answer without these headers is an answer the browser throws away, and a
 *  route that forgot them fails only in a browser, never in a test. */
export const cors = defineEventHandler((event) => {
  const origin = getHeader(event, 'origin')
  if (!origin) return
  if (!isAllowed(origin)) return

  setResponseHeaders(event, {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  })

  if (event.method === 'OPTIONS') {
    setResponseHeaders(event, {
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': getHeader(event, 'access-control-request-headers') ?? 'content-type',
      'access-control-max-age': 86400,
    })
    setResponseStatus(event, 204)
    return ''
  }
})
