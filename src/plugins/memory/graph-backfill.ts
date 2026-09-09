import { graphEnabled, mirrorSave } from './graph-mirror.js'
import { listEntries, listProjectSlugs } from './store.js'

/**
 *
 * The one-shot sweep that seeds the search graph from what is already on disk.
 *
 * Its own file because it is the only piece that needs BOTH halves: it reads
 * the store and writes the mirror, and putting it in either one makes them
 * import each other (`scripts/check-cycles.mjs` says so, correctly — a cycle
 * makes import order decide what is defined).
 *
 **/

/**
 *
 * Runs once per process lifetime: mirrors every entry already on disk into the
 * graph, so `memory_search` covers entries saved before the graph existed on
 * this machine (or while it was unreachable). Best-effort like everything else
 * here — a failed sweep leaves those entries unsearchable until next saved,
 * not a broken machine. Triggered lazily from `memory_search` (the only caller
 * that needs the graph populated) rather than on every boot.
 *
 **/
let backfillAttempted = false
export async function backfillGraphOnce(): Promise<void> {
  if (backfillAttempted || !graphEnabled()) return
  backfillAttempted = true
  try {
    const projectSlugs = await listProjectSlugs()
    const projectEntries = (await Promise.all(projectSlugs.map((slug) => listEntries('project', slug)))).flat()
    /**
     *
     * Org entries are indexed by ./mirror.ts on every replace (it holds the
     * documents, which belong in the index too) — this sweep still covers them,
     * harmlessly, in case a machine's mirror predates that sync.
     *
     **/
    const all = [...(await listEntries('user', null)), ...(await listEntries('org', null)), ...projectEntries]
    for (const record of all) await mirrorSave(record).catch(() => {})
  } catch {
    /* best-effort — see the section header */
  }
}
