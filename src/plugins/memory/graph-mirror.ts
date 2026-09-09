import type { MemoryKind, MemoryRecord, MemoryScope } from './store.js'

/**
 *
 * Omnigraph search mirror (best-effort, CYB-81).
 *
 * Every store write is mirrored fire-and-forget, so an edit made from Customize
 * is searchable via the model's `memory_search` on its very next turn, and the
 * search itself reads back through here.
 *
 * This was two files as well — the tool side kept its own copy in the tool
 * package, and the two had already drifted: only this one folded
 * an attached document's body into the index (`searchText`), and only that one
 * could search or backfill (docs/STRUCTURE_REVIEW.md H-08). What survives is
 * the union.
 *
 **/

export function graphEnabled(): boolean {
  return (process.env.MACHINE_MEMORY_GRAPH ?? 'local') !== 'off'
}

const GRAPH_URL = process.env.HOSHI_MEMORY_GRAPH_URL ?? 'http://127.0.0.1:4098'
const GRAPH_ID = process.env.HOSHI_MEMORY_GRAPH_ID ?? 'memory'
const GRAPH_TIMEOUT_MS = 2000

async function graphRequest<T>(method: 'query' | 'mutate', body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GRAPH_URL}/graphs/${encodeURIComponent(GRAPH_ID)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`omnigraph ${method} ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

/** Insert-or-update one entry into the graph. Relies on the schema's
 *  `@key(scope, project, name)` to make a repeat insert of the same key an
 *  upsert rather than a conflict — unconfirmed against a live server (see
 *  docs/EVAL_OMNIGRAPH.md); a wrong assumption here just fails this one mirror
 *  call, never the caller's actual markdown save.
 *
 *  `searchText` overrides what bm25 indexes for this entry, leaving the stored
 *  `content` alone. The org mirror uses it to fold an attached document's body
 *  into the index — a handbook has to be FINDABLE without being inlined into
 *  every recall (and every turn's prompt), and the graph only ever returns
 *  name/description/kind anyway, never the indexed text. */
export async function mirrorSave(record: MemoryRecord, searchText?: string): Promise<void> {
  if (!graphEnabled()) return
  await graphRequest('mutate', {
    query:
      'query save($scope: String, $project: String, $name: String, $description: String, $kind: String, $content: String, $created_at: DateTime, $updated_at: DateTime, $source: String) { insert MemoryEntry { scope: $scope, project: $project, name: $name, description: $description, kind: $kind, content: $content, created_at: $created_at, updated_at: $updated_at, source: $source } }',
    name: 'save',
    params: {
      scope: record.scope,
      project: record.project,
      name: record.name,
      description: record.description,
      kind: record.kind,
      content: searchText ?? record.content,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      source: record.source,
    },
  })
}

/** `project` and `name` must already be canonical slugs (the store slugifies
 *  before calling) — the graph keys entries by slug, same as the file tree. */
export async function mirrorForget(scope: MemoryScope, project: string | null, name: string): Promise<void> {
  if (!graphEnabled()) return
  await graphRequest('mutate', {
    query:
      'query forget($scope: String, $project: String, $name: String) { delete MemoryEntry { scope: $scope, project: $project, name: $name } }',
    name: 'forget',
    params: { scope, project, name },
  })
}

export interface SearchHit {
  /** Which memory this came from. Present in the tool's own output on purpose:
   *  the model has to be able to tell an organization fact from a personal one
   *  when it writes the answer. */
  scope: MemoryScope
  name: string
  description: string
  kind: MemoryKind
  project: string | null
  score: number
}

/** GQ full-text query over `content` via bm25 — the actual capability gap this
 *  integration closes (recall is name-only). Returns [] on any graph failure
 *  (unreachable, schema mismatch, …) instead of throwing, so the caller can
 *  degrade to "use memory_recall/memory_list" without its own try/catch. */
export async function graphSearchScope(q: string, scope: MemoryScope): Promise<SearchHit[]> {
  if (!graphEnabled()) return []
  try {
    const result = await graphRequest<{ rows: Array<Record<string, unknown>> }>('query', {
      query:
        'query search($q: String, $scope: String) { match { $m: MemoryEntry { scope: $scope } } return { $m.name, $m.description, $m.kind, $m.project, bm25($m.content, $q) as score } order { score desc } limit 15 }',
      name: 'search',
      params: { q, scope },
    })
    return result.rows.map((row) => ({
      scope,
      name: String(row['$m.name']),
      description: String(row['$m.description'] ?? ''),
      kind: row['$m.kind'] as MemoryKind,
      project: (row['$m.project'] as string | null) ?? null,
      score: Number(row.score ?? 0),
    }))
  } catch {
    return []
  }
}
