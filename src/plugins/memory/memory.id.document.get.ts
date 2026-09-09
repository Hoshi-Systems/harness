import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { parseMemoryId, readEntry, readOrgDocument } from './store.js'

/** The long-form markdown attached to an org knowledge entry. Split from the
 *  entry GET on purpose: a handbook can be tens of kilobytes, and the list and
 *  detail views both work fine knowing only that one exists. Only org entries
 *  ever have one — user and project memory is short facts by design. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const parsed = parseMemoryId(id)
  if (!parsed) apiError(400, 'memory.invalidId', 'Malformed memory id.')
  if (parsed.scope !== 'org') {
    apiError(400, 'memory.noDocument', 'Only organization knowledge entries can carry a document.')
  }

  const record = await readEntry('org', null, parsed.name)
  if (!record) apiError(404, 'memory.notFound', 'Memory entry not found.')
  const document = await readOrgDocument(parsed.name)
  if (document === null) apiError(404, 'memory.documentNotFound', 'That entry has no document attached.')

  return { document }
})
