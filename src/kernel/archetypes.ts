import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile } from './store.js'
import { isModelTier, tierModelRef, type ModelTier } from './model.js'

/**
 * ── Archetypes: the specialists a session can delegate to ────────────────────
 *
 * A markdown file with a small YAML header, one per role, seeded from
 * packages/machine-profile. This is Hoshi's own content and the reason
 * delegation is useful at all — "hand this to a technical writer" only means
 * something if the machine knows what a technical writer is.
 *
 * It is deliberately files rather than a table: an archetype is a prompt a
 * person writes, reviews and copies between machines, and prose belongs
 * somewhere a person can edit it.
 *
 * What is NOT here any more is how a specialist gets run. That used to be 893
 * lines of session plumbing against another runtime's API — creating child
 * sessions with a parentID, posting messages into them, propagating aborts.
 * The engine's own library does that (Agent's `subagents` + the `task` tool it
 * generates), so this module supplies the catalogue and nothing else.
 *
 **/

export interface Archetype {
  name: string
  description: string
  /** The system prompt this specialist runs with. */
  prompt: string
  /** Whether the specialist may modify anything, or only read and report. */
  readOnly: boolean
  /** How much model this role's work deserves, or null to run on whatever the
   *  session that delegated is running on.
   *
   *  A SIZE rather than a model name, because that is the part of the judgement
   *  that keeps: "an architect needs the machine's best model" stays true after
   *  the best model changes, where `anthropic/claude-x` would need editing on
   *  every machine every time. The mapping from size to model is the owner's,
   *  in preferences (kernel/model.ts `tierModelRef`).
   *
   *  Every seeded archetype has declared one of these since they were written
   *  — `tier: heavy` on the architect, `tier: light` on the scribe — and until
   *  now the parser below read past the field without seeing it, so every
   *  specialist on every machine ran on exactly the same model. */
  tier: ModelTier | null
}

const DIR = () => hoshiFile('archetypes')

/** Parse `--- key: value ---\n\nbody`. Flat, known keys only: an archetype is
 *  hand-written, so a malformed one must degrade to "skipped" rather than take
 *  the whole catalogue with it. */
function parseArchetype(name: string, source: string): Archetype | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  const prompt = match[2]!.trim()
  if (!prompt) return null
  return {
    name,
    description: fields.description ?? '',
    prompt,
    readOnly: fields.readOnly === 'true',
    /**
     *
     * An unrecognised tier is null, not a refusal: an archetype is a file a
     * person writes by hand, and a typo in an optional routing hint must cost
     * the hint rather than the specialist.
     *
     **/
    tier: isModelTier(fields.tier) ? fields.tier : null,
  }
}

/** Every archetype on this machine. An unreadable file is skipped, never
 *  fatal — one bad specialist must not cost the user every other one. */
export async function listArchetypes(): Promise<Archetype[]> {
  let files: string[]
  try {
    files = (await readdir(DIR())).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return []
  }
  const archetypes: Archetype[] = []
  for (const file of files) {
    try {
      const parsed = parseArchetype(file.slice(0, -3), await readFile(path.join(DIR(), file), 'utf8'))
      if (parsed) archetypes.push(parsed)
    } catch {
      /* unreadable archetype — skip it */
    }
  }
  return archetypes
}

/** One archetype as an AGENT DEFINITION, so a session can run a turn AS a
 *  specialist.
 *
 *  Two catalogues that stay separate on purpose — an agent is a mode a person
 *  chooses for a conversation, an archetype is a role work is handed to — but
 *  one turn path. An engagement's steps are real sessions (kernel/engagements.ts),
 *  and giving them their own way to run a turn would mean a second copy of
 *  history, events, approvals, abort and compaction, each free to drift from the
 *  one the rest of the machine uses. This is the whole adaptation: the same
 *  fields, filled from a file a person edits.
 *
 *  `readOnly` carries across because it is the only one that is a promise
 *  rather than a preference — "investigates and reports" is a guarantee only if
 *  the investigator is never handed a tool that writes. `tier` carries across
 *  as a resolved model, so a step run AS a specialist is routed the same way a
 *  delegated one is. */
export async function archetypeAsAgent(name: string): Promise<{
  name: string
  description: string
  prompt: string
  model: string | null
  tools: Record<string, boolean>
  permission: Record<string, never>
  readOnly: boolean
  builtIn: boolean
  customised: boolean
} | null> {
  const archetype = (await listArchetypes()).find((entry) => entry.name === name)
  if (!archetype) return null
  return {
    name: archetype.name,
    description: archetype.description,
    prompt: archetype.prompt,
    /**
     *
     * The tier, resolved against this machine's own preferences. Null when the
     * archetype declares no tier or the owner configured no model for the one
     * it declares — and null here means "inherit", which the turn resolves.
     *
     **/
    model: archetype.tier ? await tierModelRef(archetype.tier) : null,
    tools: {},
    permission: {},
    readOnly: archetype.readOnly,
    builtIn: false,
    customised: false,
  }
}
