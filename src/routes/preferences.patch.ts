import { defineEventHandler } from 'h3'
import { apiError, requireAuth, isReasoningEffort, type ReasoningEffort, readJsonBody } from '../kernel/index.js'
import {
  setPreferences,
  getPreferences,
  parseAgent,
  parseHiddenModels,
  parseModel,
  CI_MAX_ATTEMPTS_MAX,
  CI_MAX_ATTEMPTS_MIN,
  SHARE_POLICIES,
  AUTOUPDATE_POLICIES,
  type Preferences,
  type SharePolicy,
  type AutoUpdatePolicy,
} from '../kernel/index.js'

/** Update this machine's OpenCode defaults. Merge semantics — only the provided
 *  fields are written. Model fields accept a `providerID/modelID` string or null
 *  to clear back to OpenCode's built-in default. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    model?: unknown
    smallModel?: unknown
    heavyModel?: unknown
    defaultAgent?: unknown
    reasoningEffort?: unknown
    share?: unknown
    autoupdate?: unknown
    hiddenModels?: unknown
    ciFix?: unknown
    ciMaxAttempts?: unknown
  }>(event)

  const patch: Partial<Preferences> = {}

  if ('model' in body) patch.model = parseModel(body.model, 'model')
  if ('smallModel' in body) patch.smallModel = parseModel(body.smallModel, 'smallModel')
  if ('heavyModel' in body) patch.heavyModel = parseModel(body.heavyModel, 'heavyModel')
  if ('defaultAgent' in body) patch.defaultAgent = parseAgent(body.defaultAgent)
  if ('reasoningEffort' in body) {
    if (!isReasoningEffort(body.reasoningEffort)) {
      apiError(
        400,
        'preferences.invalidEffort',
        'reasoningEffort must be a level name — lowercase letters, digits, dashes.',
      )
    }
    patch.reasoningEffort = body.reasoningEffort as ReasoningEffort
  }
  if ('hiddenModels' in body) patch.hiddenModels = parseHiddenModels(body.hiddenModels)
  if ('ciFix' in body) {
    if (typeof body.ciFix !== 'boolean') {
      apiError(400, 'preferences.invalidCiFix', 'ciFix must be a boolean.')
    }
    patch.ciFix = body.ciFix as boolean
  }
  if ('ciMaxAttempts' in body) {
    const value = body.ciMaxAttempts
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < CI_MAX_ATTEMPTS_MIN ||
      value > CI_MAX_ATTEMPTS_MAX
    ) {
      apiError(
        400,
        'preferences.invalidCiMaxAttempts',
        `ciMaxAttempts must be an integer between ${CI_MAX_ATTEMPTS_MIN} and ${CI_MAX_ATTEMPTS_MAX}.`,
        { min: CI_MAX_ATTEMPTS_MIN, max: CI_MAX_ATTEMPTS_MAX },
      )
    }
    patch.ciMaxAttempts = value as number
  }
  if (body.share !== undefined) {
    if (!SHARE_POLICIES.includes(body.share as SharePolicy)) {
      apiError(400, 'preferences.invalidShare', 'share must be manual, auto, or disabled.')
    }
    patch.share = body.share as SharePolicy
  }
  if (body.autoupdate !== undefined) {
    if (!AUTOUPDATE_POLICIES.includes(body.autoupdate as AutoUpdatePolicy)) {
      apiError(400, 'preferences.invalidAutoupdate', 'autoupdate must be auto, notify, or off.')
    }
    patch.autoupdate = body.autoupdate as AutoUpdatePolicy
  }

  if (Object.keys(patch).length === 0) {
    apiError(400, 'request.nothingToUpdate', 'Nothing to update.')
  }

  /**
   *
   * The read-back is the canonical echo: a save is a file write the engine
   * reads on its next turn, so what comes back is already in force. There is no
   * parked state to report — the runtime a config write used to dispose is gone.
   *
   **/
  await setPreferences(patch)
  return { preferences: await getPreferences() }
})
