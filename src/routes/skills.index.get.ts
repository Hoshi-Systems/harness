import { defineEventHandler } from 'h3'
import { requireAuth, requestedDirectory, listSkills } from '../kernel/index.js'

/** Skills installed on this machine — one directory each, holding the prose the
 *  model reads.
 *
 *  Everything the machine has is listed, including what the profile seeded: the
 *  integration packs ARE the list Customize → Integrations is built from, so
 *  withholding them takes away the only place a person can enter their own Jira
 *  or Linear key. What they cannot do is edit or delete a seeded one; the write
 *  routes enforce that, and `system` on each row is what the UI marks it with.
 *
 *  The exception is a skill that declares itself INTERNAL — HGL and its kind,
 *  which describe how Hoshi works inside. Those are left out unless this machine
 *  is flagged internal on the Platform. The agent still loads them either way;
 *  this is what the list says, not what the machine has. */
export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const skills = await listSkills(await requestedDirectory(event))
  return { skills: session.internal ? skills : skills.filter((skill) => !skill.internal) }
})
