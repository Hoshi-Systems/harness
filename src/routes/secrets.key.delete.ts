import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, publishMachineState, requireAuth, deleteSecret } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const key = getRouterParam(event, 'key')!
  if (!(await deleteSecret(key))) {
    apiError(404, 'secret.notFound', 'Secret not found.')
  }
  /**
   *
   * Deleting one can take the machine's last usable provider with it.
   *
   **/
  await publishMachineState()
  return { ok: true }
})
