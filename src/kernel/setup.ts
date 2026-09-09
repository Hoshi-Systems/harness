import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'

/**
 * ── Has this machine been set up? ────────────────────────────────────────────
 *
 * One boolean, one file: `~/.hoshi/setup.json`. It records that a person has
 * walked the machine's first-run wizard — provider, integrations, meeting the
 * agent — or chose to skip it, which is the same answer: nobody asks again.
 *
 * It is a machine fact rather than a browser one on purpose. The first version
 * of "have we done this" a client can reach for is `localStorage`, and that one
 * answers per browser: the desktop app and a second laptop both open on a
 * wizard the person already finished. The machine's own durable store is the
 * only place every client reads the same answer from, and it goes away with the
 * volume — a re-provisioned machine really is new, and is asked again.
 *
 * Deliberately NOT a preference. `preferences.json` is what Customize edits,
 * and a "set up" flag in a settings screen is a checkbox nobody should be able
 * to tick. Nor is it inferred from memory: the agent's chosen name is a fact
 * about the relationship, and deleting it must not resurrect a wizard.
 *
 **/

interface SetupState {
  /** When the wizard was finished or skipped, ISO 8601. */
  completedAt: string
}

const FILE = () => hoshiFile('setup.json')

/** Whether the first-run wizard has been finished or skipped on this machine. */
export async function readSetupCompleted(): Promise<boolean> {
  const state = await readHoshiJson<Partial<SetupState>>(FILE())
  return typeof state?.completedAt === 'string' && state.completedAt.length > 0
}

/** Record that setup is done. Idempotent: a second completion keeps the first
 *  timestamp, because "when was this machine set up" has one answer. */
export async function markSetupComplete(): Promise<void> {
  if (await readSetupCompleted()) return
  await writeHoshiJson(FILE(), { completedAt: new Date().toISOString() } satisfies SetupState)
}
