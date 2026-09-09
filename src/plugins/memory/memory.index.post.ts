import { saveEntry } from './writes.js'
import { defineEventHandler } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { MEMORY_KINDS, memoryId, type MemoryKind, type MemoryScope } from './store.js'

const MAX_NAME = 80
const MAX_DESCRIPTION = 200
const MAX_CONTENT = 8000

/** Create (or, on a same-name collision, update) a memory entry — the manual
 *  "add" path from Customize → Memory. Saves with source "user" so the entry
 *  is distinguishable from agent-authored memory in the UI. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    scope?: unknown
    project?: unknown
    name?: unknown
    description?: unknown
    kind?: unknown
    content?: unknown
  }>(event)

  /**
   *
   * Org scope is deliberately NOT creatable here: it is curated on the
   * Platform and mirrored read-only, so adding to it goes through
   * POST /org-knowledge/propose. Named explicitly so the error teaches.
   *
   **/
  if (body.scope === 'org') {
    apiError(400, 'memory.orgReadOnly', 'Organization knowledge is proposed, not written — use /org-knowledge/propose.')
  }
  if (body.scope !== 'user' && body.scope !== 'project') {
    apiError(400, 'memory.invalidScope', 'scope must be "user" or "project".')
  }
  const scope = body.scope as MemoryScope

  let project: string | null = null
  if (scope === 'project') {
    if (typeof body.project !== 'string' || !body.project.trim()) {
      apiError(400, 'memory.projectRequired', 'A project slug is required when scope=project.')
    }
    project = body.project as string
  }

  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > MAX_NAME) {
    apiError(400, 'memory.nameLength', `Enter a name (1–${MAX_NAME} characters).`, { max: MAX_NAME })
  }
  if (
    typeof body.description !== 'string' ||
    !body.description.trim() ||
    body.description.trim().length > MAX_DESCRIPTION
  ) {
    apiError(400, 'memory.descriptionLength', `Enter a description (1–${MAX_DESCRIPTION} characters).`, {
      max: MAX_DESCRIPTION,
    })
  }
  if (typeof body.kind !== 'string' || !MEMORY_KINDS.includes(body.kind as MemoryKind)) {
    apiError(400, 'memory.invalidKind', `kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
  }
  if (typeof body.content !== 'string' || !body.content.trim() || body.content.trim().length > MAX_CONTENT) {
    apiError(400, 'memory.contentLength', `Enter content (1–${MAX_CONTENT} characters).`, { max: MAX_CONTENT })
  }

  const { record, updated } = await saveEntry({
    scope,
    project,
    name: body.name as string,
    description: body.description as string,
    kind: body.kind as MemoryKind,
    content: body.content as string,
    source: 'user',
  })

  return { entry: { id: memoryId(record), ...record }, updated }
})
