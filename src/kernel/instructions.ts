import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ports } from './host-ports.js'
import { hoshiFile } from './store.js'
import { WORKSPACE_ROOT } from './workspace.js'

/**
 * ── What every turn is told, before the agent's own brief ────────────────────
 *
 * `AGENTS.md` is the machine's standing instructions: the user's own rules,
 * plus the managed region the memory store keeps current (plugins/memory/
 * agents-index.ts). It is the reason a machine remembers a preference stated
 * three weeks ago in another session.
 *
 * It reached the model NOT AT ALL for the whole of the harness migration.
 * Nothing read it — the file was written, indexed and maintained on every
 * memory write, and no turn ever put it in front of anybody. The symptom was
 * not an error: the machine simply answered as if it had never been told
 * anything, which is indistinguishable from a model that ignored its
 * instructions.
 *
 * Prepended rather than appended: standing rules frame the agent's brief, and
 * an agent definition that contradicts them should read as the later, more
 * specific word.
 *
 **/

const AGENTS_MD = () => hoshiFile('AGENTS.md')

/** The machine's standing instructions, or '' when it has none. A machine with
 *  no AGENTS.md is a valid machine — an unseeded one — so its absence is an
 *  empty string, never a failed turn. */
export async function machineInstructions(): Promise<string> {
  let saved = ''
  try {
    saved = (await readFile(AGENTS_MD(), 'utf8')).trim()
  } catch {
    // An unseeded harness is valid; extensions can still supply instructions.
  }
  return systemPrompt(saved, ...(ports().agentInstructions?.() ?? []))
}

/**
 * ── What the PROJECT says ────────────────────────────────────────────────────
 *
 * `AGENTS.md` and `CLAUDE.md` in the directory a session works in, and in its
 * parents up to the workspace root.
 *
 * Every other harness reads these — Claude Code, Codex, OpenCode — so a repo
 * that has one has already written down how it wants to be worked on, and a
 * machine that ignores it is the one participant in the room who did not read
 * the brief. Ours ignored it completely: the library's own loader is switched
 * off in engine/turns.ts (`instructions: false`) and nothing took its place, so
 * a checkout's conventions reached the model not at all.
 *
 * Both names, not one: a repository commonly carries CLAUDE.md because somebody
 * used Claude Code in it, and AGENTS.md because somebody used something else.
 * Picking a favourite would silently drop half the instructions in a repo that
 * has both.
 *
 * Outermost first, so the nearest file reads last and therefore wins — the same
 * order every other harness uses, and the one a person expects when they put a
 * stricter rule in a subdirectory.
 *
 **/

/** Instruction file names, in the order they are read within one directory. */
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md']

/** How much project instruction reaches the model, in characters.
 *
 *  A cap because this is somebody else's file and it rides in EVERY request of
 *  the session: a repository with a 200k-character CLAUDE.md would otherwise
 *  spend most of the window explaining itself before the question is asked.
 *  Truncated with a line saying so, rather than trimmed silently — a model that
 *  is missing half its brief should be told. */
const PROJECT_INSTRUCTIONS_MAX = 32_000

export async function projectInstructions(directory: string): Promise<string> {
  const root = path.resolve(WORKSPACE_ROOT)
  const start = path.resolve(directory)
  /**
   *
   * Only inside the workspace. A session's directory is always under it, and
   * walking past it would start reading whatever happens to sit in the
   * machine's home — files nobody wrote as instructions for anybody.
   *
   **/
  if (start !== root && !start.startsWith(`${root}${path.sep}`)) return ''

  const chain: string[] = []
  for (let dir = start; ; dir = path.dirname(dir)) {
    chain.unshift(dir)
    if (dir === root || path.dirname(dir) === dir) break
  }

  const parts: string[] = []
  for (const dir of chain) {
    for (const name of PROJECT_FILES) {
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => null)
      if (text?.trim()) parts.push(`# ${path.relative(root, path.join(dir, name)) || name}\n\n${text.trim()}`)
    }
  }
  const joined = parts.join('\n\n')
  return joined.length > PROJECT_INSTRUCTIONS_MAX
    ? `${joined.slice(0, PROJECT_INSTRUCTIONS_MAX)}\n\n[project instructions truncated at ${PROJECT_INSTRUCTIONS_MAX} characters]`
    : joined
}

/** The system prompt a turn starts from: the machine's standing instructions,
 *  the project's own, then the agent's brief. Any may be empty; all empty means
 *  no system prompt at all rather than a stray separator.
 *
 *  In that order deliberately — machine rules frame the project's, the project
 *  frames the task, and the agent's brief is the most specific word. */
export function systemPrompt(...sections: string[]): string {
  return sections.filter(Boolean).join('\n\n---\n\n')
}
