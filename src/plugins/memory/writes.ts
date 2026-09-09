import { regenerateAgentsIndex } from './agents-index.js'
import {
  removeEntryFile,
  replaceScopeFiles,
  writeEntryFile,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from './store.js'

/**
 * ── Writing memory, index included ───────────────────────────────────────────
 *
 * Every write to memory has to be followed by regenerating the AGENTS.md
 * managed region: that region is the always-in-context digest, so an entry the
 * model saved and cannot then see is worse than one it never saved.
 *
 * `store.ts` used to call `regenerateAgentsIndex()` itself, which made the two
 * modules a cycle — the index reads every entry back out of the store it is
 * called from. Nothing broke, because both halves happen to be function
 * declarations rather than import-time work; the hazard is that a cycle makes
 * evaluation ORDER decide what is defined, and the symptom arrives as an
 * undefined function at runtime on a path nobody exercised.
 *
 * So the dependency is inverted here rather than removed: the store does I/O
 * and knows nothing about the digest, the digest reads the store, and this
 * module is the only thing that knows both. It is what every caller reaches
 * for — the routes and the tools alike.
 *
 * The store's own mutators are named for what they are (`writeEntryFile`,
 * `removeEntryFile`, `replaceScopeFiles`) precisely so that reaching past this
 * module does not compile: there is no `saveEntry` there to import by mistake.
 *
 **/

export async function saveEntry(input: Parameters<typeof writeEntryFile>[0]): ReturnType<typeof writeEntryFile> {
  const result = await writeEntryFile(input)
  await regenerateAgentsIndex()
  return result
}

export async function forgetEntry(scope: MemoryScope, project: string | null, name: string): Promise<boolean> {
  const found = await removeEntryFile(scope, project, name)
  /** Regenerated even when nothing was found: the caller asked for a state, and
   *  a digest that disagrees with the files is the failure this exists to
   *  prevent. Cheap — it is one file write. */
  await regenerateAgentsIndex()
  return found
}

export async function replaceScope(
  scope: MemoryScope,
  project: string | null,
  entries: Array<{ name: string; description: string; kind: MemoryKind; content: string }>,
): Promise<MemoryRecord[]> {
  const saved = await replaceScopeFiles(scope, project, entries)
  await regenerateAgentsIndex()
  return saved
}
