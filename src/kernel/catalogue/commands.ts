import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readHoshiJson, writeHoshiJson } from '../store.js'
import { publishMachineEvent } from '../events.js'
import { seededPaths } from '../profile.js'
import { projectCommandFiles } from '../project-assets.js'
import { COMMANDS_DIR, COMMANDS_FILE, stripUndefined, type AssetScope } from './common.js'

/**
 * ── Commands ─────────────────────────────────────────────────────────────────
 *
 **/

/** Where a definition came from. `project` means it was found in the checkout
 *  a session works in (`.claude/`, `.opencode/`, `.hoshi/`) rather than on the
 *  machine — clients say so, because presenting a repository's convention as
 *  the machine's own hides why it changes between sessions. */

export interface Command {
  name: string
  description: string
  template: string
  /** Absent means machine — the ordinary case, and the smaller payload. */
  scope?: AssetScope
  /** The file it was read from, for a project one. */
  source?: string
}

/** The seeded layer: `~/.hoshi/commands/<name>.md`, one per command — the same
 *  shape agents use, and seeded by the same profile.
 *
 *  These went missing in the migration and nobody noticed for a while, which is
 *  the interesting part: the machine image had been laying the files down all
 *  along and the runtime that read them was gone, so `/onboard` — the machine's
 *  own introduction, the first thing a new user is meant to run — simply was not
 *  in the composer. Nothing errored; a command that is not listed looks exactly
 *  like a command nobody wrote.
 *
 *  Frontmatter is the description (and whatever else the file declares); the
 *  body is the template. Anything unreadable is skipped rather than fatal: a
 *  command file is prose somebody typed, and one bad line must not cost the
 *  machine the rest of them. */
async function readSeededCommands(): Promise<Record<string, Partial<Command>>> {
  let files: string[]
  try {
    files = (await readdir(COMMANDS_DIR())).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return {}
  }
  const seeded: Record<string, Partial<Command>> = {}
  for (const file of files) {
    try {
      const source = await readFile(path.join(COMMANDS_DIR(), file), 'utf8')
      const parsed = parseCommandFile(source)
      if (parsed) seeded[file.slice(0, -3)] = parsed
    } catch {
      /* unreadable definition — skip it */
    }
  }
  return seeded
}

/** `--- frontmatter ---` then the prompt, exactly like a seeded agent. A file
 *  with no frontmatter is still a command: the whole text is the template, and
 *  the description is left to the name. */
function parseCommandFile(source: string): Partial<Command> | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  const template = (match ? match[2]! : source).trim()
  if (!template) return null
  if (!match) return { template }
  let description = ''
  for (const line of match[1]!.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1 || /^\s/.test(line)) continue
    if (line.slice(0, separator).trim() === 'description') description = line.slice(separator + 1).trim()
  }
  return { template, ...(description ? { description } : {}) }
}

/** Every command this machine offers: what the profile seeded, with the user's
 *  own edits layered over it.
 *
 *  Over, not beside: editing `/onboard` in Customize writes a `commands.json`
 *  entry under the same name, and that entry must win — otherwise the edit
 *  would appear to save and then be silently outvoted by the file on disk every
 *  time the list was read. */
export async function listCommands(directory?: string): Promise<Command[]> {
  const seeded = await readSeededCommands()
  const data = await readHoshiJson<{ commands?: Record<string, Partial<Command>> }>(COMMANDS_FILE())
  const machine = new Map<string, Command>()
  for (const name of new Set([...Object.keys(seeded), ...Object.keys(data?.commands ?? {})])) {
    const command = { ...seeded[name], ...(data?.commands ?? {})[name] }
    if (command.template) {
      machine.set(name, { name, description: command.description ?? '', template: command.template })
    }
  }

  /**
   *
   * The project's own, layered OVER the machine's. A repository that ships a
   * `/review` meant something specific by it, and the machine's generic one is
   * the fallback — never the winner. Marked as project-scoped so a client can
   * say where it came from rather than presenting somebody else's convention as
   * this machine's.
   *
   **/
  if (directory) {
    for (const file of await projectCommandFiles(directory)) {
      const parsed = parseCommandFile(file.content)
      if (!parsed?.template) continue
      machine.set(file.name, {
        name: file.name,
        description: parsed.description ?? '',
        template: parsed.template,
        scope: 'project',
        source: file.source,
      })
    }
  }

  return [...machine.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function setCommand(name: string, patch: Partial<Command>): Promise<Command | null> {
  const data = await readHoshiJson<{ commands?: Record<string, Partial<Command>> }>(COMMANDS_FILE())
  const commands = data?.commands ?? {}
  commands[name] = { ...commands[name], ...stripUndefined(patch) }
  await writeHoshiJson(COMMANDS_FILE(), { commands })
  publishMachineEvent('command.updated', { name })
  return (await listCommands()).find((command) => command.name === name) ?? null
}

export async function deleteCommand(name: string): Promise<boolean> {
  const data = await readHoshiJson<{ commands?: Record<string, Partial<Command>> }>(COMMANDS_FILE())
  const commands = data?.commands ?? {}
  if (!(name in commands)) return false
  delete commands[name]
  await writeHoshiJson(COMMANDS_FILE(), { commands })
  publishMachineEvent('command.updated', { name })
  return true
}
