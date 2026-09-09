import { chmod, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeHoshiAtomic } from '../../kernel/index.js'
import { regenerateAgentsIndex } from './agents-index.js'
import { mirrorForget, mirrorSave } from './graph-mirror.js'
import {
  MEMORY_KINDS,
  ORG_DIR,
  ORG_DOCUMENTS_DIR,
  orgDocumentPath,
  orgFilePath,
  serializeRecord,
  slugifyMemoryName,
  type MemoryKind,
  type MemoryRecord,
} from './store.js'

/**
 * ── The read-only shelf ──────────────────────────────────────────────────────
 *
 * `org` is the one memory scope this machine does not write: somebody outside
 * it curates that knowledge, and this module is where their accepted set lands
 * — answered as the `memoryMirror` port, so whoever fetches it (the Platform
 * plugin, today) never learns how memory is laid out on disk, and this plugin
 * never learns where the knowledge came from.
 *
 * Three rules shape everything here, and they are the inverse of an asset
 * library's:
 *
 *  1. The mirror is READ-ONLY ON DISK, not by convention. Entry files land 0444
 *     inside a 0555 directory, so an agent that edits one gets EACCES and says
 *     so, instead of quietly diverging from what the rest of the org believes.
 *     This module is the only writer, and it opens the tree just long enough to
 *     write before locking it again.
 *  2. Replacing is SAFE to do unattended: it writes plain markdown under
 *     ~/.hoshi/memory and nothing else, so it can never abort an in-flight
 *     generation.
 *  3. A replace REPLACES the mirror rather than patching it. That single choice
 *     is what makes a retired entry actually disappear from every machine
 *     instead of lingering as an orphan nobody can reach to remove.
 *
 **/

/**
 *
 * 0555 on the directories is what stops an agent CREATING or DELETING a file in
 * the mirror; 0444 on the files is what stops it rewriting one. The daemon
 * runs as the same user that owns them, so it unlocks, writes, and re-locks —
 * an agent could technically chmod too, but then it has visibly forced its way
 * in rather than silently drifted, which is the guarantee that matters.
 *
 **/
const LOCKED_DIR = 0o555
const UNLOCKED_DIR = 0o755
const LOCKED_FILE = 0o444
const UNLOCKED_FILE = 0o644

export interface MirroredEntry {
  name: string
  description: string
  kind: string
  content: string
  document: string | null
  createdAt: string
  updatedAt: string
}

async function unlockMirror(): Promise<void> {
  /** Parent before child, each time: a locked ORG_DIR would refuse the mkdir
   *  that creates (or re-creates) the documents directory inside it. */
  await mkdir(ORG_DIR, { recursive: true })
  await chmod(ORG_DIR, UNLOCKED_DIR).catch(() => {})
  await mkdir(ORG_DOCUMENTS_DIR, { recursive: true })
  await chmod(ORG_DOCUMENTS_DIR, UNLOCKED_DIR).catch(() => {})
  for (const dir of [ORG_DIR, ORG_DOCUMENTS_DIR]) {
    for (const file of await listMarkdown(dir)) {
      await chmod(path.join(dir, file), UNLOCKED_FILE).catch(() => {})
    }
  }
}

async function lockMirror(): Promise<void> {
  for (const dir of [ORG_DIR, ORG_DOCUMENTS_DIR]) {
    for (const file of await listMarkdown(dir)) {
      await chmod(path.join(dir, file), LOCKED_FILE).catch(() => {})
    }
  }
  /** Documents first: locking the parent before the child would make the
   *  child unreachable to chmod on some filesystems. */
  await chmod(ORG_DOCUMENTS_DIR, LOCKED_DIR).catch(() => {})
  await chmod(ORG_DIR, LOCKED_DIR).catch(() => {})
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
  } catch {
    return []
  }
}

function isMemoryKind(kind: string): kind is MemoryKind {
  return (MEMORY_KINDS as string[]).includes(kind)
}

/** Replace the shelf with `entries`, then regenerate the AGENTS.md index so
 *  the change is visible to the model on its very next turn. */
async function replaceOrg(entries: MirroredEntry[]): Promise<{ entries: number; documents: number }> {
  /**
   *
   * Refused whole, before a byte is written: a kind this plugin does not know
   * is a curator's bug upstream, and a shelf half-replaced around it would be
   * the worse outcome. The message names the entry so the bug is findable.
   *
   **/
  for (const entry of entries) {
    if (!isMemoryKind(entry.kind)) {
      throw new Error(`"${entry.name}" has kind "${entry.kind}"; memory knows ${MEMORY_KINDS.join(', ')}.`)
    }
  }

  await unlockMirror()
  try {
    const keep = new Set<string>()
    const keepDocuments = new Set<string>()
    for (const entry of entries) {
      const name = slugifyMemoryName(entry.name)
      if (!name) continue
      const record: MemoryRecord = {
        scope: 'org',
        project: null,
        name,
        description: entry.description,
        kind: entry.kind as MemoryKind,
        content: entry.content,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        /** Every mirrored entry reads as user-authored: a human accepted it,
         *  which is exactly what separates curated truth from an agent's own
         *  notes. */
        source: 'user',
        hasDocument: !!entry.document,
      }
      keep.add(`${name}.md`)
      await writeHoshiAtomic(orgFilePath(name), serializeRecord(record))
      if (entry.document) {
        keepDocuments.add(`${name}.md`)
        await writeHoshiAtomic(orgDocumentPath(name), `${entry.document.trimEnd()}\n`)
      }
      /** Fold the document into what bm25 indexes so a handbook is findable by
       *  its contents, without it ever being inlined into a recall. */
      void mirrorSave(record, entry.document ? `${entry.content}\n\n${entry.document}` : undefined).catch(() => {})
    }

    /** Replace, don't patch — rule 3 at the top of this file. */
    for (const file of await listMarkdown(ORG_DIR)) {
      if (keep.has(file)) continue
      await rm(path.join(ORG_DIR, file), { force: true })
      void mirrorForget('org', null, file.replace(/\.md$/, '')).catch(() => {})
    }
    for (const file of await listMarkdown(ORG_DOCUMENTS_DIR)) {
      if (!keepDocuments.has(file)) await rm(path.join(ORG_DOCUMENTS_DIR, file), { force: true })
    }
  } finally {
    await lockMirror()
  }

  await regenerateAgentsIndex()
  return { entries: entries.length, documents: entries.filter((entry) => !!entry.document).length }
}

/** What this plugin answers on the `memoryMirror` port. */
export function memoryMirror() {
  return { kinds: () => MEMORY_KINDS, replaceOrg }
}
