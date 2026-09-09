import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createSerialQueue } from './serialize.js'
import { WORKSPACE_ROOT } from './workspace.js'

/**
 *
 * The Platform owns checkout truth (id, name, status, boilerplate) but the
 * machine has no DB, so it caches what the Platform pushes here — a small JSON
 * manifest on the workspace volume. GET /projects joins it against the live disk
 * scan (utils/workspace.ts) so the machine can answer with the fully-merged list
 * without a request-time call back to the Platform.
 * Under the workspace root but dotfile-prefixed, so scanWorkspace() skips it.
 *
 **/
const MANIFEST_PATH = path.join(WORKSPACE_ROOT, '.hoshi', 'checkouts.json')

export type CheckoutStatus = 'provisioning' | 'ready' | 'error'

/**
 *
 * One stage of the provisioning pipeline. The machine PRODUCES these; the
 * Platform mirrors the latest snapshot back so GET /projects can surface it —
 * so it is one wire shape with two writers, and it used to be written out on
 * both sides with a comment ("mirrors the Platform's shape") holding it
 * together. `@hoshi/shared` is the contract both declare against, which is the
 * whole reason that package exists; the two APIs still share no CODE
 * (docs/STRUCTURE_REVIEW.md P-05).
 *
 **/
import type { ProvisionStage } from '../wire/index.js'
export type { ProvisionStage, StageStatus } from '../wire/index.js'

/** A checkout as the Platform knows it, mirrored onto the machine. `directory`
 *  is the join key back to the live workspace scan. */
export interface CheckoutMeta {
  id: string
  directory: string
  name: string
  boilerplateId: string | null
  status: CheckoutStatus
  error: string | null
  /** The staged provisioning pipeline snapshot; null outside a provision. */
  stages: ProvisionStage[] | null
  /** Free-form labels from the create wizard (Platform-owned). */
  tags: string[]
  /** The project's picture, Platform-owned like `tags` and mirrored here only so
   *  a client reading the machine's project list gets it in the same call. The
   *  machine never sets it and never serves the file. */
  imageUrl?: string | null
  updatedAt: string
}

/**
 *
 * All mutations are read-modify-write on one file, so serialize them — concurrent
 * pushes (a status flip racing a rename) would otherwise clobber each other.
 *
 **/
const serialize = createSerialQueue()

async function readManifest(): Promise<Record<string, CheckoutMeta>> {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, CheckoutMeta>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    /**
     *
     * A fresh machine has no manifest yet — that's an empty set, not a failure.
     *
     **/
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeManifest(manifest: Record<string, CheckoutMeta>): Promise<void> {
  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

/** Every checkout the Platform has pushed to this machine. */
export function listCheckoutMeta(): Promise<CheckoutMeta[]> {
  return serialize(async () => Object.values(await readManifest()))
}

/** Replace the entire manifest with the Platform's current set (a full reconcile).
 *  Checkouts absent from `metas` are dropped, so a stale ghost — a checkout the
 *  Platform deleted but whose per-id un-mirror was missed — stops appearing in the
 *  merge (its directory falls back to an untracked dir). */
export function replaceAllCheckoutMeta(metas: CheckoutMeta[]): Promise<void> {
  return serialize(async () => {
    const manifest: Record<string, CheckoutMeta> = {}
    for (const meta of metas) manifest[meta.id] = meta
    await writeManifest(manifest)
  })
}

/** Upsert a checkout's mirrored metadata (Platform push on create/status/rename). */
export function upsertCheckoutMeta(meta: CheckoutMeta): Promise<void> {
  return serialize(async () => {
    const manifest = await readManifest()
    manifest[meta.id] = meta
    await writeManifest(manifest)
  })
}

/** Drop a checkout by id (Platform push on delete). */
export function removeCheckoutMeta(id: string): Promise<void> {
  return serialize(async () => {
    const manifest = await readManifest()
    if (!(id in manifest)) return
    delete manifest[id]
    await writeManifest(manifest)
  })
}

/** Drop any checkout mirrored at a directory — the on-disk delete path keys by
 *  directory, not id (an untracked-dir cleanup has no id to key on). */
export function removeCheckoutMetaByDirectory(directory: string): Promise<void> {
  return serialize(async () => {
    const manifest = await readManifest()
    let changed = false
    for (const [id, meta] of Object.entries(manifest)) {
      if (meta.directory === directory) {
        delete manifest[id]
        changed = true
      }
    }
    if (changed) await writeManifest(manifest)
  })
}
