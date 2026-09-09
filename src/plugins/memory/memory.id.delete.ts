import { forgetEntry } from './writes.js'
import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { OrgMemoryReadOnlyError, parseMemoryId } from './store.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const parsed = parseMemoryId(id)
  if (!parsed) apiError(400, 'memory.invalidId', 'Malformed memory id.')

  /**
   *
   * Org knowledge is curated on the Platform and mirrored here read-only, so
   * there is nothing local to delete — say why rather than 404-ing on a file
   * that is plainly right there.
   *
   **/
  const found = await forgetEntry(parsed.scope, parsed.project, parsed.name).catch((error: unknown) => {
    if (error instanceof OrgMemoryReadOnlyError) apiError(403, 'memory.orgReadOnly', error.message)
    throw error
  })
  if (!found) apiError(404, 'memory.notFound', 'Memory entry not found.')

  return { ok: true }
})
