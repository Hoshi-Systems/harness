import type { H3Event } from 'h3'
import { getHeader, getRequestURL, proxyRequest, sendRedirect, setCookie } from 'h3'
import {
  apiError,
  requireAuth,
  requirePreviewAuth,
  authorizeRawToken,
  EDITOR_AUTH_COOKIE,
  PREVIEW_AUTH_COOKIE,
  HOSHI_TOKEN_HEADER,
} from '../../kernel/index.js'
import { reservedPorts } from './listening-ports.js'
import { PREVIEW_PICKER_SCRIPT } from './preview-picker-script.js'

/**
 *
 * The preview proxy: streams HTTP between the embedded browser iframe and a
 * dev server listening on this machine, over the machine's public ingress.
 * Two cooperating pieces: the entry routes under /proxy/{port}/** (auth,
 * cookies, the actual forward) and the root catch-all fallback that resolves
 * the previewed app's absolute-path requests (/assets/x.js) via the
 * preview-port cookie. WebSocket upgrades (Vite HMR) are not bridged — pages
 * render, hot-reload doesn't.
 *
 **/

/** Remembers which port the last-opened preview points at — the root fallback
 *  follows it for absolute-path subresources. */
export const PREVIEW_PORT_COOKIE = 'hoshi-preview-port'

/** Response headers that must not reach the embedding browser — frame guards
 *  would block our iframe. The previewed app's set-cookie is handled separately
 *  (its cookies must never shadow the machine-host session/preview cookies —
 *  auth correctness, not just hygiene — but our OWN cookies must survive). */
const STRIP_RESPONSE_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only']

/** A caller-supplied port, validated: a real TCP port that isn't one of the
 *  machine's own listeners (proxying to the sidecar itself would loop). */
export function parsePreviewPort(raw: string | undefined): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    apiError(400, 'preview.invalidPort', 'Not a valid TCP port.')
  }
  if (reservedPorts().has(port)) {
    apiError(400, 'preview.reservedPort', 'This port belongs to the machine itself.')
  }
  return port
}

/** Entry handler for /proxy/{port}/** — shared by the index and catch-all
 *  routes. Handles the `?hoshi_token=` first-navigation handshake (an iframe
 *  can't send an Authorization header, so the first load carries the machine
 *  bearer in the query; it's validated through the normal auth chain, persisted
 *  as a machine-host cookie, and stripped from the URL with a redirect). */
export async function handlePreviewEntry(event: H3Event): Promise<unknown> {
  const port = parsePreviewPort(event.context.params?.port)
  const url = getRequestURL(event)
  const secure = url.protocol === 'https:'

  const redirected = await handleTokenHandshake(event, url, {
    setExtraCookies: () => {
      setCookie(event, PREVIEW_PORT_COOKIE, String(port), { httpOnly: true, sameSite: 'lax', path: '/', secure })
    },
  })
  if (redirected) return

  await applyAlternateTokenHeader(event, secure)
  await requirePreviewAuth(event)
  /**
   *
   * Refresh the port pointer on every entry hit so the root fallback follows
   * the most recently opened preview.
   *
   **/
  setCookie(event, PREVIEW_PORT_COOKIE, String(port), { httpOnly: true, sameSite: 'lax', path: '/', secure })
  return forwardToPort(event, port, event.context.params?.path ?? '', url.search)
}

/** The `?hoshi_token=` first-navigation handshake, shared by the path-prefix
 *  entry and the preview-host middleware: ride the query token through
 *  requireAuth's full chain (platform JWT or static token, owner lock) by
 *  presenting it as the bearer, persist it as a cookie on THIS host, then 302
 *  to the clean URL. Returns whether the redirect was sent — callers must
 *  stop and return nothing then (the response is already written; h3's
 *  `event.handled` covers the rest). NOT the sendRedirect value itself: that
 *  resolves to undefined, which read as "no redirect" and let the handler
 *  keep running into the flushed response (found live on the editor route). */
export async function handleTokenHandshake(
  event: H3Event,
  url: URL,
  options: { cookie?: string; cookiePath?: string; setExtraCookies?: () => void } = {},
): Promise<boolean> {
  const token = url.searchParams.get('hoshi_token')
  if (!token) return false
  event.node.req.headers.authorization = `Bearer ${token}`
  await requireAuth(event)
  setCookie(event, options.cookie ?? PREVIEW_AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: options.cookiePath ?? '/',
    maxAge: 3600,
    secure: url.protocol === 'https:',
  })
  options.setExtraCookies?.()
  url.searchParams.delete('hoshi_token')
  await sendRedirect(event, `${url.pathname}${url.search}`, 302)
  return true
}

/** A non-browser client whose own `Authorization` header is already spent on
 *  its own auth scheme proves its
 *  Hoshi credential via {@link HOSHI_TOKEN_HEADER} instead. Unlike
 *  {@link handleTokenHandshake} this never redirects — it can fire on any
 *  request, not just navigation — but it refreshes the same preview-auth
 *  cookie, so a same-origin WebSocket upgrade that follows (which can't carry
 *  a custom header itself) authenticates from the cookie. A no-op when the
 *  header is absent or invalid; requireAuth still runs normally either way. */
async function applyAlternateTokenHeader(event: H3Event, secure: boolean): Promise<void> {
  const token = getHeader(event, HOSHI_TOKEN_HEADER)
  if (!token || !(await authorizeRawToken(token))) return
  setCookie(event, PREVIEW_AUTH_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 3600, secure })
}

/** Our cookie names — a previewed app must never overwrite these, even on its
 *  own dedicated origin. */
const RESERVED_COOKIES = [PREVIEW_AUTH_COOKIE, EDITOR_AUTH_COOKIE, PREVIEW_PORT_COOKIE, 'session']

/** Stream one request to the local port. Hoshi credentials never reach the
 *  previewed app (cookie/authorization/alternate-token header blanked); the
 *  app's frame guards never reach the browser. Cookies depend on the origin:
 *  on the SHARED machine host the app's set-cookie is dropped (it would shadow
 *  the sidecar's own auth cookies); on a DEDICATED per-port preview origin the
 *  app's cookies pass through (minus our reserved names), so previewed apps
 *  keep their sessions. Redirects pass through untouched (`redirect: 'manual'`)
 *  — relative Locations land back on the same host, where preview routing
 *  re-enters. */
export function forwardToPort(
  event: H3Event,
  port: number,
  path: string,
  search: string,
  options: { dedicatedOrigin?: boolean; pickerScript?: boolean; stripCors?: boolean } = {},
): Promise<unknown> {
  /**
   *
   * Cookies set by US before the forward (preview-port/-auth) — h3's sendProxy
   * replaces the set-cookie header wholesale when the upstream sends its own,
   * so remember ours and re-merge after filtering the app's.
   *
   **/
  const ownCookies = normalizeCookieHeader(event.node.res.getHeader('set-cookie'))
  /**
   *
   * Likewise for a CORS policy this request's caller already decided on.
   *
   **/
  const ownCors: Record<string, string | number | string[]> = {}
  if (options.stripCors) {
    for (const header of event.node.res.getHeaderNames()) {
      if (!header.startsWith('access-control-')) continue
      const value = event.node.res.getHeader(header)
      if (value !== undefined) ownCors[header] = value
    }
  }
  return proxyRequest(event, `http://127.0.0.1:${port}/${path}${search}`, {
    headers: { cookie: '', authorization: '', [HOSHI_TOKEN_HEADER]: '' },
    fetchOptions: { redirect: 'manual' },
    /**
     *
     * h3 DOES await this hook (`await opts.onResponse(event, response)`), but
     * types it as returning void, so the rule cannot see that. Kept async on
     * purpose — the disable is the type gap, not a suppressed defect.
     *
     **/
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async onResponse(proxied, response) {
      for (const header of STRIP_RESPONSE_HEADERS) proxied.node.res.removeHeader(header)
      /**
       *
       * An upstream that answers CORS itself (a previewed dev server that
       * allows loopback origins) would leave TWO `Access-Control-Allow-Origin`
       * headers on the response — which browsers reject outright instead of
       * merging. Drop everything CORS the upstream sent, then restore the
       * caller's own policy, captured before the forward (same shape as the
       * set-cookie merge below — h3 replaces our headers with the upstream's).
       *
       **/
      if (options.stripCors) {
        for (const header of proxied.node.res.getHeaderNames()) {
          if (header.startsWith('access-control-')) proxied.node.res.removeHeader(header)
        }
        for (const [header, value] of Object.entries(ownCors)) proxied.node.res.setHeader(header, value)
      }
      const merged = normalizeCookieHeader(proxied.node.res.getHeader('set-cookie'))
      const appCookies = options.dedicatedOrigin
        ? merged.filter(
            (cookie) => !ownCookies.includes(cookie) && !RESERVED_COOKIES.some((name) => cookie.startsWith(`${name}=`)),
          )
        : []
      proxied.node.res.removeHeader('set-cookie')
      const final = [...appCookies, ...ownCookies]
      if (final.length > 0) proxied.node.res.setHeader('set-cookie', final)

      /**
       *
       * Only HTML responses get buffered and rewritten (picker script inlined
       * before `</body>`) — every other content type (JS/CSS/images/XHR/SSE/
       * etc.) stays h3's normal zero-copy streamed passthrough, handled by
       * proxyRequest itself once this hook returns without touching the body.
       * `pickerScript: false` opts a consumer out entirely (the embedded code
       * editor is machine chrome, not a previewed dev server).
       *
       **/
      if (options.pickerScript === false || !isHtmlResponse(response)) return
      const html = await response.text()
      proxied.node.res.end(injectPreviewPicker(html))
    },
  })
}

function normalizeCookieHeader(value: string | number | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
}

/** Inlines the CYB-98 picker script right before `</body>` (or appends it when
 *  a page has none). Inline, not `<script src>` — BOTH preview transports
 *  (the dedicated `p{port}--` origin's global middleware, and the
 *  path-prefix mode's root catch-all) unconditionally forward every
 *  absolute-path request straight to the previewed dev server, so there is no
 *  same-origin path machine-api could serve a separate asset from; the script
 *  has to travel inline with the document itself. */
function injectPreviewPicker(html: string): string {
  const tag = `<script>${PREVIEW_PICKER_SCRIPT}</script>`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : `${html}${tag}`
}
