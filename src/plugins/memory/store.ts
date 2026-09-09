import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeHoshiAtomic, WORKSPACE_ROOT } from '../../kernel/index.js'
import { mirrorForget, mirrorSave } from './graph-mirror.js'

/**
 *
 * Hoshi's persistent memory, as storage.
 *
 * ONE implementation. There used to be two — this one behind the HTTP routes
 * and a second, in the separate package the tools lived in, behind the agent's
 * `memory_*` tools, 1,067 lines of it, with a comment on each asking
 * the next reader to keep them in lockstep (docs/STRUCTURE_REVIEW.md H-08).
 * They did not stay in lockstep. The tools live in ./tools.ts now and call this
 * file, which makes that class of bug impossible rather than merely discouraged.
 *
 * Three scopes, two of them writable. `user` and `project` are this machine's
 * own memory, written freely. `org` is the ORGANIZATION's curated knowledge,
 * mirrored here read-only by ./mirror.ts: reads see it, and a write
 * throws OrgMemoryReadOnlyError so both callers can turn it into a 403 or a
 * clear tool error rather than a silent no-op.
 *
 **/

const HOME = process.env.HOME ?? homedir()
const MEMORY_ROOT = path.join(HOME, '.hoshi', 'memory')
const USER_DIR = path.join(MEMORY_ROOT, 'user')
const PROJECTS_DIR = path.join(MEMORY_ROOT, 'projects')
/** The org knowledge mirror — a READ-ONLY copy of what the organization
 *  accepted, owned end to end by ./mirror.ts. Nothing in this module
 *  ever writes here (saveEntry/forgetEntry refuse the scope outright): "the
 *  agent cannot quietly rewrite org truth" is structural, not a prompt rule. */
export const ORG_DIR = path.join(MEMORY_ROOT, 'org')
/** Attached long-form markdown, one file per entry that has one. A
 *  subdirectory, not a `.doc.md` suffix beside the entries, so listing the
 *  mirror can never mistake a document for an entry. */
export const ORG_DOCUMENTS_DIR = path.join(ORG_DIR, 'documents')

export type MemoryKind = 'preference' | 'fact' | 'feedback' | 'decision' | 'lesson' | 'reference'
export type MemoryScope = 'user' | 'project' | 'org'
export type MemorySource = 'agent' | 'user'

export const MEMORY_KINDS: MemoryKind[] = ['preference', 'fact', 'feedback', 'decision', 'lesson', 'reference']

export interface MemoryRecord {
  scope: MemoryScope
  project: string | null
  name: string
  description: string
  kind: MemoryKind
  content: string
  createdAt: string
  updatedAt: string
  source: MemorySource
  /** An org entry with a long-form document attached (a handbook, an ADR, a
   *  glossary). Never true for user/project entries — those are short facts.
   *  The body is read on demand (`readOrgDocument`), never inlined anywhere
   *  that costs a turn it isn't used in. */
  hasDocument: boolean
}

/** `id` shape used by the REST routes: `user:<slug>`,
 *  `project:<project-slug>:<slug>`, or `org:<slug>`. */
export function parseMemoryId(id: string): { scope: MemoryScope; project: string | null; name: string } | null {
  const parts = id.split(':')
  if (parts[0] === 'user' && parts.length === 2 && parts[1]) {
    return { scope: 'user', project: null, name: parts[1] }
  }
  if (parts[0] === 'org' && parts.length === 2 && parts[1]) {
    return { scope: 'org', project: null, name: parts[1] }
  }
  if (parts[0] === 'project' && parts.length === 3 && parts[1] && parts[2]) {
    return { scope: 'project', project: parts[1], name: parts[2] }
  }
  return null
}

export function memoryId(record: Pick<MemoryRecord, 'scope' | 'project' | 'name'>): string {
  return record.scope === 'project' ? `project:${record.project}:${record.name}` : `${record.scope}:${record.name}`
}

/** Package-internal (also used by ./mirror.ts, which writes the mirror
 *  these paths address) — not part of the memory API. */
export function orgFilePath(name: string): string {
  return path.join(ORG_DIR, `${slugify(name)}.md`)
}

export function orgDocumentPath(name: string): string {
  return path.join(ORG_DOCUMENTS_DIR, `${slugify(name)}.md`)
}

/** An attached document's markdown, or null when the entry has none. Read on
 *  demand — by the agent through its ordinary file tools, and by the app
 *  through `GET /memory/{id}/document`. */
export async function readOrgDocument(name: string): Promise<string | null> {
  return readOptional(orgDocumentPath(name))
}

export function slugifyMemoryName(input: string): string {
  return slugify(input)
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'entry'
}

/** Project scope resolves from the session's `directory` — the workspace
 *  checkout it is rooted in — to a stable slug, never from a name the model
 *  supplies (so two calls in the same project always land in the same file).
 *  Workspace layout is `<WORKSPACE_ROOT>/<org-slug>/<project-slug>`; the slug is
 *  the last two path segments joined and sanitized, so collisions across
 *  unrelated single-segment dirs are avoided while staying short. Returns null
 *  outside a workspace checkout (the personal space, say) — callers turn that
 *  into a clear error rather than silently writing to "no project". */
export function projectSlugFromDirectory(directory: string): string | null {
  const resolved = path.resolve(directory)
  const root = path.resolve(WORKSPACE_ROOT)
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean)
  if (segments.length === 0) return null
  return slugify(segments.slice(-2).join('-'))
}

function userFilePath(name: string): string {
  return path.join(USER_DIR, `${slugify(name)}.md`)
}

function projectFilePath(project: string, name: string): string {
  return path.join(PROJECTS_DIR, slugify(project), `${slugify(name)}.md`)
}

function projectDir(project: string): string {
  return path.join(PROJECTS_DIR, slugify(project))
}

/**
 *
 * ── Frontmatter ──
 *
 **/

/** Package-internal (also used by ./mirror.ts, which writes mirrored
 *  entries in exactly this format so they parse back as ordinary records). */
export function serializeRecord(record: MemoryRecord): string {
  const front = [
    '---',
    `name: ${record.name}`,
    `description: ${yamlString(record.description)}`,
    `kind: ${record.kind}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    `source: ${record.source}`,
    ...(record.hasDocument ? ['document: true'] : []),
    '---',
    '',
  ].join('\n')
  return `${front}${record.content.trim()}\n`
}

function yamlString(value: string): string {
  if (/^[\w .,!?()/-]*$/.test(value) && value.trim() === value) return value
  return JSON.stringify(value)
}

function parseRecord(raw: string): Omit<MemoryRecord, 'scope' | 'project'> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return null
  const front = match[1] ?? ''
  const body = match[2] ?? ''
  const fields: Record<string, string> = {}
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        /* keep raw */
      }
    }
    fields[key] = value
  }
  if (!fields.name || !fields.kind) return null
  return {
    name: fields.name,
    description: fields.description ?? '',
    kind: (MEMORY_KINDS.includes(fields.kind as MemoryKind) ? fields.kind : 'fact') as MemoryKind,
    content: body.replace(/\s+$/, ''),
    createdAt: fields.createdAt ?? new Date().toISOString(),
    updatedAt: fields.updatedAt ?? fields.createdAt ?? new Date().toISOString(),
    source: fields.source === 'user' ? 'user' : 'agent',
    hasDocument: fields.document === 'true',
  }
}

/**
 * ── Atomic file I/O ──────────────────────────────────────────────────────────
 *
 **/

/** Package-internal (also used by ./agents-index.ts) — not part of the memory API. */
export async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
  } catch {
    return []
  }
}

/** Package-internal (also used by ./agents-index.ts) — not part of the memory API. */
export async function listProjectSlugs(): Promise<string[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * ── Store ────────────────────────────────────────────────────────────────────
 *
 **/

function scopeDir(scope: MemoryScope, project: string | null): string {
  if (scope === 'user') return USER_DIR
  if (scope === 'org') return ORG_DIR
  return projectDir(project!)
}

function scopeFilePath(scope: MemoryScope, project: string | null, name: string): string {
  if (scope === 'user') return userFilePath(name)
  if (scope === 'org') return orgFilePath(name)
  return projectFilePath(project!, name)
}

export async function readEntry(
  scope: MemoryScope,
  project: string | null,
  name: string,
): Promise<MemoryRecord | null> {
  const raw = await readOptional(scopeFilePath(scope, project, name))
  if (!raw) return null
  const parsed = parseRecord(raw)
  if (!parsed) return null
  return { ...parsed, scope, project: scope === 'project' ? slugify(project!) : null }
}

export async function listEntries(scope: MemoryScope, project: string | null): Promise<MemoryRecord[]> {
  const dir = scopeDir(scope, project)
  const files = await listMdFiles(dir)
  const records: MemoryRecord[] = []
  for (const file of files) {
    const raw = await readOptional(path.join(dir, file))
    if (!raw) continue
    const parsed = parseRecord(raw)
    if (!parsed) continue
    records.push({ ...parsed, scope, project: scope === 'project' ? slugify(project!) : null })
  }
  records.sort((a, b) => a.name.localeCompare(b.name))
  return records
}

/** Every memory entry on the machine — all three scopes, every project — for
 *  the Customize → Memory panel's full list view. Org entries ride along in the
 *  same response deliberately: the panel shows one memory surface, with the org
 *  group simply rendered read-only. */
export async function listAllEntries(): Promise<MemoryRecord[]> {
  const user = await listEntries('user', null)
  const org = await listEntries('org', null)
  const projects = await listProjectSlugs()
  const projectEntries = (await Promise.all(projects.map((p) => listEntries('project', p)))).flat()
  return [...user, ...org, ...projectEntries]
}

export interface SaveInput {
  scope: MemoryScope
  project: string | null
  name: string
  description: string
  kind: MemoryKind
  content: string
  source: MemorySource
}

export interface SaveResult {
  record: MemoryRecord
  updated: boolean
}

/** Raised when a write targets the org mirror. Org knowledge is curated on the
 *  Platform and mirrored here read-only, so there is no local write to make —
 *  callers turn this into a 403 (routes) or a clear tool error (the plugin)
 *  rather than a silent no-op that would let the two sides diverge. */
export class OrgMemoryReadOnlyError extends Error {
  constructor() {
    super(
      'Organization knowledge is read-only on this machine. Propose a change instead — a curator with permission accepts it, and it then reaches every machine in the organization.',
    )
    this.name = 'OrgMemoryReadOnlyError'
  }
}

export async function writeEntryFile(input: SaveInput): Promise<SaveResult> {
  if (input.scope === 'org') throw new OrgMemoryReadOnlyError()
  const existing = await readEntry(input.scope, input.project, input.name)
  const now = new Date().toISOString()
  const record: MemoryRecord = {
    scope: input.scope,
    project: input.scope === 'project' ? slugify(input.project!) : null,
    name: slugify(input.name),
    description: input.description.trim(),
    kind: input.kind,
    content: input.content.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    source: input.source,
    hasDocument: false,
  }
  const file = input.scope === 'user' ? userFilePath(record.name) : projectFilePath(input.project!, record.name)
  await writeHoshiAtomic(file, serializeRecord(record))
  void mirrorSave(record).catch(() => {})
  return { record, updated: !!existing }
}

export async function removeEntryFile(scope: MemoryScope, project: string | null, name: string): Promise<boolean> {
  if (scope === 'org') throw new OrgMemoryReadOnlyError()
  const file = scope === 'user' ? userFilePath(name) : projectFilePath(project!, name)
  try {
    await rm(file, { force: false })
  } catch {
    return false
  }
  void mirrorForget(scope, scope === 'project' ? slugify(project!) : null, slugify(name)).catch(() => {})
  return true
}

/** Replace a whole scope's entries with a merged/rewritten set — the second
 *  half of `memory_consolidate`: the model does the judgment (merge duplicates,
 *  drop stale entries), this does the I/O. Entries not present in `replace` are
 *  deleted; entries present are upserted. Source stays "agent", since
 *  consolidation is itself an agent action. */
export async function replaceScopeFiles(
  scope: MemoryScope,
  project: string | null,
  entries: Array<{ name: string; description: string; kind: MemoryKind; content: string }>,
): Promise<MemoryRecord[]> {
  if (scope === 'org') throw new OrgMemoryReadOnlyError()
  const before = await listEntries(scope, project)
  const keep = new Set(entries.map((entry) => slugify(entry.name)))
  for (const old of before) {
    if (keep.has(old.name)) continue
    await rm(scope === 'user' ? userFilePath(old.name) : projectFilePath(project!, old.name), { force: true })
    void mirrorForget(scope, scope === 'project' ? slugify(project!) : null, old.name).catch(() => {})
  }
  const saved: MemoryRecord[] = []
  for (const entry of entries) {
    const { record } = await writeEntryFile({ ...entry, scope, project, source: 'agent' })
    saved.push(record)
  }
  return saved
}

/**
 *
 * ── Project discovery (for the "which projects have memory" list + validation) ──
 *
 **/

/** Project slugs known to this machine's OpenCode-managed session directory
 *  scheme — sourced the same way the plugin derives them from a session's
 *  `directory` (last two workspace-relative path segments), but here listed
 *  from the live checkout scan so the API can validate a `project` query
 *  param without needing a running session. */
export async function knownProjectSlugs(): Promise<string[]> {
  const slugs = new Set<string>()
  try {
    const orgs = await readdir(WORKSPACE_ROOT, { withFileTypes: true })
    for (const org of orgs) {
      if (!org.isDirectory() || org.name.startsWith('.')) continue
      const projects = await readdir(path.join(WORKSPACE_ROOT, org.name), { withFileTypes: true }).catch(() => [])
      for (const project of projects) {
        if (!project.isDirectory()) continue
        slugs.add(slugify(`${org.name}-${project.name}`))
      }
    }
  } catch {
    /* no workspace yet — empty */
  }
  /**
   *
   * Also include any project that already has a memory directory (may be a
   * project whose checkout was since removed but its memory should stay
   * browsable/editable).
   *
   **/
  for (const slug of await listProjectSlugs()) slugs.add(slug)
  return [...slugs].sort()
}
