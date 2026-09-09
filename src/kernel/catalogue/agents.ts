import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readHoshiJson, writeHoshiJson } from '../store.js'
import { AGENTS_DIR, AGENTS_FILE, stripUndefined, type AssetScope } from './common.js'
import { publishMachineEvent } from '../events.js'
import { getPreferences } from '../preferences.js'
import { isLevel, type Level } from '../permissions.js'
import { seededPaths } from '../profile.js'
import { projectAgentFiles, projectCommandFiles, projectSkillRoots } from '../project-assets.js'

/**
 * ── The catalogue: agents, commands, skills ──────────────────────────────────
 *
 * What the machine can be asked to BE, and what it already knows how to do.
 *
 * Editing any of this is a plain file write, and that is the whole point. Under
 * the old runtime each one was a global-config write that disposed the runtime,
 * so renaming an agent killed whatever the machine was doing in another tab —
 * the most-felt version of the problem this migration removes. Here the
 * catalogue is read when a turn starts, never baked into a process at boot.
 *
 * Two layers, and the distinction matters for what a user is allowed to break:
 *
 *   BUILT-IN   ships with the machine, always present, always usable. An
 *              override edits it; deleting an override restores it. A machine
 *              cannot end up with no agents and therefore no way to start a
 *              session — which an unseeded machine otherwise would.
 *   SEEDED     markdown under ~/.hoshi/agents, laid down by the profile the
 *              machine image bakes in (packages/machine-profile). Prose a person
 *              writes and reviews, so it lives in a file a person can edit —
 *              same reason archetypes do. It layers OVER built-ins and UNDER the
 *              user's own edits.
 *   CUSTOM     defined here by the user, as JSON patches, and deletable
 *              outright.
 *
 * The seeded layer is not decoration: the machine's personal agent — the one
 * every session runs as by default — is a profile file. Reading only the JSON
 * patches meant the profile reached the model not at all, and the machine
 * answered every prompt as a generic built-in with a one-sentence brief.
 *
 **/

/** Rejected agent input. Kept as a named error so an installer can turn it into
 *  a user-facing "that pack is malformed" rather than a 500. */
export class InvalidAgentError extends Error {}

/** The editable layer over an agent — the shape a pack or an org asset
 *  publishes. */
export type AgentOverride = AgentPatch

export interface Agent {
  name: string
  description: string
  /** The system prompt a session running as this agent starts from. */
  prompt: string
  /** `provider/model`, or null to use the machine's default. */
  model: string | null
  /** Tools this agent is not offered at all, by name (`{ write: false }`).
   *  Absent means offered. This is a capability, not a permission: a tool set
   *  to false is never put in front of the model, so there is nothing to
   *  approve and nothing to refuse — an agent described as "investigates
   *  without changing anything" is only actually that if it cannot write. */
  tools: Record<string, boolean>
  /** Per-agent permission levels, layered over the machine's own. An agent may
   *  only TIGHTEN what the machine allows (see `effectiveLevel`) — a definition
   *  that could hand itself `allow` would make the machine-wide setting
   *  advisory, and the whole point of that setting is that it is not. */
  permission: Record<string, Level>
  /** This agent changes nothing outside the conversation: it is offered no
   *  mutating tool at all (engine/tools.ts `MUTATING`). Said once rather than
   *  enumerated, so the promise still holds after the next tool is added. */
  readOnly: boolean
  builtIn: boolean
  /** Found in the checkout rather than on the machine (`.claude/agents`,
   *  `.opencode/agent`, `.hoshi/agents`) — it overrides a machine agent of the
   *  same name, and a client says so. */
  scope?: AssetScope
  /** This machine has its own definition for the agent — either a custom one,
   *  or an edit layered over a built-in. It is what makes an agent publishable:
   *  a pristine built-in is not this machine's to share. */
  customised: boolean
}

/** The agents every machine has, whatever else it was seeded with. `build` is
 *  the default a session runs as when it names none — a machine with an empty
 *  agent list could not start a session at all. */
const BUILT_IN: Array<Omit<Agent, 'builtIn' | 'customised'>> = [
  {
    name: 'build',
    description: 'Writes and changes code.',
    prompt: 'You are a careful software engineer. Make the change asked for, and say what you did.',
    model: null,
    tools: {},
    permission: {},
    readOnly: false,
  },
  {
    name: 'plan',
    description: 'Investigates and proposes, without changing anything.',
    prompt:
      'You investigate and explain. Do not modify files — describe what you would change and why, so a person can decide.',
    model: null,
    tools: {},
    permission: {},
    /**
     *
     * Said in the tool set, not only in the prompt. "Do not modify files" is a
     * request a model can misread, forget after a long turn, or be talked out
     * of; a tool it was never handed is none of those.
     *
     **/
    readOnly: true,
  },
]

interface AgentPatch {
  description?: string
  prompt?: string
  model?: string | null
  tools?: Record<string, boolean>
  permission?: Record<string, Level>
  readOnly?: boolean
  /** Present on an agent the user created rather than overrode. */
  custom?: boolean
}

/** Seeded agent definitions: one markdown file per agent, frontmatter + prompt. */
/** Seeded command definitions: one markdown file per command, frontmatter +
 *  prompt — the profile writes these, the same way it writes agents. */
/** Where installed skills live: one folder per skill, each with a SKILL.md.
 *  Exported because the Agent is handed this path directly (engine/turns.ts) —
 *  the library discovers and serves them, this module only manages them. */

async function readAgentPatches(): Promise<Record<string, AgentPatch>> {
  const data = await readHoshiJson<{ agents?: Record<string, AgentPatch> }>(AGENTS_FILE())
  return data?.agents ?? {}
}

/** Parse one seeded definition: `--- frontmatter ---` then the prompt.
 *
 *  The frontmatter an agent needs is not flat the way an archetype's is —
 *  `tools:` and `permission:` are maps — so this reads one level of nesting and
 *  nothing more. A key it does not understand is ignored rather than fatal: an
 *  agent file is hand-written, and one bad line must not cost the machine its
 *  personal agent. */
function parseAgentFile(name: string, source: string): AgentPatch | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) return null
  const prompt = match[2]!.trim()
  if (!prompt) return null

  const patch: AgentPatch = { prompt }
  const tools: Record<string, boolean> = {}
  const permission: Record<string, Level> = {}
  let section: 'tools' | 'permission' | null = null

  for (const line of match[1]!.split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    /**
     *
     * Indentation is what says "this belongs to the map above" — the only
     * structure this parser understands, and enough for the shape agents use.
     *
     **/
    if (/^\s/.test(line)) {
      if (section === 'tools') tools[key] = value !== 'false'
      else if (section === 'permission' && isLevel(value)) permission[key] = value
      continue
    }
    section = key === 'tools' || key === 'permission' ? key : null
    if (section) continue
    if (key === 'description') patch.description = value
    else if (key === 'model' && value) patch.model = value
    else if (key === 'readOnly') patch.readOnly = value === 'true'
  }

  if (Object.keys(tools).length) patch.tools = tools
  if (Object.keys(permission).length) patch.permission = permission
  return { ...patch, description: patch.description ?? '' }
}

/** The seeded layer: `~/.hoshi/agents/<name>.md`, one per agent. Missing
 *  directory means an unseeded machine, which is an empty layer, not a
 *  failure. */
async function readSeededAgents(): Promise<Record<string, AgentPatch>> {
  let files: string[]
  try {
    files = (await readdir(AGENTS_DIR())).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return {}
  }
  const seeded: Record<string, AgentPatch> = {}
  for (const file of files) {
    try {
      const parsed = parseAgentFile(file.slice(0, -3), await readFile(path.join(AGENTS_DIR(), file), 'utf8'))
      if (parsed) seeded[file.slice(0, -3)] = parsed
    } catch {
      /* unreadable definition — skip it */
    }
  }
  return seeded
}

export async function listAgents(directory?: string): Promise<Agent[]> {
  const seeded = await readSeededAgents()
  /**
   *
   * The project's own agents layer over the machine's, by the same rule as its
   * commands: a repo that defines a `reviewer` has said what reviewing means
   * here, and this machine's generic one is the fallback.
   *
   **/
  const project = new Map<string, AgentPatch>()
  if (directory) {
    for (const file of await projectAgentFiles(directory)) {
      const parsed = parseAgentFile(file.name, file.content)
      if (parsed) project.set(file.name, parsed)
    }
  }
  const patches = await readAgentPatches()
  const agents = BUILT_IN.map((agent) => ({
    ...agent,
    ...stripUndefined(seeded[agent.name]),
    ...stripUndefined(patches[agent.name]),
    ...stripUndefined(project.get(agent.name)),
    builtIn: true,
    customised: agent.name in patches,
    ...(project.has(agent.name) ? { scope: 'project' as const } : {}),
  }))
  for (const name of new Set([...Object.keys(seeded), ...Object.keys(patches), ...project.keys()])) {
    if (BUILT_IN.some((agent) => agent.name === name)) continue
    const patch = { ...seeded[name], ...stripUndefined(patches[name]), ...stripUndefined(project.get(name)) }
    agents.push({
      name,
      description: patch.description ?? '',
      prompt: patch.prompt ?? '',
      model: patch.model ?? null,
      tools: patch.tools ?? {},
      permission: patch.permission ?? {},
      readOnly: patch.readOnly ?? false,
      builtIn: false,
      ...(project.has(name) ? { scope: 'project' as const } : {}),
      /**
       *
       * Seeded content is the machine's, not this machine's own: a pristine
       * profile agent is no more publishable than a pristine built-in.
       *
       **/
      customised: name in patches,
    })
  }
  return agents
}

/** A patch's absent keys must not erase the built-in's values — `{...a, ...b}`
 *  with `b.description === undefined` would. */
async function getAgent(name: string, directory?: string): Promise<Agent | null> {
  return (await listAgents(directory)).find((agent) => agent.name === name) ?? null
}

/** The agent a session runs as when it names none. */
export async function defaultAgent(): Promise<Agent> {
  return (await getAgent('build')) ?? { ...BUILT_IN[0]!, builtIn: true, customised: false }
}

/** The agent a turn runs as: the one the message asked for, else the machine's
 *  configured default, else `build`.
 *
 *  A name nobody has a definition for falls back rather than failing. The two
 *  places it comes from are a person's live choice and a stored preference, and
 *  neither is worth refusing a turn over — an agent can be renamed or deleted
 *  between the moment it was chosen and the moment the message is sent. */
export async function resolveAgent(requested?: string | null, directory?: string): Promise<Agent> {
  if (requested) {
    const named = await getAgent(requested, directory)
    if (named) return named
  }
  const preferred = (await getPreferences()).defaultAgent
  if (preferred) {
    const configured = await getAgent(preferred, directory)
    if (configured) return configured
  }
  return defaultAgent()
}

export async function setAgent(name: string, patch: AgentPatch): Promise<Agent | null> {
  const patches = await readAgentPatches()
  patches[name] = { ...patches[name], ...stripUndefined(patch) }
  await writeHoshiJson(AGENTS_FILE(), { agents: patches })
  publishMachineEvent('agent.updated', { name })
  return getAgent(name)
}

/** Remove a custom agent, or an override on a built-in — which restores it
 *  rather than deleting it. A user cannot delete their way to a machine with no
 *  agents. */
export async function deleteAgent(name: string): Promise<boolean> {
  const patches = await readAgentPatches()
  if (!(name in patches)) return false
  delete patches[name]
  await writeHoshiJson(AGENTS_FILE(), { agents: patches })
  publishMachineEvent('agent.updated', { name })
  return true
}
