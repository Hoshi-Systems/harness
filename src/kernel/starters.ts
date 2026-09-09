import { readFile } from 'node:fs/promises'
import { hoshiFile } from './store.js'

/**
 * ── The three things worth trying first ──────────────────────────────────────
 *
 * A machine seeded for a business analyst used to offer "Fix a bug", "Add
 * tests" and "Build a landing page", because the launcher's suggestions were a
 * constant compiled into the web client — the same nine on every machine, for
 * every role, forever.
 *
 * They come from the PRESET now, which is why they are read here rather than
 * hard-coded anywhere: a preset is content, so adding a role is writing content,
 * and an organization publishing its own preset gets its own starters without a
 * line of client code changing.
 *
 * Seeded to `starters.json` in the machine's configuration directory, like the
 * archetypes beside it. A preset that ships none simply has none — the launcher
 * shows its composer and nothing else, which is a better answer than somebody
 * else's suggestions.
 *
 **/

export interface Starter {
  /** The button. Short — it sits in a row of three. */
  label: string
  /**
   *
   * What is actually sent, which is deliberately much longer than the label.
   * A starter has one job: produce something real in one turn. "Build a landing
   * page" as a prompt produces a conversation about landing pages; the prompt
   * below says where to put it, that it must actually run, and what to report
   * back — and that difference is the whole feature.
   *
   **/
  prompt: string
}

const FILE = () => hoshiFile('starters.json')

/**
 *
 * This machine's starters, or none.
 *
 * Every failure is the same answer — an absent file, a malformed one, an entry
 * missing its prompt — because there is no version of "the suggestions are
 * broken" worth showing a person on their first screen. A machine with no
 * readable starters has no starters.
 *
 **/
export async function listStarters(): Promise<Starter[]> {
  let raw: string
  try {
    raw = await readFile(FILE(), 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('[starters] starters.json is not valid JSON — offering none')
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { label, prompt } = entry as Record<string, unknown>
    if (typeof label !== 'string' || typeof prompt !== 'string') return []
    const trimmedLabel = label.trim()
    const trimmedPrompt = prompt.trim()
    if (!trimmedLabel || !trimmedPrompt) return []
    return [{ label: trimmedLabel, prompt: trimmedPrompt }]
  })
}
