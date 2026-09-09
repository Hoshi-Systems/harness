import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody, secretExists, setSecret, validateSecretValue } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const key = getRouterParam(event, 'key')!
  if (!(await secretExists(key))) {
    apiError(404, 'secret.notFound', 'Secret not found.')
  }

  const body = await readJsonBody<{ value?: unknown }>(event)
  const value = validateSecretValue(body.value)

  return { secret: await setSecret(key, value) }
})
