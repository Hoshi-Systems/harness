import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 *
 * ~/.hoshi is the machine's own durable store (on the /data volume of
 * provisioned machines) for anything OpenCode's global config can't hold: its
 * schema rejects foreign top-level keys at file load (boot error) and its
 * PATCH silently drops them (verified live on 1.17.13). One small JSON file
 * per concern — preferences.json (utils/preferences.ts), schedules.json
 * (utils/triggers.ts) — siblings of the seeder's profile-state.json.
 *
 **/

/** Absolute path of a file inside ~/.hoshi. */
export function hoshiFile(name: string): string {
  return path.join(process.env.HOME ?? homedir(), '.hoshi', name)
}

/** Parse a ~/.hoshi JSON file; null when missing or unreadable.
 *
 *  Lossy ON PURPOSE for read-only callers: a store that cannot be read is, for
 *  display, the same as one that isn't there. Any caller that READ-MODIFY-WRITES
 *  the file must use `readHoshiJsonStrict` instead — see the note there. */
export async function readHoshiJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** A ~/.hoshi file exists but does not parse. */
export class CorruptStoreError extends Error {}

/** Parse a ~/.hoshi JSON file, distinguishing "not there" from "not readable":
 *  null when missing, `CorruptStoreError` when present and unparseable.
 *
 *  The distinction is load-bearing for read-modify-write. Collapsing both to
 *  null makes a corrupt file look empty, so the merge step starts from `[]` and
 *  the write REPLACES the user's data with whatever the current call was
 *  adding — one stray character in the file costs every entry in it. A caller
 *  that cannot read the existing contents must refuse to write, not overwrite. */
export async function readHoshiJsonStrict<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new CorruptStoreError(`${file} exists but is not valid JSON: ${(error as Error).message}`)
  }
}

/** Write any file under ~/.hoshi atomically (tmp + rename) — other processes on
 *  the machine (the hoshi-router plugin, the seeder, the memory tools) read
 *  these concurrently. Shared by the JSON stores below and by utils/memory.ts,
 *  which writes markdown records into the same tree. */
export async function writeHoshiAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** Write a ~/.hoshi JSON file atomically. */
export async function writeHoshiJson(file: string, data: unknown): Promise<void> {
  await writeHoshiAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}
