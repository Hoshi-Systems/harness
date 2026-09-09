import { defineEventHandler } from 'h3'
import { requireAuth, importableProviders } from '../kernel/index.js'

/** Providers the organization has configured that this machine has not taken
 *  yet — an offer, with the address and name already filled in.
 *
 *  Offered rather than applied: a machine's provider list is what its user
 *  chose. Importing one (POST /providers with these values) writes it as this
 *  machine's own definition, editable and removable here afterwards. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { providers: await importableProviders() }
})
