import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, listProviderStatuses } from '../kernel/index.js'

/** Every AI provider this machine knows about, with live credential state.
 *  `connected` is computed from the vault on every call — a key saved a second
 *  ago is usable now (docs/MACHINE_WIRE.md, R6).
 *
 *  `?all=1` also returns the ones the organization's policy excludes, each
 *  marked `policyBlocked`. Same distinction `/models?all=1` draws, for the same
 *  reason: the default answer is what this machine can use, and the surface
 *  whose subject is what could be CONNECTED needs the other one. A machine
 *  whose organization has approved nothing yet — every brand-new organization —
 *  otherwise offers an empty picker to the person trying to connect their own
 *  provider, with no way from there to ask for it. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const all = getQuery(event).all
  return { providers: await listProviderStatuses({ includeBlocked: all === '1' || all === 'true' }) }
})
