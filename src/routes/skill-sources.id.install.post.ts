import { defineEventHandler, setResponseStatus, getRouterParam } from 'h3'
import {
  apiError,
  readJsonBody,
  requireAuth,
  installSkillFromSource,
  InvalidSkillError,
  SkillSourceError,
} from '../kernel/index.js'

/** Install one of a source's skills onto this machine — its whole folder, so
 *  the scripts its prose tells the model to run come with it. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const sourceId = getRouterParam(event, 'id') ?? ''
  const body = await readJsonBody<{ skill?: unknown; name?: unknown }>(event)
  if (typeof body.skill !== 'string' || !body.skill.trim()) {
    apiError(400, 'skillSource.skillRequired', 'skill is required.')
  }
  try {
    const skill = await installSkillFromSource(
      sourceId,
      (body.skill as string).trim(),
      typeof body.name === 'string' ? body.name : undefined,
    )
    setResponseStatus(event, 201)
    return { skill }
  } catch (error) {
    if (error instanceof SkillSourceError) apiError(error.status, 'skillSource.installFailed', error.message)
    if (error instanceof InvalidSkillError) apiError(400, 'skill.nameInvalid', error.message)
    throw error
  }
})
