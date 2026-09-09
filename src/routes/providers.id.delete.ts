import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, publishMachineState, apiError, removeCustomProvider } from '../kernel/index.js'

/** Remove a provider this machine defines.
 *
 *  Only its own: a catalogue entry is not the machine's to delete, and an
 *  organization's is not either — 404 says so rather than pretending to have
 *  removed something that will still be there on the next listing. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await removeCustomProvider(id))) {
    apiError(404, 'provider.notDefinedHere', 'This machine does not define that provider.')
  }
  await publishMachineState()
  return { removed: true }
})
