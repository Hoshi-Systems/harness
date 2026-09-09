import { defineEventHandler, setResponseStatus } from 'h3'
import { apiError, readJsonBody, requireAuth, addSkillSource, SkillSourceError } from '../kernel/index.js'

/** Add a place to install skills from: a directory to search, or a GitHub
 *  repository to list. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ name?: unknown; kind?: unknown; ref?: unknown }>(event)
  const kind = body.kind === 'directory' || body.kind === 'repository' ? body.kind : null
  if (!kind) apiError(400, 'skillSource.kindInvalid', 'kind must be "directory" or "repository".')
  if (typeof body.ref !== 'string') apiError(400, 'skillSource.refRequired', 'ref is required.')
  try {
    const source = await addSkillSource({
      kind,
      ref: body.ref as string,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    })
    setResponseStatus(event, 201)
    return { source }
  } catch (error) {
    if (error instanceof SkillSourceError) apiError(error.status, 'skillSource.invalid', error.message)
    throw error
  }
})
