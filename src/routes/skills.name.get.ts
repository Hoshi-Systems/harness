import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, listSkills, readSkillFiles } from '../kernel/index.js'

/** One skill, with the files it is made of.
 *
 *  The list route carries only what a list needs (name, description, the badges).
 *  This is what an editor opens: the SKILL.md prose the model actually reads,
 *  plus whatever sits beside it — a pack ships scripts and queries, and an editor
 *  that showed only the prose would quietly hide half of what the skill is.
 *
 *  A skill that declares itself internal is withheld here for the same reason it
 *  is left out of the list: not being in the index is not protection when the
 *  name is a guess away. */
export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const name = getRouterParam(event, 'name') ?? ''
  const skill = (await listSkills()).find((entry) => entry.name === name)
  if (!skill || (skill.internal && !session.internal)) {
    apiError(404, 'skill.notFound', 'No such skill on this machine.')
  }
  return { skill, files: await readSkillFiles(name) }
})
