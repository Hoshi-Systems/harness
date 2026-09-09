import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody, installSkill, InvalidSkillError, isSeededSkill } from '../kernel/index.js'

/** Install a skill. */
export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const body = await readJsonBody<{ name?: unknown; markdown?: unknown }>(event)
  if (typeof body.name !== 'string' || typeof body.markdown !== 'string' || !body.markdown.trim()) {
    apiError(400, 'skill.invalid', 'name and markdown are required.')
  }
  /**
   *
   * Installing over a seeded name is the same act as editing it — the write
   * lands in that skill's own directory. Refused for the same reason a delete
   * is, and separately from it, since this route never mentions deleting.
   *
   **/
  if (!session.internal && (await isSeededSkill(body.name as string))) {
    apiError(403, 'skill.system', 'This skill comes with the machine and cannot be changed.')
  }
  try {
    return { skill: await installSkill(body.name as string, body.markdown as string) }
  } catch (error) {
    if (error instanceof InvalidSkillError) apiError(400, 'skill.nameInvalid', error.message)
    throw error
  }
})
