import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, deleteSkill, isSeededSkill } from '../kernel/index.js'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const name = getRouterParam(event, 'name') ?? ''
  /**
   *
   * Checked here rather than left to the list being filtered: hiding something
   * is not protecting it, and a name is easy to guess. HGL is the case that
   * matters — one DELETE and the agent's interactive cards stop rendering on
   * that machine, with nothing anywhere saying why.
   *
   **/
  if (!session.internal && (await isSeededSkill(name))) {
    apiError(403, 'skill.system', 'This skill comes with the machine and cannot be removed.')
  }
  const removed = await deleteSkill(name)
  if (!removed) apiError(404, 'skill.notFound', 'No such skill on this machine.')
  return { ok: true }
})
