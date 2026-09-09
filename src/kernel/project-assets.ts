import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACE_ROOT } from './workspace.js'

/**
 * ── What the PROJECT brings ──────────────────────────────────────────────────
 *
 * A repository that has been worked on with another harness already carries its
 * own commands, agents and skills — in `.claude/` or `.opencode/`, in the same
 * markdown shapes. Those are the conventions of the room; a machine that reads
 * only its own `~/.hoshi` is the participant who brought their own rules to
 * somebody else's project.
 *
 * Project beats machine on a name collision, and that is the whole point: a
 * repo that ships a `/review` meant something specific by it, and the machine's
 * generic one is the fallback, not the winner. The nearest directory wins over
 * its parents for the same reason.
 *
 * Discovery is per-DIRECTORY, so it belongs to a session rather than to the
 * machine: two checkouts on one machine have different commands, and a list
 * that merged both would offer each session the other's.
 *
 **/

/** Where other harnesses keep each kind, relative to a project directory.
 *
 *  Hoshi's own `.hoshi/` is listed alongside them rather than above them: a
 *  project that wants to say something to THIS harness specifically should be
 *  able to, and it reads last so it wins where both exist. */
const COMMAND_DIRS = ['.claude/commands', '.opencode/command', '.hoshi/commands']
const AGENT_DIRS = ['.claude/agents', '.opencode/agent', '.hoshi/agents']
const SKILL_DIRS = ['.claude/skills', '.opencode/skill', '.hoshi/skills']

/** The directory chain a session inherits from: workspace root first, the
 *  session's own directory last, so nearer definitions override further ones.
 *  Empty when the directory is outside the workspace — there is nothing to
 *  inherit from there, and walking on would read whatever happens to sit in the
 *  machine's home. */
function projectChain(directory: string): string[] {
  const root = path.resolve(WORKSPACE_ROOT)
  const start = path.resolve(directory)
  if (start !== root && !start.startsWith(`${root}${path.sep}`)) return []
  const chain: string[] = []
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.unshift(dir)
    if (dir === root || path.dirname(dir) === dir) break
  }
  return chain
}

/** One markdown definition found in a project. */
export interface ProjectFile {
  /** The name it will be known by — the file's own, minus `.md`. */
  name: string
  source: string
  content: string
}

/** Every `*.md` under the given sub-directories, nearest directory last so a
 *  later entry overrides an earlier one of the same name. */
async function collect(directory: string, subdirs: string[]): Promise<ProjectFile[]> {
  const found: ProjectFile[] = []
  for (const dir of projectChain(directory)) {
    for (const subdir of subdirs) {
      const full = path.join(dir, subdir)
      const entries = await readdir(full, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const source = path.join(full, entry.name)
        const content = await readFile(source, 'utf8').catch(() => null)
        if (content?.trim()) found.push({ name: entry.name.slice(0, -3), source, content })
      }
    }
  }
  return found
}

export function projectCommandFiles(directory: string): Promise<ProjectFile[]> {
  return collect(directory, COMMAND_DIRS)
}

export function projectAgentFiles(directory: string): Promise<ProjectFile[]> {
  return collect(directory, AGENT_DIRS)
}

/** Skill FOLDERS a project carries — each one a directory with a SKILL.md, the
 *  layout every harness uses.
 *
 *  Returned as paths rather than parsed content because the agent library
 *  discovers skills from directories itself: handing it these alongside the
 *  machine's own is what makes a project's skill loadable in a turn, not just
 *  listable on a screen. */
export async function projectSkillRoots(directory: string): Promise<string[]> {
  const roots: string[] = []
  for (const dir of projectChain(directory)) {
    for (const subdir of SKILL_DIRS) {
      const full = path.join(dir, subdir)
      const entries = await readdir(full, { withFileTypes: true }).catch(() => null)
      if (entries && entries.some((entry) => entry.isDirectory())) roots.push(full)
    }
  }
  return roots
}
