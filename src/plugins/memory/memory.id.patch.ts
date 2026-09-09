import { saveEntry } from './writes.js'
import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { MEMORY_KINDS, memoryId, OrgMemoryReadOnlyError, parseMemoryId, readEntry, type MemoryKind } from './store.js'

const MAX_DESCRIPTION = 200
const MAX_CONTENT = 8000

/** Edit an existing entry's description/kind/content. The id — and therefore
 *  scope/project/name — is fixed; renaming isn't supported (delete + re-add
 *  under a new name instead, matching how memory_save treats name as the
 *  stable key). */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const parsed = parseMemoryId(id)
  if (!parsed) apiError(400, 'memory.invalidId', 'Malformed memory id.')
  /**
   *
   * Editing org knowledge means proposing a revision on the Platform, not
   * rewriting one machine's mirror — refuse before reading, with the reason.
   *
   **/
  if (parsed.scope === 'org') apiError(403, 'memory.orgReadOnly', new OrgMemoryReadOnlyError().message)

  const existing = await readEntry(parsed.scope, parsed.project, parsed.name)
  if (!existing) apiError(404, 'memory.notFound', 'Memory entry not found.')

  const body = await readJsonBody<{ description?: unknown; kind?: unknown; content?: unknown }>(event)

  const description =
    typeof body.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, MAX_DESCRIPTION)
      : existing.description
  const kind =
    typeof body.kind === 'string' && MEMORY_KINDS.includes(body.kind as MemoryKind)
      ? (body.kind as MemoryKind)
      : existing.kind
  const content =
    typeof body.content === 'string' && body.content.trim()
      ? body.content.trim().slice(0, MAX_CONTENT)
      : existing.content

  const { record } = await saveEntry({
    scope: existing.scope,
    project: existing.project,
    name: existing.name,
    description,
    kind,
    content,
    source: existing.source,
  })

  return { entry: { id: memoryId(record), ...record } }
})
