import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { memoryId, parseMemoryId, readEntry } from './store.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const parsed = parseMemoryId(id)
  if (!parsed) apiError(400, 'memory.invalidId', 'Malformed memory id.')

  const record = await readEntry(parsed.scope, parsed.project, parsed.name)
  if (!record) apiError(404, 'memory.notFound', 'Memory entry not found.')

  return { entry: { id: memoryId(record), ...record } }
})
