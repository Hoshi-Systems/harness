import { unattended } from './context.js'
import type { H3Event } from 'h3'
import { defineEventHandler, getHeader, getHeaders, getQuery, getRouterParam, readRawBody } from 'h3'
import { apiError, rateLimitIp } from '../../kernel/index.js'
import { findWebhookForFire, markWebhookFired } from './triggers.js'
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from './webhook-signature.js'

/** The inbound payload cap for a fire. Oversize → 413; a caller shipping more
 *  than this into a prompt template is misusing the trigger. Checked before the
 *  HMAC so an unauthenticated caller can't make us hash an unbounded body. */
const WEBHOOK_BODY_MAX = 131_072

/** Caller headers that must never reach a prompt template — whatever
 *  credentials the SENDING system attached are its own, not run context, and
 *  our own signature headers are proof-of-auth rather than payload. */
const STRIPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
])

/** Public firing endpoint — deliberately no `requireAuth`. The id+secret pair
 *  in the URL IS the auth: anyone holding this URL (Linear, GitHub, curl, …)
 *  can fire it, so the secret is opaque and unguessable (see createWebhookTrigger).
 *  A webhook with a `signingSecret` demands more: a valid HMAC over the RAW body
 *  with a fresh timestamp, verified before anything is parsed or dispatched.
 *
 *  A prompt-mode webhook fires its fixed prompt through the task queue and
 *  never reads the body. A workflow-mode webhook DOES capture the request —
 *  JSON body (or raw text), headers minus credentials, query — as the run's
 *  `input`, which is what `{{trigger.body.*}}` templates over. Either way the
 *  caller gets `queued: true` back immediately and never waits for the run. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const secret = getRouterParam(event, 'secret')!

  /**
   *
   * The machine's only unauthenticated endpoint, throttled by caller IP
   * (security/SECURITY_AUDIT.md L9). The ceiling is per SOURCE, not per
   * webhook: a sender is one system firing a handful of hooks, while the thing
   * being bounded — guessing at secrets, or spending an owner's model budget
   * through a leaked URL — is the same caller either way.
   *
   * 60 a minute is far above any real sender (a busy CI repo pushes a few) and
   * far below what a probe wants.
   *
   **/
  rateLimitIp(event, 'webhook.fire', 60, 60_000)

  const webhook = await findWebhookForFire(id, secret)
  if (!webhook) apiError(404, 'webhook.notFound', 'Webhook not found.')

  /**
   *
   * Read once, up front: the signature covers exactly these bytes, and both
   * modes below work off the same read (h3 caches it, but reading here keeps
   * the "verify before parse" order impossible to get wrong later).
   *
   **/
  const raw = (await readRawBody(event, 'utf8').catch(() => undefined)) ?? ''
  if (raw.length > WEBHOOK_BODY_MAX) {
    apiError(413, 'webhook.bodyTooLarge', `The request body must be at most ${WEBHOOK_BODY_MAX} bytes.`, {
      max: WEBHOOK_BODY_MAX,
    })
  }

  if (webhook.signingSecret) {
    const failure = verifyWebhookSignature({
      secret: webhook.signingSecret,
      rawBody: raw,
      signature: getHeader(event, WEBHOOK_SIGNATURE_HEADER),
      timestamp: getHeader(event, WEBHOOK_TIMESTAMP_HEADER),
    })
    if (failure) {
      /**
       *
       * The reason stays in the machine's log; the caller gets one flat answer
       * so probing can't map out which half of the check it failed.
       *
       **/
      console.warn(`[webhooks] rejected a signed fire of "${webhook.name}": ${failure}`)
      apiError(401, 'webhook.signatureInvalid', 'The request signature is missing or invalid.')
    }
  }

  if (webhook.workflowId) {
    const fired = await unattended().startWorkflow?.({
      workflowId: webhook.workflowId,
      source: 'webhook',
      triggerId: webhook.id,
      input: captureInput(event, raw),
    })
    /**
     *
     * Same non-leaking posture as a bad id or secret: a caller probing this
     * URL learns nothing about WHY it no longer fires — disabled, never
     * published, or no workflows on this machine at all are one answer.
     *
     **/
    if (!fired?.started) apiError(404, 'webhook.notFound', 'Webhook not found.')
    await markWebhookFired(webhook.id)
    return { ok: true, queued: true }
  }

  const dispatch = unattended().dispatch
  if (!dispatch) apiError(501, 'dispatch.unsupported', 'This machine cannot start unattended work.')
  await dispatch({
    source: 'webhook',
    triggerId: webhook.id,
    triggerName: webhook.name,
    prompt: webhook.prompt,
    projectId: webhook.projectId,
  })
  await markWebhookFired(webhook.id)

  return { ok: true, queued: true }
})

/** The request, shaped for templating: a JSON body parses into `body` (any
 *  other content stays a raw string), headers arrive lowercased minus
 *  credentials, query as-is. */
/** Structural rather than borrowed from the workflows area: what a webhook
 *  captured is a fact about the REQUEST, and this plugin must not have to know
 *  the shape of whatever consumes it. */
function captureInput(event: H3Event, raw: string): { body: unknown; headers: Record<string, string>; query: unknown } {
  let body: unknown = raw
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      /**
       *
       * Not JSON — hand templates the raw text as-is.
       *
       **/
    }
  } else {
    body = null
  }

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(getHeaders(event))) {
    if (!STRIPPED_HEADERS.has(name) && typeof value === 'string') headers[name] = value
  }

  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(getQuery(event))) {
    if (typeof value === 'string') query[name] = value
  }

  return { body, headers, query }
}
