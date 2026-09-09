import { defineEventHandler } from 'h3'
import { requireAuth, listSkillSources } from '../kernel/index.js'

/** Where this machine can install skills from. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { sources: await listSkillSources() }
})
