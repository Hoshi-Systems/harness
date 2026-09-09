import { defineEventHandler } from 'h3'
import {
  apiError,
  publishMachineState,
  requireAuth,
  readJsonBody,
  isValidSecretKey,
  SECRET_KEY_RULE,
  setSecret,
  validateSecretValue,
} from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ key?: unknown; value?: unknown }>(event)

  if (typeof body.key !== 'string' || !isValidSecretKey(body.key.trim())) {
    apiError(400, 'secret.invalidKey', SECRET_KEY_RULE)
  }
  const value = validateSecretValue(body.value)

  const secret = await setSecret(body.key.trim(), value)
  /**
   *
   * A vault key IS a provider credential: writing one can be the moment this
   * machine becomes able to take a turn, and `machine.state.ready` is what
   * every composer gates on.
   *
   **/
  await publishMachineState()
  return { secret }
})
