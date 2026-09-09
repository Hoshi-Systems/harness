import type { ProviderModel } from './providers.js'

/**
 * ── Asking a provider what it serves ─────────────────────────────────────────
 *
 * For a provider the open catalogue has never heard of, the endpoint itself is
 * the only thing that knows what runs behind it. That is the ordinary case for
 * self-hosted runtimes — Ollama, LM Studio, vLLM — which an organization points
 * its machines at by address alone.
 *
 * The Platform does the same thing for the org's curation dialog
 * (apps/api/utils/provider-discovery.ts). The two are deliberately separate
 * copies rather than a shared package: they answer for different reachability.
 * An endpoint on the office LAN, or on the machine's own loopback, is visible
 * to the machine and invisible to the Platform — so "what does this provider
 * serve?" genuinely has two different correct answers depending on who asks,
 * and the machine must ask for itself rather than trust a list assembled
 * elsewhere.
 *
 **/

const TIMEOUT_MS = 3_000

/** How long a discovery answer is reused. Short, because the point of asking
 *  the endpoint is to reflect what is loaded RIGHT NOW — a model pulled a
 *  minute ago should show up without restarting anything. Long enough that
 *  listing providers (every turn does, to resolve a model) is not a request
 *  per call. */
const TTL_MS = 60_000

/** Failures are cached too, and for longer: a machine that is off stays off,
 *  and a three-second timeout on every provider listing would make the whole
 *  app feel broken rather than just that one provider unavailable. */
const FAILURE_TTL_MS = 300_000

interface CacheEntry {
  at: number
  /** Null when the endpoint did not answer with a model list. */
  result: DiscoveredProvider | null
}

export interface DiscoveredProvider {
  models: ProviderModel[]
  /** The endpoint answered with no credential at all. Evidence, not a guess:
   *  it is what tells a local runtime apart from a hosted endpoint that needs
   *  a key, and it decides whether the machine reports this provider as usable
   *  or as waiting for one. */
  keyless: boolean
}

const cache = new Map<string, CacheEntry>()

/** Models one URL lists, or none — "none" covering every way a URL can fail to
 *  be a model list: refused, 404, an error body, HTML, a 200 of some other
 *  shape. Never throws: a provider that cannot be reached must cost its own
 *  models and nothing else. */
async function listModelsAt(url: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    return (body?.data ?? []).map((entry) => entry?.id).filter((id): id is string => typeof id === 'string' && !!id)
  } catch {
    return []
  }
}

/** Try the address as given, then one level down under `/v1`.
 *
 *  An endpoint is usually written down as its root origin
 *  (`http://box:11434`), because that is what its own documentation shows,
 *  while the OpenAI-compatible surface lives at `/v1`. The retry is keyed on
 *  "that was not a model list" rather than on a status code: LM Studio answers
 *  the root path with a cheerful `200 {"error": "Unexpected endpoint or
 *  method"}`, so a 404-only retry never fires for the runtime most likely to
 *  need it. */
async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const listed = await listModelsAt(`${base}/models`, apiKey)
  if (listed.length > 0 || /\/v\d+$/.test(base)) return listed
  return await listModelsAt(`${base}/v1/models`, apiKey)
}

/** What a local runtime says about one model beyond its id. */
interface LocalModelDetail {
  contextLength: number
  vision: boolean
}

/**
 * ── What the OpenAI-compatible list leaves out ───────────────────────────────
 *
 * `/v1/models` is a list of ids and nothing else — that is all the standard
 * asks for. So every model on a self-hosted endpoint arrived with a context
 * limit of 0, and the composer's context meter, which needs a denominator,
 * disappeared entirely for anybody running LM Studio. The information existed
 * the whole time, one path over: LM Studio's own `/api/v0/models` publishes
 * `max_context_length` (a million tokens on the model this was found with), the
 * loaded state, and whether the model takes images.
 *
 * Asked as a SIBLING of the configured base URL, once, and quietly: an endpoint
 * that is not LM Studio answers 404 and the result is the same list of ids it
 * always was. One extra request per discovery, which is itself cached.
 *
 **/
async function localRuntimeDetail(baseUrl: string): Promise<Map<string, LocalModelDetail>> {
  const detail = new Map<string, LocalModelDetail>()
  const native = baseUrl.replace(/\/v\d+\/?$/, '') + '/api/v0/models'
  const res = await fetch(native, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null)
  if (!res?.ok) return detail
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  for (const raw of Array.isArray(body?.data) ? body.data : []) {
    const entry = (raw ?? {}) as Record<string, unknown>
    if (typeof entry.id !== 'string') continue
    /**
     *
     * The LOADED length when there is one, because that is the window the
     * server will actually accept right now — a model loaded at 8k in a
     * runtime that could serve a million is still an 8k conversation.
     *
     **/
    const loaded = typeof entry.loaded_context_length === 'number' ? entry.loaded_context_length : 0
    const max = typeof entry.max_context_length === 'number' ? entry.max_context_length : 0
    detail.set(entry.id, { contextLength: loaded || max, vision: entry.type === 'vlm' })
  }
  return detail
}

/** What `baseUrl` actually serves, or null when it did not answer with a model
 *  list. Asked without a credential first — a local runtime needs none, and
 *  succeeding that way is what proves it. */
export async function discoverProvider(baseUrl: string, apiKey: string | null): Promise<DiscoveredProvider | null> {
  const key = `${baseUrl}\0${apiKey ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < (hit.result ? TTL_MS : FAILURE_TTL_MS)) return hit.result

  let ids = await listModels(baseUrl, '')
  const keyless = ids.length > 0
  if (ids.length === 0 && apiKey) ids = await listModels(baseUrl, apiKey)
  const detail = ids.length > 0 ? await localRuntimeDetail(baseUrl) : new Map<string, LocalModelDetail>()

  const result: DiscoveredProvider | null =
    ids.length === 0
      ? null
      : {
          keyless,
          /**
           *
           * No catalogue metadata to draw on: an id is genuinely all the
           * endpoint gave us. Costs are null, not 0 — this is somebody's own
           * hardware or their own contract, and both "free" and "priced" would
           * be inventions. A context limit of 0 means "unknown", which the turn
           * loop already reads as "do not auto-compact".
           *
           **/
          models: ids.map((id) => ({
            id,
            name: id,
            /**
             *
             * The endpoint's own figure when it publishes one (see
             * localRuntimeDetail); 0 when it does not, which the turn loop
             * reads as "unknown, do not auto-compact".
             *
             **/
            contextLimit: detail.get(id)?.contextLength ?? 0,
            inputCost: null,
            outputCost: null,
            outputModalities: [],
            inputModalities: detail.get(id)?.vision ? ['text', 'image'] : [],
            /**
             *
             * A discovered endpoint lists ids and nothing else, so both are
             * null: unknown, which the composer reads as "offer the common
             * thinking levels", never as "this model cannot think".
             *
             **/
            reasoning: null,
            reasoningMode: null,
            reasoningEfforts: null,
            reasoningBudgetMin: null,
            releaseDate: null,
            status: null,
          })),
        }
  cache.set(key, { at: Date.now(), result })
  return result
}

/** Forget what every endpoint said. For tests, and for the moment an org's
 *  provider list changes under us — the old answer describes an address the
 *  machine may no longer be pointed at. */
export function clearDiscoveryCache(): void {
  cache.clear()
}

/**
 * ── Proving a credential, as opposed to holding one ──────────────────────────
 *
 * `discoverProvider` above answers "what does this serve?", and it is
 * deliberately forgiving: every way a request can fail collapses into an empty
 * list, because a provider that cannot be reached must cost its own models and
 * nothing else. That is the right shape for a listing and the wrong shape for a
 * question somebody asked on purpose.
 *
 * The machine reported a provider `connected` the moment a key was in the
 * vault. That is true and it is not what anybody reads it as: a mistyped key, a
 * revoked one and a working one all looked identical until the first turn
 * failed, which is the worst possible moment to find out and the one place the
 * failure reads as the agent being broken.
 *
 * So this asks the same endpoint the same way a TURN will — `Authorization:
 * Bearer`, which is what `kernel/model.ts` builds every provider with — and
 * keeps the four answers apart:
 *
 *   ok           the endpoint listed models FOR THIS CREDENTIAL
 *   auth         it answered, and refused the credential
 *   unreachable  nothing answered at all
 *   untested     it listed models with no credential, so the key was never
 *                exercised. Not a pass. A local runtime is legitimately this,
 *                and so is a hosted endpoint whose model list is public — and
 *                only a real completion can tell those apart, which costs
 *                money and is therefore never done without being asked.
 *
 **/
export type ProviderProbe =
  | { outcome: 'ok'; models: number }
  | { outcome: 'untested'; models: number }
  | { outcome: 'auth'; status: number }
  | { outcome: 'unreachable' }

/** One attempt at one URL, reported by CATEGORY rather than swallowed.
 *  `null` means the URL is not a model list at all (a 404, an HTML page, a 200
 *  of some other shape) — which is not the same as the endpoint being down,
 *  and is why the caller tries `/v1` next instead of giving up. */
async function probeModelsAt(url: string, apiKey: string): Promise<ProviderProbe | null> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { outcome: 'unreachable' }
  }
  /**
   *
   * 401 and 403 are the credential's answer, and they are worth telling apart
   * from a 404 by the caller's own retry: an endpoint that refuses the key at
   * `/models` will refuse it at `/v1/models` too, so this stops there.
   *
   **/
  if (res.status === 401 || res.status === 403) return { outcome: 'auth', status: res.status }
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null
  const models = (body?.data ?? []).filter((entry) => typeof entry?.id === 'string' && !!entry.id).length
  return models > 0 ? { outcome: 'ok', models } : null
}

/** Whether this credential actually works against this endpoint.
 *
 *  Never cached. The cache above exists so that listing providers is not a
 *  request per call; this is a question somebody pressed a button to ask, and
 *  answering it with a five-minute-old failure would be answering a different
 *  question. */
export async function probeProvider(baseUrl: string, apiKey: string | null): Promise<ProviderProbe> {
  const base = baseUrl.replace(/\/+$/, '')
  const paths = /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`]

  /**
   *
   * Anonymously first, exactly as discovery does — an endpoint that lists
   * models to nobody has not been told anything about this key, and saying
   * "connected" on the strength of that is the lie this whole function exists
   * to stop.
   *
   **/
  if (apiKey) {
    for (const path of paths) {
      const anonymous = await probeModelsAt(path, '')
      if (anonymous?.outcome === 'ok') return { outcome: 'untested', models: anonymous.models }
    }
  }

  for (const path of paths) {
    const answer = await probeModelsAt(path, apiKey ?? '')
    /**
     *
     * Not a model list — a 404, an HTML page, a 200 of another shape. Try the
     * next path rather than concluding anything: the address is usually
     * written down as its root origin while the compatible surface lives at
     * `/v1`, which is the whole reason there are two.
     *
     **/
    if (!answer) continue
    if (answer.outcome === 'ok' && !apiKey) return { outcome: 'untested', models: answer.models }
    if (answer.outcome !== 'unreachable') return answer
  }
  /**
   *
   * Nothing here was a model list. Reported as unreachable rather than
   * invented into a credential problem: the ADDRESS is what is wrong, and
   * telling somebody their key was rejected when it was never read would send
   * them to reissue a perfectly good one.
   *
   **/
  return { outcome: 'unreachable' }
}

/**
 *
 * The only probe that can prove a key against an endpoint whose model list is
 * public: one real completion, one token.
 *
 * It costs money. Not much, and on most providers not measurably — but "not
 * much" is not "nothing", and a machine that spends somebody's credit to
 * reassure them about a text field has done something they did not ask for. So
 * it runs on an explicit request and nowhere else: no mount, no reload, no
 * retry loop.
 *
 **/
export async function probeCompletion(baseUrl: string, apiKey: string, model: string): Promise<ProviderProbe> {
  const base = baseUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    })
    if (res.status === 401 || res.status === 403) return { outcome: 'auth', status: res.status }
    if (!res.ok) return { outcome: 'unreachable' }
    return { outcome: 'ok', models: 1 }
  } catch {
    return { outcome: 'unreachable' }
  }
}
