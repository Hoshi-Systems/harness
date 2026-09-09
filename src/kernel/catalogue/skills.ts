import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { publishMachineEvent } from '../events.js'
import { seededPaths } from '../profile.js'
import { projectSkillRoots } from '../project-assets.js'
import { SKILLS_DIR, type AssetScope } from './common.js'

/**
 * ── Skills ───────────────────────────────────────────────────────────────────
 *
 * Files on disk, one directory per skill, because a skill is prose the model
 * reads rather than a record — and prose belongs in a file a person can edit,
 * diff and copy between machines.
 *
 **/

export interface Skill {
  name: string
  description: string
  /** Seeded by the machine profile rather than installed by the person.
   *
   *  Shown, and refused by the write routes. These are load-bearing — the
   *  integration packs are what Customize → Integrations offers to configure,
   *  and HGL is how the agent renders interactive cards — so a person should
   *  see what their machine came with, and should not be able to delete it out
   *  from under themselves. A machine flagged internal may edit them. */
  system?: boolean
  /** Found in the checkout rather than on the machine (`.claude/skills`,
   *  `.opencode/skill`, `.hoshi/skills`). It overrides a machine skill of the
   *  same name, and the client badges it — a name that means one thing in this
   *  session and another elsewhere needs to say why. */
  scope?: AssetScope
  /** The folder it was read from, for a project one. */
  source?: string
  /** Declares `internal: true` in its own front-matter: this one describes how
   *  Hoshi works inside, and is left out of the list entirely unless the machine
   *  is flagged internal.
   *
   *  Declared in the file rather than inferred from being seeded, because those
   *  are different questions and inferring it got the answer wrong: nearly
   *  everything on a seeded machine is seeded, including every integration pack,
   *  and hiding those emptied the Integrations screen — the user could no longer
   *  reach the place their own Jira and Linear keys are entered. */
  internal?: boolean
  /** The single secret this skill's scripts need, when it is an integration
   *  pack. Customize → Integrations derives its ENTIRE card list from this: a
   *  pack whose key does not reach the client is a pack the user cannot
   *  configure, and there is no second registry to fall back on. */
  vaultKey?: string
}

/** What a SKILL.md says about itself.
 *
 *  Frontmatter first, because that is what a pack actually declares — reading
 *  only the body meant `description` came back as the literal `---` opening the
 *  frontmatter, and `vaultKey` never came back at all. The body heuristic stays
 *  for hand-written skills that carry no frontmatter: good enough to populate a
 *  list, and it never fails on a file somebody typed. */
function describe(markdown: string): { description: string; vaultKey?: string; internal?: boolean } {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)
  if (front) {
    const fields: Record<string, string> = {}
    for (const line of front[1]!.split('\n')) {
      const separator = line.indexOf(':')
      if (separator === -1 || /^\s/.test(line)) continue
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
    if (fields.description) {
      return {
        description: fields.description,
        ...(fields.vaultKey ? { vaultKey: fields.vaultKey } : {}),
        ...(fields.internal === 'true' ? { internal: true } : {}),
      }
    }
  }
  const body = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line !== '---')
  return { description: body[0] ?? '' }
}

/** Just the names, for callers deciding whether an asset is already installed. */
export async function listSkillNames(): Promise<string[]> {
  return (await listSkills()).map((skill) => skill.name)
}

export async function listSkills(directory?: string): Promise<Skill[]> {
  const seeded = await seededPaths()
  const skills = new Map<string, Skill>()

  const readFolder = async (root: string, name: string, extra: Partial<Skill>) => {
    const markdown = await readFile(path.join(root, name, 'SKILL.md'), 'utf8').catch(() => null)
    if (markdown === null) return
    skills.set(name, { name, ...describe(markdown), ...extra })
  }

  for (const entry of await readdir(SKILLS_DIR(), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const system = [...seeded].some((file) => file.startsWith(`skills/${entry.name}/`))
    await readFolder(SKILLS_DIR(), entry.name, system ? { system: true } : {})
  }

  /**
   *
   * The project's skills, over the machine's. A checkout that ships a `deploy`
   * skill is describing ITS deployment; the machine's generic one is what you
   * fall back to somewhere else. Marked project-scoped so a client can say so —
   * the same name meaning different things in two sessions is confusing only
   * when nothing on screen explains it.
   *
   **/
  if (directory) {
    for (const root of await projectSkillRoots(directory)) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        await readFolder(root, entry.name, { scope: 'project', source: path.join(root, entry.name) })
      }
    }
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export class InvalidSkillError extends Error {}

export interface SkillFile {
  path: string
  content: string
}

/** Install a skill that is more than one file — an org-published skill or one
 *  from an integration pack carries scripts and references alongside its
 *  SKILL.md.
 *
 *  Every path is resolved and checked against the skill's own folder before
 *  anything is written. A crafted `../` in a file path is the whole attack: the
 *  content comes from a registry another person published to, so "it is our own
 *  data" is not a reason to trust it. */
export async function installSkillFiles(name: string, files: SkillFile[]): Promise<Skill> {
  if (!SKILL_NAME.test(name)) {
    throw new InvalidSkillError('A skill name must be lowercase letters, digits and dashes.')
  }
  const dir = path.join(SKILLS_DIR(), name)
  await mkdir(dir, { recursive: true })

  for (const file of files) {
    const destination = path.resolve(dir, file.path)
    if (destination !== dir && !destination.startsWith(dir + path.sep)) {
      throw new InvalidSkillError(`"${file.path}" points outside the skill folder.`)
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.content, 'utf8')
  }
  publishMachineEvent('skill.updated', { name })

  const markdown = files.find((file) => file.path === 'SKILL.md')?.content ?? ''
  return { name, ...describe(markdown) }
}

/** Every file of an installed skill, for publishing it onward. */
export async function readSkillFiles(name: string): Promise<SkillFile[]> {
  if (!SKILL_NAME.test(name)) return []
  const dir = path.join(SKILLS_DIR(), name)
  const out: SkillFile[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push({ path: path.relative(dir, full), content: await readFile(full, 'utf8') })
    }
  }
  await walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function installSkill(name: string, markdown: string): Promise<Skill> {
  /**
   *
   * The name becomes a directory. Anything that could climb out of the skills
   * tree is refused here rather than sanitized — a "cleaned" name silently
   * installs something other than what was asked for.
   *
   **/
  if (!SKILL_NAME.test(name)) {
    throw new InvalidSkillError('A skill name must be lowercase letters, digits and dashes.')
  }
  const dir = path.join(SKILLS_DIR(), name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), markdown, 'utf8')
  publishMachineEvent('skill.updated', { name })
  return { name, ...describe(markdown) }
}

export async function deleteSkill(name: string): Promise<boolean> {
  if (!SKILL_NAME.test(name)) return false
  const dir = path.join(SKILLS_DIR(), name)
  const existed = await readdir(dir).then(
    () => true,
    () => false,
  )
  if (!existed) return false
  await rm(dir, { recursive: true, force: true })
  publishMachineEvent('skill.updated', { name })
  return true
}
