import { hoshiFile, readHoshiJson, readHoshiJsonStrict, writeHoshiJson } from './store.js'
import { publishMachineEvent } from './events.js'
import { ports, type OrgProvider } from './host-ports.js'
import { deleteSecret, listSecrets, readSecretValue } from './secrets.js'
import {
  clearDiscoveryCache,
  discoverProvider,
  probeCompletion,
  probeProvider,
  type ProviderProbe,
} from './provider-discovery.js'
import { providerLogin, type ProviderLoginKind } from './github-copilot.js'

/** The org's say, or the answers a machine with no org behind it gives: no
 *  restriction, nothing configured centrally, nothing to re-apply. Reading
 *  them through one place keeps every call site below written as though the
 *  org always existed (kernel/ports.ts). */
const resolveAllowedProviders = async (): Promise<Set<string> | null> => (await ports().allowedProviders?.()) ?? null
const readOrgProviderSnapshot = async (): Promise<OrgProvider[]> => (await ports().orgProviders?.()) ?? []
const readRelayProviders = async (): Promise<Provider[]> => (await ports().relayProviders?.()) ?? []
const syncOrgDefaultsOnce = async (): Promise<void> => {
  await ports().syncOrgProviders?.()
}

/**
 * ── Providers and models ─────────────────────────────────────────────────────
 *
 * Which models this machine can actually talk to, and whether it has the
 * credentials to do it.
 *
 * THE rule, and the reason the old runtime had to be replaced: nothing here is
 * cached across a credential change. `connected` is computed per request from
 * the live vault, so a key saved at 10:00 is usable at 10:00 — no process
 * cycle, no "restart to apply", no pending flag. OpenCode snapshotted its
 * catalogue once at startup and never refreshed it, which is what the whole
 * restart apparatus existed to work around.
 *
 * Two sources, deliberately different in kind:
 *
 *   custom     defined on this machine (~/.hoshi/providers.json) and fully
 *              self-describing — id, baseURL, models, which env var holds the
 *              key. This is how someone points at LM Studio, Ollama or vLLM,
 *              and how the E2E stack registers its mock. Works offline, always.
 *   catalogue  models.dev (MIT, open data): metadata for the hosted providers
 *              nobody wants to hand-write. Fetched best-effort and cached; when
 *              it is missing those providers simply do not appear. Degrades,
 *              never breaks — a machine with a custom provider must stay fully
 *              usable with no network at all.
 *
 * The organization's own configuration is an OVERLAY on those two — a name, an
 * address, a model curation — never a third source of providers. An org entry
 * the machine does not already have is OFFERED instead (`importableProviders`),
 * and importing it writes a `custom` definition here: the machine's provider
 * list is what its user chose, not what an admin's list happens to contain.
 *
 * Neither source can describe a self-hosted runtime — models.dev lists 182
 * providers and `ollama` is not among them — so a provider added by address
 * gets its models from the endpoint itself (engine/provider-discovery.ts).
 *
 **/

export interface ProviderModel {
  id: string
  name: string
  contextLimit: number
  /** Cost per million tokens. `0` is a real price — a free model — and `null`
   *  is "nobody published one", which is what a self-hosted endpoint and an
   *  unpriced catalogue entry both are. The two must stay distinguishable all
   *  the way to the spend total, or unknown quietly reads as free. */
  inputCost: number | null
  outputCost: number | null
  /** What the model can EMIT ("text", "image", …). Empty when the catalogue
   *  does not say, which is not the same as "text only" — a tool picking an
   *  image model must treat unknown as unusable rather than guess. */
  outputModalities: string[]
  /** What the model can BE GIVEN ("text", "image", …). Empty means the
   *  catalogue is silent, which is not "text only": a custom provider has no
   *  catalogue entry at all, and refusing it images on that basis would take a
   *  working feature away from every self-hosted model. */
  inputModalities: string[]
  /** Whether this model reasons at all. Null when the catalogue is silent — a
   *  custom endpoint, usually — which is not "no": a local runtime serving a
   *  reasoning model has no entry anywhere, and treating silence as no would
   *  take the control away from exactly the models people run themselves. */
  reasoning: boolean | null
  /** HOW this model's reasoning is controlled, straight from the catalogue.
   *
   *  Three ways exist and they are not interchangeable: 2188 models take a
   *  named EFFORT, 1016 take a plain on/off TOGGLE, and 496 take a token
   *  BUDGET. Collapsing them into "effort" — which is what this did at first —
   *  offers a Nemotron a `medium` it has never heard of, and the person's
   *  setting becomes a rejected request.
   *
   *  Null when the catalogue is silent, which is not "none": a self-hosted
   *  model has no entry, and the caller falls back to the common effort words. */
  reasoningMode: 'effort' | 'toggle' | 'budget' | null
  /** For an EFFORT model: its own levels, verbatim (`["low","medium","high"]`,
   *  and `["high","max"]` for the ones that have a max). Null for the others. */
  reasoningEfforts: string[] | null
  /** For a BUDGET model: the smallest thinking budget it accepts, in tokens.
   *  Null when unpublished or not a budget model. */
  reasoningBudgetMin: number | null
  releaseDate: string | null
  /** "deprecated" and the like, straight from the catalogue. */
  status: string | null
}

export interface Provider {
  id: string
  name: string
  /** Where requests go. Null for a catalogue provider using its own default. */
  baseUrl: string | null
  /** The vault key holding this provider's API token, when it needs one. */
  keyEnvVar: string | null
  /** A provider that needs no credential at all — a local runtime on loopback. */
  keyless: boolean
  /** Where this definition lives: this machine's own file, the open catalogue,
   *  or a live local-models connector (present exactly while its tunnel is). */
  source: 'custom' | 'catalogue' | 'relay'
  models: ProviderModel[]
  /** The organization's provider policy does not allow this one.
   *
   *  Only a provider this machine DEFINES can be seen in this state, and that
   *  is the whole point: a catalogue entry the org has not approved is simply
   *  not offered, but a connection somebody made and the org later withdrew is
   *  a configuration that still exists on disk. Hiding it made a machine that
   *  had been told "provider added, four models found" show no such provider a
   *  second later, with nothing anywhere saying why.
   *
   *  Blocked is not disconnected: `models` is emptied so nothing here can be
   *  selected or invoked, while `keyEnvVar`, `baseUrl` and `connected` keep
   *  saying what was configured and whether a credential is held. Policy,
   *  configuration and credentials are three different facts. */
  policyBlocked: boolean
}

/** A provider plus whether it can be used right now. */
export interface ProviderStatus extends Provider {
  connected: boolean
  /** How this provider is connected by signing in to an account, when it can
   *  be — a subscription has no key to paste. Null for the ordinary case. */
  login: ProviderLoginKind | null
}

const CUSTOM_FILE = () => hoshiFile('providers.json')
const CATALOGUE_CACHE = () => hoshiFile('models-dev.json')

/** Where the open catalogue comes from. Overridable so a machine on a closed
 *  network can point at an internal mirror — the data is MIT and self-hostable
 *  (docs/HARNESS_MIGRATION.md). */
const CATALOGUE_URL = process.env.HOSHI_MODELS_CATALOGUE_URL ?? 'https://models.dev/api.json'

interface CustomFile {
  providers?: Array<Partial<Provider>>
}

function normalizeModel(raw: unknown): ProviderModel | null {
  const model = (raw ?? {}) as Record<string, unknown>
  const id = typeof model.id === 'string' ? model.id : null
  if (!id) return null
  const limit = (model.limit ?? {}) as { context?: unknown }
  const cost = (model.cost ?? {}) as { input?: unknown; output?: unknown }
  const modalities = (model.modalities ?? {}) as { output?: unknown; input?: unknown }
  return {
    id,
    name: typeof model.name === 'string' ? model.name : id,
    contextLimit: typeof limit.context === 'number' ? limit.context : 0,
    /**
     *
     * Absent is null, never 0: an entry the catalogue never priced would
     * otherwise be indistinguishable from a genuinely free model, and every
     * turn on it would be billed to the user's spend total as costing nothing.
     *
     **/
    inputCost: typeof cost.input === 'number' ? cost.input : null,
    outputCost: typeof cost.output === 'number' ? cost.output : null,
    outputModalities: Array.isArray(modalities.output)
      ? modalities.output.filter((entry): entry is string => typeof entry === 'string')
      : [],
    inputModalities: Array.isArray(modalities.input)
      ? modalities.input.filter((entry): entry is string => typeof entry === 'string')
      : [],
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
    ...readReasoningOptions(model.reasoning_options),
    releaseDate: typeof model.release_date === 'string' ? model.release_date : null,
    status: typeof model.status === 'string' ? model.status : null,
  }
}

/** Providers defined on this machine. Hand-editable, and the only source that
 *  works with no network — so a validation failure drops the offending entry
 *  rather than the whole file: one typo must not cost a user every provider. */
async function readCustomProviders(): Promise<Provider[]> {
  const data = await readHoshiJson<CustomFile>(CUSTOM_FILE())
  const out: Provider[] = []
  for (const raw of data?.providers ?? []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue
    const models = (Array.isArray(raw.models) ? raw.models : [])
      .map(normalizeModel)
      .filter((m): m is ProviderModel => !!m)
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : null,
      keyEnvVar: typeof raw.keyEnvVar === 'string' && raw.keyEnvVar ? raw.keyEnvVar : null,
      keyless: raw.keyless === true,
      source: 'custom',
      models,
      policyBlocked: false,
    })
  }
  return out
}

/** How a catalogue entry says its reasoning is controlled.
 *
 *  `reasoning_options` describes it in one of three ways and they need three
 *  different controls AND three different request fields — a named effort, a
 *  bare on/off toggle, or a token budget. Reading only the first kind (which is
 *  what this did at first) leaves the other 1500 models being offered words
 *  they do not accept.
 *
 *  An entry that lists none of the three comes back as unknown rather than as
 *  "no reasoning": the caller then offers the common effort words, which is the
 *  best guess available and the one that was already being made. */
function readReasoningOptions(raw: unknown): {
  reasoningMode: ProviderModel['reasoningMode']
  reasoningEfforts: string[] | null
  reasoningBudgetMin: number | null
} {
  const none = { reasoningMode: null, reasoningEfforts: null, reasoningBudgetMin: null } as const
  if (!Array.isArray(raw)) return { ...none }
  for (const entry of raw) {
    const option = (entry ?? {}) as { type?: unknown; values?: unknown; min?: unknown }
    if (option.type === 'effort' && Array.isArray(option.values)) {
      const values = option.values.filter((value): value is string => typeof value === 'string' && !!value.trim())
      if (values.length > 0) return { reasoningMode: 'effort', reasoningEfforts: values, reasoningBudgetMin: null }
    }
    if (option.type === 'toggle') return { reasoningMode: 'toggle', reasoningEfforts: null, reasoningBudgetMin: null }
    if (option.type === 'budget_tokens') {
      return {
        reasoningMode: 'budget',
        reasoningEfforts: null,
        reasoningBudgetMin: typeof option.min === 'number' ? option.min : null,
      }
    }
  }
  return { ...none }
}

/** The cached open catalogue. Absent is normal (a fresh machine that has not
 *  refreshed yet, or one with no egress) and means an empty list, not an error. */
async function readCatalogue(): Promise<Provider[]> {
  const data = await readHoshiJson<{ providers?: Provider[] }>(CATALOGUE_CACHE())
  return Array.isArray(data?.providers) ? data.providers : []
}

/** How long ago the catalogue was fetched, in milliseconds, or null when it has
 *  never been fetched at all. What the boot refresh decides on, and what the
 *  Providers surface needs to tell "this machine has no catalogue" apart from
 *  "your search matched nothing" — two empty lists with nothing else to
 *  distinguish them, and completely different things to do about it. */
export async function catalogueAge(): Promise<number | null> {
  const data = await readHoshiJson<{ refreshedAt?: string }>(CATALOGUE_CACHE())
  const at = data?.refreshedAt ? Date.parse(data.refreshedAt) : NaN
  return Number.isFinite(at) ? Date.now() - at : null
}

/** Pull models.dev and cache it. Best-effort by contract: the caller is a boot
 *  plugin and a manual refresh, and a machine whose egress is blocked must keep
 *  working on its custom providers alone. */
export async function refreshCatalogue(): Promise<{ providers: number }> {
  const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`the model catalogue answered ${res.status}`)
  const body = (await res.json()) as Record<string, Record<string, unknown>>

  const providers: Provider[] = []
  for (const [id, raw] of Object.entries(body ?? {})) {
    if (!raw || typeof raw !== 'object') continue
    const env = Array.isArray(raw.env) ? raw.env.filter((e): e is string => typeof e === 'string') : []
    const models = Object.values((raw.models ?? {}) as Record<string, unknown>)
      .map(normalizeModel)
      .filter((m): m is ProviderModel => !!m)
    if (models.length === 0) continue
    providers.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      /**
       *
       * The catalogue's own `api` field — where requests to this provider go.
       * Dropped here once, and the consequence was total: every catalogue
       * provider connected, listed its models, and then failed the turn with
       * "has no endpoint configured on this machine yet", because a provider
       * with no address is one the engine cannot build a model for. It was
       * invisible only because nothing fetched the catalogue at all.
       *
       **/
      baseUrl: typeof raw.api === 'string' && raw.api ? raw.api : null,
      keyEnvVar: env[0] ?? null,
      keyless: false,
      source: 'catalogue',
      models,
      policyBlocked: false,
    })
  }
  await writeHoshiJson(CATALOGUE_CACHE(), { providers, refreshedAt: new Date().toISOString() })
  publishMachineEvent('providers.updated', { count: providers.length })
  return { providers: providers.length }
}

/** Every provider this machine may use. A custom definition WINS over a
 *  catalogue entry of the same id: the machine's own file is the more specific
 *  statement (a self-hosted endpoint standing in for a hosted one).
 *
 *  On an ORG-LINKED machine the org's allow-list applies, enforced at the
 *  source rather than by whoever remembers to filter downstream. A machine with
 *  no Platform behind it (local dev) is unrestricted, which is what
 *  `resolveAllowedProviders` returning null means.
 *
 *  What "applies" means depends on whose statement the entry is. A CATALOGUE or
 *  RELAY entry the org did not approve does not exist here — it is one of six
 *  thousand things the machine could offer and does not. A CUSTOM one is a
 *  connection this machine's user made, and dropping it silently is what turned
 *  "provider added, four models found" into a provider that was gone a second
 *  later with nothing to read. Those stay, marked `policyBlocked` and stripped
 *  of every model, so the configuration is inspectable and none of it is
 *  runnable — `listModels` and `resolveModel` both read the models list, so a
 *  provider with none cannot be selected in a picker or invoked by a turn.
 *
 *  `includeBlocked` is for the ONE surface that is about what could be
 *  connected rather than what is: the connect picker. Without it a founder
 *  whose brand-new organization allows nothing cannot see Anthropic in order to
 *  ask for it — the provider they want is filtered out of the only screen that
 *  offers a way to want it, and the product's answer to "connect your own AI"
 *  is an empty list. Everything else — the model listing, the import offers,
 *  the model a turn resolves — takes the default and sees only what may run. */
export async function listProviders(options: { includeBlocked?: boolean } = {}): Promise<Provider[]> {
  const custom = await readCustomProviders()
  const ids = new Set(custom.map((provider) => provider.id))
  /**
   *
   * Tunnelled providers slot between the two: the person's own file is still
   * the more specific statement (a custom definition shadows a relay one of
   * the same id), and a relay entry standing in for a catalogue id behaves the
   * way the org overlay above it always has.
   *
   **/
  const relay = (await readRelayProviders()).filter((provider) => !ids.has(provider.id))
  for (const provider of relay) ids.add(provider.id)
  const all = [...custom, ...relay, ...(await readCatalogue()).filter((provider) => !ids.has(provider.id))]

  const allowed = await resolveAllowedProviders()
  if (!allowed) return all

  const org = new Map((await readOrgProviderSnapshot()).map((entry) => [entry.providerId, entry]))
  const overlaid = all
    .filter((provider) => allowed.has(provider.id) || provider.source === 'custom' || options.includeBlocked)
    .map((provider) => {
      /**
       *
       * The machine's own definition, withdrawn by policy. Kept, emptied and
       * labelled — see this function's header for why the two kinds of entry
       * are treated differently.
       *
       **/
      if (!allowed.has(provider.id)) return { ...provider, models: [], policyBlocked: true }
      const entry = org.get(provider.id)
      if (!entry) return provider
      /**
       *
       * The org may point a provider somewhere else — a self-hosted endpoint
       * standing in for a hosted one — and name it accordingly. A machine's own
       * custom definition still wins, since it is the more specific statement.
       * A RELAY provider's address is untouchable too, for a harder reason: its
       * baseUrl is this machine's own loopback forwarder, and an org override
       * would re-point the tunnel at an address the tunnel does not serve.
       *
       **/
      const overridden = {
        ...provider,
        ...(entry.name && provider.source === 'catalogue' ? { name: entry.name } : {}),
        ...(entry.baseUrl && provider.source === 'catalogue' ? { baseUrl: entry.baseUrl } : {}),
      }
      /**
       *
       * Within an approved provider the org may also curate WHICH models are
       * offered; an empty curation means "all of them".
       *
       **/
      if (!entry.models || entry.models.length === 0) return overridden
      const keep = new Set(entry.models)
      return { ...overridden, models: overridden.models.filter((model) => keep.has(model.id)) }
    })

  return overlaid
}

/** What the organization has that this machine has not taken yet.
 *
 *  Offered rather than applied. An org provider is a suggestion with an address
 *  and a name already filled in — the person still decides that this machine
 *  talks to it, and the moment they do it becomes the machine's own definition
 *  (`custom`), editable and removable here like any other. Inheriting it
 *  silently would put endpoints on a machine that its user never chose and
 *  cannot see the origin of.
 *
 *  Entries the machine already has are not listed — and "has" means every
 *  source, not only its own file. An org entry for a CATALOGUE provider is not
 *  an offer: the catalogue already defines it here, and the org's name, address
 *  and curation reach it as the overlay above. Offering it anyway listed
 *  `github-copilot` twice in the picker, and taking the offer failed on the
 *  address the org never had to set, because the catalogue's own is the one
 *  that applies. What is left to offer is what nothing here describes — the
 *  org's self-hosted runtime, which is what the offer was for — and an entry
 *  with no address is not that either, since importing is adding by address. */
export async function importableProviders(): Promise<
  Array<{ id: string; name: string; baseUrl: string; keyEnvVar: string | null; orgKey: boolean }>
> {
  const known = new Set((await listProviders()).map((provider) => provider.id))
  return (await readOrgProviderSnapshot())
    .filter((entry) => !known.has(entry.providerId) && !!entry.baseUrl)
    .map((entry) => ({
      id: entry.providerId,
      name: entry.name ?? entry.providerId,
      baseUrl: entry.baseUrl!,
      keyEnvVar: entry.keyEnvVar || null,
      orgKey: entry.orgKey,
    }))
}

export class ProviderExistsError extends Error {}
export class ProviderUnreachableError extends Error {}
/** The organization's provider policy does not list this provider. Its own
 *  class because it is the one refusal here that is not about the endpoint: the
 *  address may be perfect and the credential valid, and the answer is still no
 *  until somebody holding `providers.manage` says otherwise. */
export class ProviderNotAllowedError extends Error {}
/** No such provider on this machine — as distinct from one that is here and
 *  cannot be reached, which is `ProviderUnreachableError`. */
export class ProviderUnknownError extends Error {}

/** Add a provider to this machine.
 *
 *  `models` is optional and usually absent, because the person adding a
 *  self-hosted runtime knows its address and not its model list — so the
 *  endpoint is asked (engine/provider-discovery.ts). Refusing when nothing
 *  answers is deliberate: a provider saved with no models is a row in every
 *  picker that can never be picked, and the failure it hides (wrong port, not
 *  running, no `/v1`) is easiest to fix in the second the address was typed. */
export async function addCustomProvider(input: {
  id: string
  name?: string | null
  baseUrl: string
  keyEnvVar?: string | null
  models?: string[] | null
}): Promise<Provider> {
  /**
   *
   * Strict: this is a read-modify-write, and the write below replaces the file
   * wholesale. A corrupt file read as `null` would look like "no providers
   * yet", pass the duplicate-id check, and then overwrite every provider the
   * user had with just this one. Refusing is the only safe answer — the file
   * is meant to be hand-editable, so a typo in it must cost the edit, not the
   * library.
   *
   **/
  /**
   *
   * Policy first, before the endpoint is even contacted.
   *
   * This used to be checked nowhere: the provider was discovered, written to
   * `providers.json` and answered with a 201 carrying its models, and then
   * `listProviders` — which has always applied the allow-list — hid it on the
   * very next read. What a person saw was "connected, four models found"
   * followed by a provider that was not there, and the only way out was to add
   * the id to the organization through an API this screen does not mention.
   *
   * Refusing here rather than filtering later is what keeps the failure
   * legible AND keeps the file honest: nothing unusable is saved, so there is
   * no half-made connection to explain afterwards.
   *
   **/
  const allowed = await resolveAllowedProviders()
  if (allowed && !allowed.has(input.id)) {
    throw new ProviderNotAllowedError(
      `Your organization's provider policy does not include "${input.id}", so this machine cannot use it yet.`,
    )
  }

  const data = await readHoshiJsonStrict<CustomFile>(CUSTOM_FILE())
  const existing = data?.providers ?? []
  if (existing.some((provider) => provider.id === input.id)) {
    throw new ProviderExistsError(`This machine already has a provider called "${input.id}".`)
  }

  const key = input.keyEnvVar ? await readSecretValue(input.keyEnvVar) : null
  const discovered = await discoverProvider(input.baseUrl, key)
  if (!discovered) {
    throw new ProviderUnreachableError(
      `Nothing at ${input.baseUrl} answered with a list of models. Check the address, and that it is running.`,
    )
  }

  const curated = input.models && input.models.length > 0 ? new Set(input.models) : null
  const models = curated ? discovered.models.filter((model) => curated.has(model.id)) : discovered.models
  const provider: Provider = {
    id: input.id,
    name: input.name || input.id,
    baseUrl: input.baseUrl,
    keyEnvVar: input.keyEnvVar || null,
    keyless: discovered.keyless,
    source: 'custom',
    models,
    policyBlocked: false,
  }
  /**
   *
   * Stored as the file's own shape (`limit.context`, `cost.*`), so a
   * hand-edited entry and a discovered one are the same thing on disk — the
   * point of this file is that a person can read and fix it.
   *
   **/
  await writeHoshiJson(CUSTOM_FILE(), {
    providers: [
      ...existing,
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        keyEnvVar: provider.keyEnvVar,
        keyless: provider.keyless,
        models: models.map((model) => ({ id: model.id, name: model.name, limit: { context: model.contextLimit } })),
      },
    ],
  })
  publishMachineEvent('provider.updated', { providerId: provider.id })
  return provider
}

/** Remove a provider this machine defines. Returns false when it defines no
 *  such provider — a catalogue entry is not this machine's to delete. */
export async function removeCustomProvider(providerId: string): Promise<boolean> {
  const data = await readHoshiJson<CustomFile>(CUSTOM_FILE())
  const existing = data?.providers ?? []
  const next = existing.filter((provider) => provider.id !== providerId)
  if (next.length === existing.length) return false
  await writeHoshiJson(CUSTOM_FILE(), { providers: next })
  publishMachineEvent('provider.updated', { providerId })
  return true
}

/** Providers with live credential state. Read fresh from the vault every call —
 *  see the header: this is what makes a key take effect the moment it is saved. */
export async function listProviderStatuses(options: { includeBlocked?: boolean } = {}): Promise<ProviderStatus[]> {
  const vaultKeys = new Set((await listSecrets()).map((secret) => secret.key))
  return (await listProviders(options)).map((provider) => ({
    ...provider,
    connected: provider.keyless || (!!provider.keyEnvVar && vaultKeys.has(provider.keyEnvVar)),
    login: providerLogin(provider.id),
  }))
}

export interface ModelSummary {
  providerID: string
  providerName: string
  modelID: string
  name: string
  contextLimit: number
  free: boolean
  /** The provider is known but has no credential yet — selecting this model
   *  needs a key first, and this is the vault key to write it to. */
  needsKey: boolean
  keyEnvVar: string | null
  /** Whether this model reasons; null when the catalogue does not say. */
  reasoning: boolean | null
  /** How its reasoning is controlled: named levels, an on/off toggle, or a
   *  token budget. Null when the catalogue does not say. */
  reasoningMode: 'effort' | 'toggle' | 'budget' | null
  /** The effort levels it publishes, verbatim; null unless mode is `effort`. */
  reasoningEfforts: string[] | null
  /** The smallest budget it accepts; null unless mode is `budget`. */
  reasoningBudgetMin: number | null
}

/** Every model on the machine, connected or not. Unconnected ones ride along
 *  with `needsKey` rather than being hidden: a picker that silently omits them
 *  gives the user no way to discover what they could connect. */
export async function listModels(): Promise<ModelSummary[]> {
  const providers = await listProviderStatuses()
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerID: provider.id,
      providerName: provider.name,
      modelID: model.id,
      name: model.name,
      contextLimit: model.contextLimit,
      free: model.inputCost === 0 && model.outputCost === 0,
      needsKey: !provider.connected,
      keyEnvVar: provider.keyEnvVar,
      /**
       *
       * Carried to the client so the composer can offer THIS model's thinking
       * levels rather than a list of its own — and offer none at all for a
       * model that does not reason.
       *
       **/
      reasoning: model.reasoning,
      reasoningMode: model.reasoningMode,
      reasoningEfforts: model.reasoningEfforts,
      reasoningBudgetMin: model.reasoningBudgetMin,
    })),
  )
}

/** Ask a custom provider's endpoint what it has, now, and store the answer.
 *
 *  The refresh button behind Customize → AI providers. A custom provider keeps
 *  its model list in `providers.json` — written once, when it was connected —
 *  so a model loaded into a local runtime since then is invisible, and a list
 *  that was captured before the endpoint published context lengths keeps
 *  reporting zero forever. Clearing a cache is not enough for that: the stale
 *  answer is on disk.
 *
 *  Only the models are replaced. Name, address and credential are the person's
 *  settings, not the endpoint's to change. */
export async function refreshProviderModels(id: string): Promise<ProviderStatus | null> {
  const data = await readHoshiJson<CustomFile>(CUSTOM_FILE())
  const stored = (data?.providers ?? []).find((provider) => provider.id === id)
  if (!stored?.baseUrl) return (await listProviderStatuses()).find((provider) => provider.id === id) ?? null

  clearDiscoveryCache()
  const key = stored.keyEnvVar ? await readSecretValue(stored.keyEnvVar) : null
  const discovered = await discoverProvider(stored.baseUrl, key)
  if (!discovered) {
    throw new ProviderUnreachableError(
      `Nothing at ${stored.baseUrl} answered with a list of models. Check the address, and that it is running.`,
    )
  }

  await writeHoshiJson(CUSTOM_FILE(), {
    providers: (data?.providers ?? []).map((provider) =>
      provider.id === id
        ? {
            ...provider,
            models: discovered.models.map((model) => ({
              id: model.id,
              name: model.name,
              limit: { context: model.contextLimit },
            })),
          }
        : provider,
    ),
  })
  publishMachineEvent('provider.updated', { providerId: id })
  return (await listProviderStatuses()).find((provider) => provider.id === id) ?? null
}

/** What an explicitly requested connection check found. `checkedAt` is what
 *  lets a surface say "tested" rather than "saved" — and its absence is what
 *  keeps it from saying either. */
export interface ProviderCheck {
  providerId: string
  outcome: ProviderProbe['outcome']
  /** The model a billable probe was run against, when one was. Null otherwise —
   *  including when the caller asked for one and the cheap probe already
   *  answered, which is the common case and must not be reported as a charge. */
  billedModel: string | null
  /** The provider's own words, when it had any worth repeating. */
  detail: string | null
}

/**
 * ── Testing a provider, on purpose ───────────────────────────────────────────
 *
 * `connected` on a provider means the vault holds a credential. That is all it
 * has ever meant, and it is not what anybody reads it as — a mistyped key, a
 * revoked one and a working one were indistinguishable until the first turn
 * failed, which is the worst moment to find out and the one place the failure
 * reads as the agent being broken.
 *
 * This is the other question, asked only when somebody asks it. It probes the
 * model listing the way a turn authenticates (Bearer, per kernel/model.ts), and
 * `untested` is a real answer rather than a polite pass: an endpoint that lists
 * models to nobody has said nothing about this key.
 *
 * `allowBillable` is the caller's authorization to settle an `untested` with a
 * single one-token completion. It is never assumed, never retried, and never
 * reached at all unless the cheap probe came back inconclusive — so asking for
 * it does not mean paying for it.
 *
 **/
export async function checkProvider(
  providerId: string,
  options: { allowBillable?: boolean } = {},
): Promise<ProviderCheck> {
  const provider = (await listProviderStatuses()).find((entry) => entry.id === providerId)
  if (!provider) throw new ProviderUnknownError(`This machine does not know a provider called "${providerId}".`)
  if (provider.policyBlocked) {
    throw new ProviderNotAllowedError(
      `Your organization's provider policy does not include "${providerId}", so there is nothing to test yet.`,
    )
  }
  if (!provider.baseUrl) {
    throw new ProviderUnreachableError(`${provider.name} has no endpoint configured on this machine.`)
  }

  const key = provider.keyEnvVar ? await readSecretValue(provider.keyEnvVar) : null
  const probe = await probeProvider(provider.baseUrl, key)

  /**
   *
   * A keyless provider that answered IS the whole test: there is no credential
   * to exercise, so `untested` would be reporting a missing proof of something
   * that does not exist.
   *
   **/
  if (probe.outcome === 'untested' && (provider.keyless || !key)) {
    return { providerId, outcome: 'ok', billedModel: null, detail: null }
  }

  if (probe.outcome !== 'untested' || !options.allowBillable || !key) {
    return { providerId, outcome: probe.outcome, billedModel: null, detail: detailFor(probe) }
  }

  /**
   *
   * The endpoint lists models to anybody, so only a real request can say
   * whether this key is one it accepts. One token, on the cheapest thing we
   * can name — the first model it offers, which for a provider like this is
   * the one it advertises.
   *
   **/
  const model = provider.models[0]?.id
  if (!model) return { providerId, outcome: 'untested', billedModel: null, detail: detailFor(probe) }
  const billed = await probeCompletion(provider.baseUrl, key, model)
  return { providerId, outcome: billed.outcome, billedModel: model, detail: detailFor(billed) }
}

function detailFor(probe: ProviderProbe): string | null {
  if (probe.outcome === 'auth') return `The provider answered ${probe.status}.`
  return null
}

/** Resolve a `provider/model` reference to something a turn can be run with.
 *  Null when the provider is unknown, the model is not one of its own, or there
 *  is no credential — three different reasons a turn cannot start, all of which
 *  the caller has to report differently, so the caller asks again rather than
 *  this guessing. */
export async function resolveModel(ref: string): Promise<{ provider: ProviderStatus; model: ProviderModel } | null> {
  const [providerId, ...rest] = ref.split('/')
  const modelId = rest.join('/')
  if (!providerId || !modelId) return null
  const provider = (await listProviderStatuses()).find((entry) => entry.id === providerId)
  const model = provider?.models.find((entry) => entry.id === modelId)
  return provider && model ? { provider, model } : null
}

/** Remove THIS machine's credential for a provider: the vault key goes, and an
 *  org-supplied key then re-seeds on the spot — so "disconnect" on an
 *  org-keyed provider reads as "revert to the org key", which is the honest
 *  description of what happens.
 *
 *  Nothing else to clear. The old runtime kept a second credential store of its
 *  own beside the vault, and disconnecting had to empty both and then cycle the
 *  runtime so its model catalogue stopped advertising a provider it could no
 *  longer reach. The vault is the only place a credential lives now, and it is
 *  read at the moment a model is built. */
export async function disconnectProvider(providerId: string): Promise<void> {
  const provider = (await listProviders()).find((entry) => entry.id === providerId)
  const org = (await readOrgProviderSnapshot()).find((entry) => entry.providerId === providerId)
  const envVar = org?.keyEnvVar ?? provider?.keyEnvVar
  if (envVar) await deleteSecret(envVar).catch(() => undefined)
  if (org?.orgKey) await syncOrgDefaultsOnce().catch(() => undefined)
  publishMachineEvent('provider.updated', { providerId })
}
