import { isReasoningEffort, type ReasoningEffort } from './reasoning.js'
import { apiError } from './api-error.js'
import { isConfigKey } from './config-key.js'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'

/**
 *
 * Machine-wide defaults, all of them in ~/.hoshi/preferences.json.
 *
 * They used to live in TWO stores: model, small_model, share and autoupdate
 * were top-level keys in the old runtime's global config, and everything Hoshi
 * invented had to go somewhere else because that config rejected foreign keys.
 * One store is the whole simplification — and it is what the task router reads
 * for its model tiers.
 *
 **/

/** A function, not a constant, for the same reason every other store here is
 *  one (kernel/store.ts): `hoshiFile` reads HOME, and a path resolved at module
 *  load pins this file to whatever HOME was when the first import ran. */
const HOSHI_PREFERENCES_FILE = () => hoshiFile('preferences.json')

export type SharePolicy = 'manual' | 'auto' | 'disabled'
export type AutoUpdatePolicy = 'auto' | 'notify' | 'off'

export interface Preferences {
  /** Default model for new sessions, as `providerID/modelID` (null = OpenCode's own default). */
  model: string | null
  /** Model used for lightweight tasks like title generation, as `providerID/modelID`. */
  smallModel: string | null
  /** Model for heavy-tier delegated work (architecture, large refactors), as
   *  `providerID/modelID`; null falls back to the default model (Phase 3 routing). */
  heavyModel: string | null
  /** Agent new sessions start on; null = OpenCode's own default (`build`). */
  defaultAgent: string | null
  /** How hard models think when a send does not say (engine/reasoning.ts).
   *  `auto` — the default — sends nothing and leaves it to the provider. */
  reasoningEffort: ReasoningEffort
  /** How sessions are shared to a public read-only URL. */
  share: SharePolicy
  /** How the OpenCode runtime keeps itself up to date. */
  autoupdate: AutoUpdatePolicy
  /** Model ids (`providerID/modelID`) the user chose to hide from the chat
   *  composer's model picker (CYB-102) — a Hoshi-native curation layer on top
   *  of the full catalog. Purely cosmetic: an already-selected session model
   *  keeps working even after it's hidden, and the machine's own default/small/
   *  heavy-model preferences below are unaffected — this only prunes the
   *  composer's picker options. */
  hiddenModels: string[]
  /** Whether a failed check on a pull request this machine opened starts an
   *  unattended fix run (job 14). ON by default: the feature is invisible when
   *  off, and the caps below plus the loop's own guards are what make it safe. */
  ciFix: boolean
  /** How many code-fix attempts one pull request gets before the loop escalates
   *  to the human and stops. Never unbounded — "never loop" is the rule. */
  ciMaxAttempts: number
}

/** The fix-attempt cap's bounds. One is a legitimate choice (try once, then
 *  tell me); above three the loop stops being a safety net and starts being a
 *  way to spend a budget on a failure it cannot see. */
export const CI_MAX_ATTEMPTS_MIN = 1
export const CI_MAX_ATTEMPTS_MAX = 3
const CI_MAX_ATTEMPTS_DEFAULT = 2

/** Accepted values for each policy preference — shared by the read path's coercion
 *  and the write route's validation so the two can never drift apart. */
export const SHARE_POLICIES: SharePolicy[] = ['manual', 'auto', 'disabled']
export const AUTOUPDATE_POLICIES: AutoUpdatePolicy[] = ['auto', 'notify', 'off']

/** The raw Hoshi-native preferences blob, {} when missing/unreadable. */
async function readHoshiPreferences(): Promise<Record<string, unknown>> {
  return (await readHoshiJson<Record<string, unknown>>(HOSHI_PREFERENCES_FILE())) ?? {}
}

/** Merge a partial into ~/.hoshi/preferences.json. Null values delete their key. */
async function writeHoshiPreferences(
  patch: Record<string, string | number | boolean | string[] | null>,
): Promise<void> {
  const current = await readHoshiPreferences()
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key]
    else current[key] = value
  }
  await writeHoshiJson(HOSHI_PREFERENCES_FILE(), current)
}

/** Read the machine's current preference values — OpenCode-native ones from
 *  its global config, Hoshi-native ones from ~/.hoshi/preferences.json.
 *  Missing keys fall back to the defaults (manual sharing, auto-update on). */
export async function getPreferences(): Promise<Preferences> {
  const hoshi = await readHoshiPreferences()
  const share = SHARE_POLICIES.includes(hoshi.share as SharePolicy) ? (hoshi.share as SharePolicy) : 'manual'
  const autoupdate = AUTOUPDATE_POLICIES.includes(hoshi.autoupdate as AutoUpdatePolicy)
    ? (hoshi.autoupdate as AutoUpdatePolicy)
    : 'auto'
  return {
    model: typeof hoshi.model === 'string' && hoshi.model ? hoshi.model : null,
    smallModel: typeof hoshi.smallModel === 'string' && hoshi.smallModel ? hoshi.smallModel : null,
    heavyModel: typeof hoshi.heavyModel === 'string' && hoshi.heavyModel ? hoshi.heavyModel : null,
    defaultAgent: typeof hoshi.defaultAgent === 'string' && hoshi.defaultAgent ? hoshi.defaultAgent : null,
    reasoningEffort: isReasoningEffort(hoshi.reasoningEffort) ? hoshi.reasoningEffort : 'auto',
    share,
    autoupdate,
    hiddenModels: Array.isArray(hoshi.hiddenModels)
      ? hoshi.hiddenModels.filter((m): m is string => typeof m === 'string')
      : [],
    /**
     *
     * Absent means ON — a machine provisioned before job 14 gets the feature
     * rather than a silently disabled one, which is the whole point of shipping
     * it on by default.
     *
     **/
    ciFix: hoshi.ciFix !== false,
    ciMaxAttempts: clampAttempts(hoshi.ciMaxAttempts),
  }
}

function clampAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CI_MAX_ATTEMPTS_DEFAULT
  return Math.min(CI_MAX_ATTEMPTS_MAX, Math.max(CI_MAX_ATTEMPTS_MIN, Math.round(value)))
}

/** Merge a partial preferences update into the machine's own store.
 *
 *  EVERY preference lives in ~/.hoshi/preferences.json now. Four of them —
 *  model, smallModel, share, autoupdate — used to be written into the runtime's
 *  global config instead, which is why this function carried a whole apparatus:
 *  drop no-op keys, park a mid-turn write, and report whether it was parked. A
 *  config write disposed the runtime and aborted every generation on the
 *  machine, so saving a setting could cost the user their work.
 *
 *  Nothing here reaches a running turn. The engine reads a preference when it
 *  needs one, so a save is a file write that applies to the next turn — which
 *  is why this returns nothing at all. */
export async function setPreferences(patch: Partial<Preferences>): Promise<void> {
  const hoshi: Record<string, string | number | boolean | string[] | null> = {}
  if ('heavyModel' in patch) hoshi.heavyModel = patch.heavyModel ?? null
  if ('defaultAgent' in patch) hoshi.defaultAgent = patch.defaultAgent ?? null
  /**
   *
   * `auto` is the absence of a choice, so it deletes the key rather than
   * storing the word — a machine whose file says nothing and one set back to
   * auto are the same machine, and should read back the same.
   *
   **/
  if ('reasoningEffort' in patch)
    hoshi.reasoningEffort = patch.reasoningEffort && patch.reasoningEffort !== 'auto' ? patch.reasoningEffort : null
  if ('hiddenModels' in patch)
    hoshi.hiddenModels = patch.hiddenModels && patch.hiddenModels.length > 0 ? patch.hiddenModels : null
  /**
   *
   * Written as `false`, never deleted: absence means ON (see getPreferences),
   * so deleting the key would silently re-enable the loop the user just
   * switched off.
   *
   **/
  if ('ciFix' in patch) hoshi.ciFix = patch.ciFix === true
  if ('ciMaxAttempts' in patch) hoshi.ciMaxAttempts = clampAttempts(patch.ciMaxAttempts)

  if ('model' in patch) hoshi.model = patch.model ?? null
  if ('smallModel' in patch) hoshi.smallModel = patch.smallModel ?? null
  if (patch.share) hoshi.share = patch.share
  if (patch.autoupdate) hoshi.autoupdate = patch.autoupdate

  if (Object.keys(hoshi).length > 0) await writeHoshiPreferences(hoshi)
}

/** A model field is either `providerID/modelID`, or null/'' to clear it. */
export function parseModel(value: unknown, field: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !value.includes('/')) {
    apiError(400, 'preferences.invalidModel', `${field} must be a "provider/model" string.`, { field })
  }
  return value
}

/** The default agent is an agent name (config-key slug), or null/'' to clear
 *  back to OpenCode's own default. */
export function parseAgent(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !isConfigKey(value)) {
    apiError(400, 'preferences.invalidAgent', 'defaultAgent must be an agent name (lowercase letters, digits, dashes).')
  }
  return value
}

/** The hidden-models list (CYB-102 model filtering) is an array of
 *  `providerID/modelID` strings — deduplicated, everything else rejected. */
export function parseHiddenModels(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.includes('/'))) {
    apiError(400, 'preferences.invalidHiddenModels', 'hiddenModels must be an array of "provider/model" strings.')
  }
  return [...new Set(value as string[])]
}
