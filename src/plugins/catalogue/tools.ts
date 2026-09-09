import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile } from '../../kernel/index.js'
import { defineHoshiTool, z, type HoshiToolFactories } from '../define-tool.js'

/**
 * ── The machine authoring its own catalogue ──────────────────────────────────
 *
 * `skill_create` writes a brand-new SKILL.md and `command_create` self-authors
 * a slash command — agent-facing paths for machine self-management that
 * previously existed only as human web-UI flows (CYB-84). The kernel serves the
 * catalogue those two write into; these are the tools that add to it.
 *
 * They lived in the tool registry package and were contributed by `widgets`,
 * which owns neither (docs/STRUCTURE_REVIEW.md H-08).
 *
 **/

const skillsDir = () => hoshiFile('skills')

/**
 *
 * ── Shared slugify (same approach as the memory store's filename slugify —
 * lowercase, dashes, no path-traversal characters survive the replace) ───────
 *
 **/

/** A filesystem-safe key: lowercase, dashes, max `max` chars. The same shape as
 *  the memory store's slugify — capped at 64 here to match the skill/command
 *  name limits enforced elsewhere (packages/harness/src/kernel/catalogue/skills.ts's
 *  readSkillMeta, packages/harness/src/routes/commands.name.patch.ts).
 *
 *  It is also the guard in front of the filesystem: the name comes from the
 *  MODEL and becomes a directory, and `[^a-z0-9]+` is what stops `../` from
 *  surviving into a path. */
function slugify(input: string, max = 64): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug || 'untitled'
}

/**
 * ── skill_create ─────────────────────────────────────────────────────────────
 *
 **/

/** YAML-safe a frontmatter scalar — same small helper as the memory store's
 *  yamlString: plain when it's already a simple line, JSON-quoted otherwise.
 *  A description carrying a newline or a colon would otherwise write frontmatter
 *  that no longer parses, and the skill would vanish from the index without
 *  anything failing. */
function yamlString(value: string): string {
  if (/^[\w .,!?()/-]*$/.test(value) && value.trim() === value) return value
  return JSON.stringify(value)
}

const skillCreate = defineHoshiTool({
  description: [
    'Author a brand-new skill on this machine from scratch: writes ~/.hoshi/skills/<name>/SKILL.md.',
    "This is the ONLY way to create original skill content — the machine's other skill mechanism only clones an existing skill from a git URL.",
    'Refuses to overwrite an existing skill directory; pick a different name if one already exists.',
    "'content' is the full markdown body (everything after the frontmatter) — write it as you would any other SKILL.md: what it's for, when to use it, how to use it.",
  ].join(' '),
  args: {
    name: z.string().describe("The skill's directory slug, e.g. 'deploy-checklist' — will be slugified"),
    description: z
      .string()
      .describe(
        'One-line purpose, shown in the SKILL.md frontmatter and used by the model to decide when to load this skill',
      ),
    content: z.string().describe('The full SKILL.md body (markdown), everything after the frontmatter'),
  },
  async execute(args) {
    const slug = slugify(args.name)
    const dir = path.join(skillsDir(), slug)

    const alreadyExists = await stat(dir)
      .then(() => true)
      .catch(() => false)
    if (alreadyExists) {
      return {
        title: 'Skill already exists',
        output: `A skill directory named "${slug}" already exists at ${dir}. Pick a different name, or ask the user to delete the existing one first — this tool never overwrites.`,
        metadata: { hoshi: { internal: { action: 'skill_create', created: false, name: slug } } },
      }
    }

    const description = args.description.trim()
    if (!description) throw new Error('A skill description is required.')
    const body = args.content.trim()
    if (!body) throw new Error('Skill content is required.')

    await mkdir(dir, { recursive: true })
    const skillFile = path.join(dir, 'SKILL.md')
    const frontmatter = ['---', `name: ${slug}`, `description: ${yamlString(description)}`, '---', ''].join('\n')
    await writeFile(skillFile, `${frontmatter}\n${body}\n`, 'utf8')

    return {
      title: `Created skill: ${slug}`,
      output: `Created skill "${slug}" at ${skillFile}. It will be picked up the next time a session considers its skill list.`,
      metadata: { hoshi: { internal: { action: 'skill_create', created: true, name: slug, path: skillFile } } },
    }
  },
})

/**
 * ── command_create ──────────────────────────────────────────────────────────
 *
 * Writing a command used to mean PATCHing the runtime's own config endpoint
 * over loopback — the established way for a plugin in a foreign process to
 * reach a machine-local service. The catalogue belongs to the machine now
 * (the harness's catalogue), so the tool asks for the operation
 * through its context and never learns where commands are stored.
 *
 * Validation (name pattern, required template) still mirrors the route that
 * does the same job, so the two paths cannot diverge in what they accept.
 *
 **/

const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

const commandCreate = defineHoshiTool({
  description: [
    'Create a new slash command on this machine (e.g. /my-command) that the user or any agent can invoke.',
    "'template' is the prompt template dispatched when the command runs (may reference $ARGUMENTS).",
    'Command names are lowercase letters, digits, dashes and underscores (max 64 chars).',
    "Creating again with the same name overwrites that command's definition — pick a fresh name if you don't intend to replace an existing one.",
  ].join(' '),
  args: {
    name: z.string().describe("The command name, without the leading slash, e.g. 'deploy-checklist'"),
    template: z.string().describe('The prompt template this command dispatches'),
    description: z.string().optional().describe('One-line description shown in the command picker'),
  },
  async execute(args, context) {
    const name = args.name.trim()
    if (!COMMAND_NAME.test(name)) {
      throw new Error('A command name must be lowercase letters, digits, dashes (up to 64 characters).')
    }
    const template = args.template.trim()
    if (!template) throw new Error('A command template is required.')
    const description = args.description?.trim()

    /**
     *
     * Was a PATCH against the runtime's config endpoint; the catalogue is the
     * machine's own now, so this is one call with no wire in it.
     *
     **/
    await context.machine.createCommand(name, { template, ...(description ? { description } : {}) })

    return {
      title: `Created command: /${name}`,
      output: `Created command "/${name}". Invoke it with /${name}${template.includes('$ARGUMENTS') ? ' <args>' : ''}.`,
      metadata: { hoshi: { internal: { action: 'command_create', name } } },
    }
  },
})

export const catalogueTools: HoshiToolFactories = {
  skill_create: skillCreate,
  command_create: commandCreate,
}
