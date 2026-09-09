import { defineEventHandler, getRouterParam } from 'h3'
import {
  requireAuth,
  apiError,
  readJsonBody,
  installSkillFiles,
  InvalidSkillError,
  listSkills,
  readSkillFiles,
} from '../kernel/index.js'

/** Copy a skill, whole, under a new name.
 *
 *  This is what makes the lock on a seeded skill livable: the machine's own
 *  jira pack is not yours to edit, but a copy of it is entirely yours — change
 *  the copy, keep the original working, and publish the copy to your org if it
 *  turns out to be better. Without this, "locked" would mean "start from a blank
 *  file and retype what is already there".
 *
 *  Copies every file, not just the prose: a pack's scripts and queries are what
 *  its SKILL.md tells the model to run, so a copy without them is a set of
 *  instructions pointing at nothing.
 *
 *  Copying is a read of the source and a write of a NEW name, so a seeded source
 *  is fine — nothing about the original changes. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const source = getRouterParam(event, 'name') ?? ''
  const body = await readJsonBody<{ name?: unknown }>(event)
  const target = typeof body.name === 'string' ? body.name.trim() : ''
  if (!target) apiError(400, 'skill.nameRequired', 'name is required.')

  const skills = await listSkills()
  if (!skills.some((skill) => skill.name === source)) {
    apiError(404, 'skill.notFound', 'No such skill on this machine.')
  }
  if (skills.some((skill) => skill.name === target)) {
    apiError(409, 'skill.exists', `This machine already has a "${target}" skill.`)
  }

  const files = await readSkillFiles(source)
  if (files.length === 0) apiError(404, 'skill.notFound', 'No such skill on this machine.')

  try {
    return { skill: await installSkillFiles(target, files) }
  } catch (error) {
    if (error instanceof InvalidSkillError) apiError(400, 'skill.nameInvalid', error.message)
    throw error
  }
})
