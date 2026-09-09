/**
 * ── How hard the model thinks ────────────────────────────────────────────────
 *
 * Until recently, not our business at all: the machine never said, so every
 * model reasoned at whatever its provider defaults to. That is fine for a chat
 * and wrong for work — a one-line question pays for a minute of deliberation,
 * and a refactor gets whatever the endpoint felt like giving it.
 *
 * What makes this more than one field: models do not agree on what the control
 * IS. The open catalogue publishes three kinds, and they are not
 * interchangeable —
 *
 *   EFFORT   a named level (`minimal`, `low`, `medium`, `high`, sometimes
 *            `max`), sent as `reasoning_effort`. Most models.
 *   TOGGLE   thinking is on or off, nothing in between. Nemotron and the Qwen3
 *            family; the servers that host them (vLLM, SGLang, NVIDIA NIM) read
 *            it from `chat_template_kwargs.thinking`, because it is a template
 *            switch rather than a sampling parameter.
 *   BUDGET   a token allowance, sent as `thinking.budget_tokens` — the shape
 *            the catalogue names this kind after.
 *
 * Sending an effort word to a toggle model is not a near miss: `medium` is a
 * level it has never heard of, and the request is either refused or the field
 * quietly ignored. So the MODE decides the field, and the mode is read from the
 * catalogue rather than guessed from the model's name.
 *
 * `auto` sends nothing at all, and is the default. A model whose reasoning the
 * catalogue cannot describe — a local runtime, usually — is left alone unless a
 * person picks something for it.
 *
 **/

/** What a budget model's control offers, and the allowance each one asks for.
 *
 *  Named rather than a number box: "how many tokens of thinking" is not a
 *  question anybody wants to answer per message, and the three that matter are
 *  a little, a working amount, and as much as it needs. Raised to whatever
 *  minimum the model publishes. */
const BUDGET_EFFORTS: Record<string, number> = { low: 4_096, medium: 16_384, high: 32_768 }

export type ReasoningEffort = string

/** Shape, not membership.
 *
 *  An allow-list here would have to be updated every time a provider invents a
 *  level, and until then would refuse a value the model itself published — the
 *  machine telling a person their own model does not support what it says it
 *  supports. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(value)
}

/** What the catalogue knows about one model's reasoning control. */
export interface ReasoningControl {
  mode: 'effort' | 'toggle' | 'budget' | null
  budgetMin?: number | null
}

/** The request fields one choice becomes, for one model.
 *
 *  Exported on its own so the mapping can be tested directly: it is the part
 *  that is easy to get quietly wrong, and its failure mode is a field that goes
 *  out looking plausible and does nothing at all. */
export function reasoningBody(effort: ReasoningEffort, control: ReasoningControl): Record<string, unknown> | null {
  if (!effort || effort === 'auto') return null

  if (control.mode === 'toggle') {
    /**
     *
     * A template switch, not a sampling parameter — which is why it rides in
     * `chat_template_kwargs` rather than beside temperature. Sent for `off` as
     * well as `on`: turning thinking OFF is a real choice about a hybrid model,
     * and omitting the field would leave the server's default in place instead.
     *
     **/
    return { chat_template_kwargs: { thinking: effort !== 'off' } }
  }

  if (control.mode === 'budget') {
    if (effort === 'off') return null
    const asked = BUDGET_EFFORTS[effort] ?? BUDGET_EFFORTS.medium!
    return { thinking: { type: 'enabled', budget_tokens: Math.max(asked, control.budgetMin ?? 0) } }
  }

  /**
   *
   * Effort, and the unknown case. A model the catalogue cannot describe gets
   * the ordinary OpenAI field, which is what such an endpoint understands if it
   * understands anything at all.
   *
   **/
  return { reasoning_effort: effort }
}

/** Put the choice on the request itself.
 *
 *  On the REQUEST rather than on the model, which looks roundabout, so: the
 *  library's Agent accepts a model and settles every call setting itself —
 *  there is no seam to pass provider options through. The SDK's own answer to
 *  that (`wrapLanguageModel` + `defaultSettingsMiddleware`) only accepts a v3
 *  model, and the OpenAI-compatible provider still builds v2 ones. Wrapping
 *  conditionally would leave a machine where the control works or silently does
 *  nothing depending on a package version.
 *
 *  Never overwrites: a request that already names one of these fields was told
 *  by something closer to the model than we are. */
export function reasoningFetch(
  effort: ReasoningEffort | undefined,
  control: ReasoningControl = { mode: null },
): typeof globalThis.fetch | undefined {
  const fields = effort ? reasoningBody(effort, control) : null
  if (!fields) return undefined

  return async (input, init) => {
    if (typeof init?.body !== 'string') {
      /**
       *
       * Said out loud rather than passed over quietly. This hook is the only
       * thing that carries the choice, so a request shaped in a way it does not
       * recognise means the person's setting went nowhere — and the reply looks
       * exactly the same, so nothing else would ever report it.
       *
       **/
      console.warn('[harness] reasoning setting not applied: the request body was not JSON text')
      return fetch(input, init)
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      /**
       *
       * Not JSON, so not a request this understands — pass it through untouched
       * rather than guessing at its shape.
       *
       **/
      return fetch(input, init)
    }
    for (const [key, value] of Object.entries(fields)) {
      if (body[key] === undefined) body[key] = value
    }
    return fetch(input, { ...init, body: JSON.stringify(body) })
  }
}
