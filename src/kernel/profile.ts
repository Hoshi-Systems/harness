import { readFile } from 'node:fs/promises'
import { hoshiFile } from './store.js'

/**
 *
 * infra/machine/seed-profile.mjs writes what it actually seeded to
 * `$HOME/.hoshi/profile-state.json` on every boot (real machine or dev host).
 * This is Hoshi's own bookkeeping — deliberately outside `.config/opencode` —
 * so it survives independent of OpenCode's own config file.
 *
 **/
const stateFile = () => hoshiFile('profile-state.json')

export interface MachinePresetState {
  name: string
  /** The @hoshi/machine-profile package version this machine was last seeded
   *  from (its manifest.json `version`). Null when unknown (state file missing
   *  or predates seeding — a machine that hasn't rebooted since this shipped). */
  version: string | null
}

/** The preset this machine was last seeded with, straight from the seeder's own
 *  state file — not the `MACHINE_PRESET` env var, so this reflects what actually
 *  landed on disk rather than what was merely requested. Null when the machine
 *  hasn't been seeded yet (pre-Phase-1 image, or state file wiped).
 *
 *  The state file's own key is still `profile`, and stays that way: it is
 *  written on somebody's durable volume, and renaming a key the seeder wrote
 *  last boot makes every existing machine read as never seeded. The boundary is
 *  here, deliberately — the wire says preset, the disk says what it said. */
export async function readMachinePreset(): Promise<MachinePresetState | null> {
  try {
    const raw = await readFile(stateFile(), 'utf8')
    const state = JSON.parse(raw) as { profile?: unknown; version?: unknown }
    if (typeof state.profile !== 'string' || !state.profile) return null
    return { name: state.profile, version: typeof state.version === 'string' ? state.version : null }
  } catch {
    return null
  }
}

/**
 * ── What Hoshi put here, and what the person did ─────────────────────────────
 *
 * The same state file lists every path the seeder wrote, which is the only
 * honest answer to "did this come with the machine?". The alternative — a list
 * of names in the code — would be a second copy of the profile's contents that
 * drifts the first time somebody adds a skill to it.
 *
 * It matters because these are not ordinary capabilities. A person who deletes
 * one out of a list they were browsing has quietly broken part of their machine,
 * with nothing to tell them what changed.
 *
 **/
export async function seededPaths(): Promise<Set<string>> {
  try {
    const raw = await readFile(stateFile(), 'utf8')
    const state = JSON.parse(raw) as { files?: unknown }
    const files = state.files && typeof state.files === 'object' ? Object.keys(state.files) : []
    return new Set(files)
  } catch {
    return new Set()
  }
}

/** Is this skill one the profile seeded?
 *
 *  Matched on the DIRECTORY, not on `skills/<name>/SKILL.md` alone: a seeded
 *  skill carries scripts and queries beside its prose, and a machine seeded by
 *  an older profile version may list those under names this one does not know. */
export async function isSeededSkill(name: string): Promise<boolean> {
  const prefix = `skills/${name}/`
  for (const file of await seededPaths()) if (file.startsWith(prefix)) return true
  return false
}

/**
 * ── What the preset told the agent to lean toward ────────────────────────────
 *
 * The seeder splices a preset's `emphasis/hoshi.md` into the personal agent's
 * instructions between these markers (infra/machine/lib/seed-core.mjs,
 * `EMPHASIS_SPLICES`). Reading it back out is how the first-run wizard's agent
 * card can say what kind of work this agent is for — from the file the agent
 * actually runs on, not from a second copy of the preset's prose in a client.
 *
 **/
const EMPHASIS_OPEN = '<!-- hoshi:profile-emphasis -->'
const EMPHASIS_CLOSE = '<!-- /hoshi:profile-emphasis -->'

/** The text between the emphasis markers, trimmed; null when either marker is
 *  missing or the region is empty. Pure — the file read is `readProfileEmphasis`. */
export function extractProfileEmphasis(markdown: string): string | null {
  const start = markdown.indexOf(EMPHASIS_OPEN)
  if (start === -1) return null
  const end = markdown.indexOf(EMPHASIS_CLOSE, start + EMPHASIS_OPEN.length)
  if (end === -1) return null
  const text = markdown.slice(start + EMPHASIS_OPEN.length, end).trim()
  return text || null
}

/** The emphasis spliced into this machine's personal agent, or null when the
 *  agent file is absent — an unseeded dev host, which is not an error. */
export async function readProfileEmphasis(): Promise<string | null> {
  try {
    return extractProfileEmphasis(await readFile(hoshiFile('agents/hoshi.md'), 'utf8'))
  } catch {
    return null
  }
}
