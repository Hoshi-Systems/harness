import { renderTemplate } from './workflow-template.js'
import type { WorkflowHttpRequest } from './graph/index.js'

/**
 * ── HTTP workflow nodes ──────────────────────────────────────────────────────
 *
 * A node that performs one request instead of running an agent turn, so a
 * pipeline can fetch the thing it is about to reason over — or post the result
 * somewhere — without spending a model call on `curl`.
 *
 * EGRESS POLICY: unrestricted, and that is a decision, not an oversight. An
 * agent step on the same machine already has `bash` plus web tools, and a
 * workflow session auto-approves its permissions (the engine's approver
 * `isUnattendedSession`), so a destination allowlist HERE would gate the one
 * door in an open room while pretending the room is closed. Localhost is
 * explicitly fine: reaching the machine's own dev server is a normal thing for
 * a pipeline to do, and `bash` can do it anyway.
 *
 * What IS enforced is resource safety — the sidecar must not be wedgeable by a
 * step definition: an http(s) scheme only (no `file:`, no `data:`), a request
 * timeout, a redirect cap, and a response-size cap. None of those are about
 * where a request may go.
 *
 * Every field is a template, rendered against the run context and the vault at
 * send time, which is what makes `Authorization: Bearer {{secrets.TOKEN}}` the
 * intended way to authenticate one — and why this module hands back a REDACTED
 * twin of everything it sends for the run record to store.
 *
 **/

const REQUEST_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 1_048_576
/** `fetch` follows redirects itself; this caps how far, via manual mode. */
const MAX_REDIRECTS = 5

export interface HttpStepResult {
  /** `steps.<key>.output` for later templates. */
  output: { status: number; headers: Record<string, string>; body: unknown }
  /** `steps.<key>.text` — the response body as text, already redacted. */
  text: string
  /** A one-line `GET https://…` summary for the run record, already redacted. */
  summary: string
  /** Absent for 2xx; set means the step ERRORED and the retry policy applies. */
  error: string | null
}

/** Perform an http step. Never throws: a transport failure, a timeout and a
 *  non-2xx status all come back as `error`, which is the retryable class —
 *  a flaky endpoint is exactly what a step's retry policy is for. */
export async function performHttpStep(
  http: WorkflowHttpRequest,
  context: Record<string, unknown>,
  secrets: Map<string, string>,
): Promise<HttpStepResult & { missing: string[] }> {
  const missing: string[] = []
  const render = (template: string) => {
    const rendered = renderTemplate(template, context, secrets)
    missing.push(...rendered.missing)
    return rendered
  }

  const url = render(http.url)
  const summary = `${http.method} ${url.redacted.trim()}`

  let target: URL
  try {
    target = new URL(url.text.trim())
  } catch {
    return { output: emptyOutput(), text: '', summary, error: `"${url.redacted.trim()}" is not a valid URL.`, missing }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { output: emptyOutput(), text: '', summary, error: `Only http and https URLs can be requested.`, missing }
  }

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(http.headers)) headers[name] = render(value).text
  const body = http.body === null ? null : render(http.body).text

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchFollowing(target, { method: http.method, headers, body }, controller.signal)
    const text = await readCapped(response)
    return {
      output: {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        /**
         *
         * Parsed when it parses, so `{{steps.fetch.output.body.id}}` works;
         * the raw string otherwise.
         *
         **/
        body: tryParseJson(text),
      },
      text,
      summary,
      error: response.ok ? null : `The request returned ${response.status} ${response.statusText}`.trim() + '.',
      missing,
    }
  } catch (error) {
    const reason = controller.signal.aborted
      ? `The request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s.`
      : `The request failed: ${error instanceof Error ? error.message : String(error)}`
    return { output: emptyOutput(), text: '', summary, error: reason, missing }
  } finally {
    clearTimeout(timer)
  }
}

function emptyOutput(): HttpStepResult['output'] {
  return { status: 0, headers: {}, body: null }
}

/** Follow redirects by hand so the hop count is OUR limit rather than the
 *  runtime's default, and so a redirect chain can't be used to spin the
 *  sidecar. Headers ride along — the destination is unrestricted by policy, so
 *  there is nothing to protect by stripping them. */
async function fetchFollowing(
  url: URL,
  init: { method: string; headers: Record<string, string>; body: string | null },
  signal: AbortSignal,
): Promise<Response> {
  let target = url
  for (let hop = 0; ; hop++) {
    const response = await fetch(target, {
      method: init.method,
      headers: init.headers,
      ...(init.body === null ? {} : { body: init.body }),
      redirect: 'manual',
      signal,
    })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (!location) return response
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`)
    target = new URL(location, target)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`redirected to an unsupported scheme (${target.protocol})`)
    }
  }
}

/** Read at most MAX_RESPONSE_BYTES — a step must not be able to pull an
 *  arbitrarily large body into the sidecar's memory. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    text += decoder.decode(value, { stream: true })
    if (bytes >= MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return text
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
