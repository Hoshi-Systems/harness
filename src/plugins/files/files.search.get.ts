import { defineEventHandler, getQuery } from 'h3'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { requireAuth, WORKSPACE_ROOT } from '../../kernel/index.js'

/** Find files by path, for the composer's `@file` picker.
 *
 *  Machine-side because the files are on the machine — a client cannot search a
 *  filesystem it has never seen, and the old wire only offered this because the
 *  runtime happened to expose it.
 *
 *  Subsequence matching, not substring: `apcmp` should find
 *  `app/components/…`, which is how anyone actually types a path they half
 *  remember. Ranked so that a match packed tightly at the end of the path — the
 *  filename — beats one scattered across directory names. */

/** Directories never worth walking. Bounded work matters more than
 *  completeness: a picker that takes four seconds is one nobody waits for. */
const SKIP = new Set(['.git', 'node_modules', '.nuxt', '.output', 'dist', 'build', '.next', 'target', '.venv'])
const MAX_RESULTS = 40
/** Walk ceiling. A workspace with a million files must still answer promptly;
 *  the query is a prefix filter people refine, not an exhaustive index. */
const MAX_VISITED = 20_000
const MAX_DEPTH = 12

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = String(getQuery(event).q ?? '').trim()
  if (!query) return { files: [] }

  const needle = query.toLowerCase()
  const scored: Array<{ file: string; score: number }> = []
  let visited = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_VISITED) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (visited >= MAX_VISITED) return
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      visited++
      const relative = path.relative(WORKSPACE_ROOT, full)
      const score = rank(relative.toLowerCase(), needle)
      if (score !== null) scored.push({ file: relative, score })
    }
  }
  await walk(WORKSPACE_ROOT, 0)

  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length)
  return { files: scored.slice(0, MAX_RESULTS).map((entry) => entry.file) }
})

/** How well `needle` fits inside `haystack` as a subsequence, lower being
 *  better. Null when it does not fit at all. The score is where the match
 *  starts plus how spread out it is, so a tight late match — the filename —
 *  sorts above the same letters strewn through parent directories. */
function rank(haystack: string, needle: string): number | null {
  let at = 0
  let first = -1
  let last = 0
  for (const character of needle) {
    const found = haystack.indexOf(character, at)
    if (found === -1) return null
    if (first === -1) first = found
    last = found
    at = found + 1
  }
  const spread = last - first
  const distanceFromEnd = haystack.length - last
  return spread * 2 + distanceFromEnd
}
