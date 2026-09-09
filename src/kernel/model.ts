import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { readSecretValue } from './secrets.js'
import { getPreferences } from './preferences.js'
import { listProviderStatuses, resolveModel, type ProviderStatus } from './providers.js'
import { reasoningFetch, type ReasoningEffort } from './reasoning.js'
import { GITHUB_COPILOT_PROVIDER_ID, copilotFetch } from './github-copilot.js'

/**
 * ── Turning a model reference into something that can be called ──────────────
 *
 * The one place credentials are read for an actual request. Deliberately per
 * call rather than cached at boot: the whole point of owning the engine is that
 * a key saved a moment ago works now, and a cached client would quietly hold the
 * old one (or none) until a restart — exactly the behaviour we removed.
 *
 **/

/** Why a model reference cannot be used. The caller reports each differently —
 *  an unknown model is a bad request, a missing key is a prompt to connect. */
export type ModelProblem = 'unknown' | 'needs-key'

export class ModelUnavailableError extends Error {
  constructor(
    readonly problem: ModelProblem,
    message: string,
  ) {
    super(message)
  }
}

/** Build a callable model from a `provider/model` reference.
 *
 *  Only OpenAI-compatible endpoints today: that covers every custom provider
 *  (LM Studio, Ollama, vLLM, the test mock) and most hosted ones. A catalogue
 *  provider with no baseUrl has nowhere to send the request yet, and says so
 *  rather than failing later inside a turn with a confusing error. */
export interface ModelPricing {
  /** Dollars per million tokens; null when the catalogue has no price. */
  input: number | null
  output: number | null
}

export async function buildModel(
  ref: string,
  options: {
    /** How hard to ask this model to think, when the person chose (engine/reasoning.ts).
     *  Omitted or `auto` sends nothing and leaves the provider's own default. */
    effort?: ReasoningEffort
  } = {},
): Promise<{
  model: LanguageModel
  provider: ProviderStatus
  /** The `provider/model` reference this resolved to — what the turn records
   *  as having produced the answer, and the key spend is broken down by. The
   *  caller's own `ref` is not it: a turn started with no model at all still
   *  ran on something, and a bill that says "unknown" for those is useless. */
  modelRef: string
  contextLimit: number
  pricing: ModelPricing
  /** Whether this model can be handed a picture.
   *
   *  Refused only when the catalogue explicitly lists what the model accepts
   *  and `image` is not among it. Silence means yes, deliberately: a custom
   *  endpoint has no catalogue entry, and the cost of the two mistakes is not
   *  symmetric. Sending an image to a text-only model does not degrade the
   *  answer — the provider rejects the whole request, and because the picture
   *  stays in the conversation, EVERY later turn in that session fails the same
   *  way. Withholding one from a model that could have read it only loses the
   *  picture. */
  acceptsImages: boolean
}> {
  const resolved = await resolveModel(ref)
  if (!resolved) throw new ModelUnavailableError('unknown', `This machine has no model "${ref}".`)

  const { provider, model } = resolved
  if (!provider.connected) {
    throw new ModelUnavailableError('needs-key', `${provider.name} needs an API key before it can be used.`)
  }
  if (!provider.baseUrl) {
    throw new ModelUnavailableError('unknown', `${provider.name} has no endpoint configured on this machine yet.`)
  }

  /**
   *
   * Read the key at call time, never before. `keyless` providers (a local
   * runtime on loopback) get a placeholder because the SDK insists on a string;
   * nothing is sent that the endpoint will look at.
   *
   **/
  const apiKey = provider.keyEnvVar ? ((await readSecretValue(provider.keyEnvVar)) ?? '') : ''

  /**
   *
   * The model's own control, from the catalogue: a named level, an on/off
   * toggle, or a token budget. Handing the effort over without it would send
   * `medium` to a model whose only settings are on and off.
   *
   **/
  const effortFetch = reasoningFetch(options.effort, {
    mode: model.reasoningMode,
    budgetMin: model.reasoningBudgetMin,
  })
  /**
   *
   * Copilot is the one provider whose vault credential is not what the wire
   * wants: the GitHub token has to be exchanged for a Copilot one per request
   * (kernel/github-copilot.ts). Composed OVER the effort hook, so both apply.
   *
   **/
  const requestFetch =
    provider.id === GITHUB_COPILOT_PROVIDER_ID
      ? copilotFetch(apiKey, provider.baseUrl, effortFetch ?? globalThis.fetch)
      : effortFetch
  const client = createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    apiKey: apiKey || 'not-required',
    /**
     *
     * Absent unless a person asked for an effort, in which case this is the
     * hook that puts `reasoning_effort` on the request (engine/reasoning.ts).
     *
     **/
    ...(requestFetch ? { fetch: requestFetch } : {}),
  })
  /**
   *
   * The catalogue's context window rides along: it is what lets a turn compact
   * itself before it overflows. Zero when the catalogue has no figure for this
   * model — a custom endpoint, usually — and the caller then runs uncompacted
   * rather than guessing a limit and truncating a conversation that was fine.
   *
   **/
  return {
    model: client.chatModel(model.id),
    provider,
    modelRef: `${provider.id}/${model.id}`,
    contextLimit: model.contextLimit,
    /**
     *
     * Straight from the model record, where zero already means free and null
     * already means nobody published a price (engine/providers.ts).
     *
     **/
    pricing: { input: model.inputCost, output: model.outputCost },
    acceptsImages: model.inputModalities.length === 0 || model.inputModalities.includes('image'),
  }
}

/** The model a turn runs with when nothing anywhere names one. First connected
 *  provider, first model — enough to make a machine usable out of the box.
 *
 *  This is the LAST rung, not the first, and it is no longer exported: it used
 *  to be reached directly by every caller that had no model of its own, which
 *  quietly made "the first provider's first model" the machine's real default
 *  and left the one the owner actually configured unread. `resolveModelRef` is
 *  the only way here now, which is the point. */
async function defaultModelRef(providers: ProviderStatus[]): Promise<string | null> {
  const usable = providers.find((provider) => provider.connected && provider.models.length > 0)
  return usable ? `${usable.id}/${usable.models[0]!.id}` : null
}

/** The three sizes work is routed to. An archetype declares one, the machine
 *  maps each to a concrete model, and `task_route` suggests which one a request
 *  deserves. Deliberately a size rather than a model name: a specialist is
 *  written once and outlives whichever model is best at its job this month. */
export type ModelTier = 'light' | 'standard' | 'heavy'

export const MODEL_TIERS: ModelTier[] = ['light', 'standard', 'heavy']

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as string[]).includes(value)
}

/** What a caller writes to mean "whatever the thing above me is running on".
 *
 *  Spelled the same everywhere a model reference is accepted — a `team_plan`
 *  step, an archetype's tier, `task_route`'s answer — because a caller that has
 *  no opinion should not have to know which of them it is talking to. */
export const INHERIT = 'inherit'

/** A model reference the caller actually meant, or null when they meant
 *  "inherit". Empty strings and the literal are both an absence of opinion. */
function stated(ref: string | null | undefined): string | null {
  const trimmed = typeof ref === 'string' ? ref.trim() : ''
  return trimmed && trimmed !== INHERIT ? trimmed : null
}

/** The concrete model for one tier, or null when this machine has nothing
 *  configured for it.
 *
 *  Null rather than the default model's name on purpose: "no heavy model is
 *  set" and "the heavy model happens to equal the default" are different
 *  answers, and collapsing them pins a recruit to a model nobody chose. The
 *  CALLER decides what an unconfigured tier falls back to. */
export async function tierModelRef(tier: ModelTier): Promise<string | null> {
  const preferences = await getPreferences()
  if (tier === 'light') return stated(preferences.smallModel)
  if (tier === 'heavy') return stated(preferences.heavyModel)
  return stated(preferences.model)
}

/** THE ONE PLACE a `provider/model` is decided, for every turn on this machine.
 *
 *  The chain, in order: what the caller asked for, then what the machine's
 *  owner configured as its default, then the first model that exists at all.
 *
 *  Every rung but the last used to be missing. A send with no model — which is
 *  every unattended run on the machine: a schedule, a webhook, an agent-inbox
 *  task, a goal's own next turn, an engagement step that said "inherit" — went
 *  straight to the last rung. So the machine's configured default model was
 *  read by nothing, and the model that answered was whichever one the provider
 *  catalogue happened to list first: not the one anybody picked, and often not
 *  one that works. */
export async function resolveModelRef(requested?: string | null): Promise<string | null> {
  const asked = stated(requested)
  if (asked) return asked
  const preferred = stated((await getPreferences()).model)
  if (preferred) return preferred
  return defaultModelRef(await listProviderStatuses())
}

/** Ask a model one question and get the text back. No session, no tools, no
 *  history, nothing persisted.
 *
 *  This exists because a tool sometimes needs a model to decide something —
 *  which specialist should handle a request, is this text English — and that is
 *  not a conversation. Under the old runtime there was no way to ask: the
 *  router had to create a session, post into it, read the reply and delete the
 *  session again, which put a throwaway in the user's session list every time
 *  the cleanup failed. */
export async function complete(
  prompt: string,
  options: { model?: string; system?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { generateText } = await import('ai')
  const ref = await resolveModelRef(options.model)
  if (!ref) throw new ModelUnavailableError('needs-key', 'This machine has no usable model yet.')
  const { model } = await buildModel(ref)
  const result = await generateText({
    model,
    ...(options.system ? { system: options.system } : {}),
    prompt,
    abortSignal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  return result.text
}
