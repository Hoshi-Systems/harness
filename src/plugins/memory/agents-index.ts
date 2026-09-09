import { homedir } from 'node:os'
import path from 'node:path'
import { writeHoshiAtomic } from '../../kernel/index.js'
import {
  listEntries,
  listProjectSlugs,
  MEMORY_KINDS,
  readOptional,
  type MemoryKind,
  type MemoryRecord,
} from './store.js'

/**
 *
 * The AGENTS.md managed index — the always-in-context digest of the memory
 * store that the model sees on every turn.
 *
 * There is ONE renderer, and there is a reason to say so. A second copy used to
 * live beside the agent's `memory_*` tools, with a comment on each half asking
 * the next reader to keep them in lockstep; they drifted anyway. This side
 * silently dropped the Generative UI block, so any Customize edit erased
 * instructions the tool side would put back on the next `memory_save`. The
 * tools call ./store.ts now (docs/STRUCTURE_REVIEW.md H-08), which is what
 * makes that impossible rather than merely discouraged.
 *
 **/

const HOME = process.env.HOME ?? homedir()
/** The machine's own state directory — where the profile is laid down and
 *  where the turn reads this file from. It used to sit under the config dir of
 *  a foreign agent binary, which nothing on this machine opened. */
const AGENTS_MD_PATH = path.join(HOME, '.hoshi', 'AGENTS.md')

const MANAGED_START = '<!-- hoshi:managed:start -->'
const MANAGED_END = '<!-- hoshi:managed:end -->'
const CONSOLIDATE_HINT_THRESHOLD = 40
/**
 *
 * Hard cap on how many entries renderIndexLines inlines into AGENTS.md. An
 * index that grows without bound stops being an index: it costs every turn's
 * context and buries the entries that matter, so past this many the region
 * says how many were omitted and tells the model to search rather than
 * assume.
 *
 **/
const MAX_INDEX_ENTRIES = 30

/**
 *
 * RESERVED ENTRY — `assistant-identity` (user scope, kind "fact"): the
 * personal agent's display name, written by `/onboard`. A normal
 * `memory_save` with a well-known `name` — user-editable and deletable like
 * any entry, nothing enforces it beyond convention. regenerateAgentsIndex()
 * renders it as an identity instruction scoped to the personal agent only, so
 * ephemeral recruits never role-play the name.
 *
 **/
const ASSISTANT_IDENTITY_NAME = 'assistant-identity'

function groupByKind(records: MemoryRecord[]): Map<MemoryKind, MemoryRecord[]> {
  const groups = new Map<MemoryKind, MemoryRecord[]>()
  for (const record of records) {
    const list = groups.get(record.kind) ?? []
    list.push(record)
    groups.set(record.kind, list)
  }
  return groups
}

function renderIndexLines(records: MemoryRecord[]): string[] {
  if (records.length === 0) return ['_No entries yet._']
  const shown = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_INDEX_ENTRIES)
  const groups = groupByKind(shown)
  const lines: string[] = []
  for (const kind of MEMORY_KINDS) {
    const entries = groups.get(kind)
    if (!entries?.length) continue
    lines.push(`**${kind}**`)
    for (const entry of entries) lines.push(`- ${entry.name} — ${entry.description || entry.content.split('\n')[0]}`)
  }
  const omitted = records.length - shown.length
  if (omitted > 0) {
    lines.push(
      `_…and ${omitted} older ${omitted === 1 ? 'entry' : 'entries'} not shown — call \`memory_search\` or \`memory_list\` rather than assuming from this index._`,
    )
  }
  return lines
}

/** The org knowledge block — the shared, curated half of memory. Rendered only
 *  on a machine that actually belongs to an organization, so a local/static
 *  machine's standing prompt never carries instructions about a thing it has
 *  no access to.
 *
 *  Org entries ARE inlined here (unlike project memory), because organizational
 *  truth is exactly the context an agent must not have to think to ask for —
 *  the curated write path is what keeps the set small enough to afford. Attached
 *  documents are NOT inlined: only the fact that one exists, and where. */
function renderOrgSection(orgEntries: MemoryRecord[]): string[] {
  if (orgEntries.length === 0 && !process.env.MACHINE_ORG_ID) return []
  const lines: string[] = []
  lines.push('## Organization knowledge')
  lines.push('')
  lines.push(
    `Curated, organization-wide memory, mirrored here READ-ONLY at \`~/.hoshi/memory/org/\` (${orgEntries.length} ${orgEntries.length === 1 ? 'entry' : 'entries'}):`,
  )
  lines.push('')
  if (orgEntries.length === 0) {
    lines.push('_Nothing yet._')
  } else {
    const groups = groupByKind([...orgEntries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    for (const kind of MEMORY_KINDS) {
      const entries = groups.get(kind)
      if (!entries?.length) continue
      lines.push(`**${kind}**`)
      for (const entry of entries) {
        lines.push(
          `- ${entry.name} — ${entry.description || entry.content.split('\n')[0]}${entry.hasDocument ? ' _(document)_' : ''}`,
        )
      }
    }
  }
  lines.push('')
  lines.push(
    '- **Attribute it.** When an answer rests on one of these, say so — "this is organization policy/knowledge", not "you told me". A shared organizational fact and something the user mentioned on Tuesday carry very different weight, and must never be presented as the same kind of thing.',
  )
  lines.push(
    '- **You cannot change it.** These files are read-only by design. `memory_save` with scope `"org"` sends a PROPOSAL a person reviews — use it only for something genuinely true of the whole organization, never for anything personal or project-local. `memory_forget`/`memory_consolidate` do not apply to this scope.',
  )
  lines.push(
    '- **Read the documents.** An entry marked _(document)_ has long-form markdown at `~/.hoshi/memory/org/documents/<name>.md` — read that file when the one-line entry is not enough. Never guess at its contents.',
  )
  lines.push('')
  return lines
}

/** Rebuild the AGENTS.md managed region after any write — a `memory_*` tool
 *  call or an edit made from Customize — so the index the model sees on its
 *  very next turn is current either way. */
export async function regenerateAgentsIndex(): Promise<void> {
  const userEntries = await listEntries('user', null)
  const orgEntries = await listEntries('org', null)
  const projectSlugs = await listProjectSlugs()
  const identity = userEntries.find((e) => e.name === ASSISTANT_IDENTITY_NAME)

  const lines: string[] = []
  lines.push(MANAGED_START)
  lines.push(
    '<!-- Hoshi-managed content. Do not edit by hand between these markers — a',
    '     re-seed or memory write overwrites this region only. -->',
  )
  lines.push('')
  if (identity?.content.trim()) {
    lines.push('## Identity')
    lines.push('')
    lines.push(
      `The user calls their personal agent **${identity.content.trim()}**. If you ARE the personal agent (\`hoshi\`), speak as ${identity.content.trim()} from now on. This does not apply to ephemeral recruits — they never role-play this name.`,
    )
    lines.push('')
  }
  lines.push('## Memory')
  lines.push('')
  lines.push(`User memory (${userEntries.length} ${userEntries.length === 1 ? 'entry' : 'entries'}):`)
  lines.push('')
  lines.push(...renderIndexLines(userEntries))
  lines.push('')
  if (projectSlugs.length > 0) {
    lines.push(
      `Project memory exists for: ${projectSlugs.join(', ')}. Call \`memory_recall\` (scope: "project") when starting substantive work in a project — never assume its contents from this index.`,
    )
  } else {
    lines.push(
      'No project memory yet. Call `memory_recall` (scope: "project") when starting substantive work in a project.',
    )
  }
  lines.push('')
  lines.push('### Learning discipline (aggressive — save proactively, not only on request)')
  lines.push('')
  lines.push(
    '- **Always save immediately**: explicit "remember this"-type requests; user preferences revealed in passing (tools, style, language, workflow); decisions made with the user; corrections the user gives — save as `feedback` with the why.',
  )
  lines.push(
    '- **Save at task end**: one compact `lesson` entry (project scope) — what was tried and failed, gotchas, non-obvious constraints. Not a transcript.',
  )
  lines.push('- **Never save**: session-local trivia, anything derivable from the repo/git, secrets.')
  lines.push(
    '- `memory_save` updates in place when a name already exists — reuse the same name instead of creating near-duplicates.',
  )
  lines.push(
    "- Don't know an entry's exact name? Use `memory_search` (full-text, not name-based) instead of guessing at `memory_recall` names.",
  )
  if (userEntries.length > CONSOLIDATE_HINT_THRESHOLD) {
    lines.push(
      `- User memory has grown past ${CONSOLIDATE_HINT_THRESHOLD} entries (${userEntries.length}) — run \`/consolidate-memory\` or \`memory_consolidate\` soon.`,
    )
  }
  lines.push('')
  lines.push(...renderOrgSection(orgEntries))
  lines.push('## Generative UI')
  lines.push('')
  lines.push(
    "The chat renders rich interactive UI, not just text — `ui_render` (display), `ui_ask` (blocking structured input), `ui_html` (escape hatch when the catalog can't express the visual). Whenever structured data or a real decision is the answer, use them instead of prose — never print a markdown table of numbers, never ask for structured input in plain text.",
  )
  lines.push('')
  lines.push(
    "The `hgl` skill is the ONLY authoritative reference for the document format these tools accept. Read it before building UI for the first time in a session, and read it again whenever you are even slightly unsure how to express a surface — never emit HGL from memory of an older format. Don't re-describe rendered UI in text; the user already sees it.",
  )
  lines.push('')
  /**
   *
   * RESTORED. This block lived only in the SEEDED copy
   * (packages/machine-profile/base/AGENTS.md) and never here, so it survived
   * exactly until the first `memory_save` regenerated the managed region and
   * wrote over it — the same silent drift the header of this file describes,
   * one section along. A machine that had been running for a day answered
   * "draw me a logo" with a paragraph describing one.
   *
   **/
  lines.push('## Images')
  lines.push('')
  lines.push(
    "When the user asks for a picture — an illustration, logo, asset, or an edit of an existing image — use `image_generate` (it drives this machine's image-capable AI model and shows the result in the chat). Never answer such requests with a text description of what the image would look like. Charts and data views are NOT images — those are `ui_render`'s job.",
  )
  lines.push('')
  lines.push('## Session naming')
  lines.push('')
  lines.push(
    'Name the session you are working in with `session_update { title }` — on your first turn, as soon as you know what the work is, and again whenever the subject genuinely moves on. A title is a short noun phrase saying what the work IS, in the user\'s own language, under about 50 characters ("Billing webhook signature migration") — never a status line, a greeting, or a restatement of your reply. Do not narrate that you named it; the user can see the name.',
  )
  lines.push('')
  lines.push(
    'A session the user named themselves is theirs — the tool leaves it alone, and so should you. `session_info` tells you the session you are in: its name, its directory, whether it was delegated to you, and what it has cost.',
  )
  lines.push('')
  lines.push('## Commit conventions')
  lines.push('')
  lines.push(
    'Author identity is already configured machine-wide (git config) — commit normally, no extra setup needed. Always add a trailer crediting yourself as co-author: `Co-Authored-By: Hoshi Agent <agent@hoshi.computer>`.',
  )
  lines.push(MANAGED_END)
  const region = lines.join('\n')

  const existing = await readOptional(AGENTS_MD_PATH)
  const merged = mergeManagedRegion(existing, region)
  await writeHoshiAtomic(AGENTS_MD_PATH, merged)
}

function mergeManagedRegion(existingContent: string | null, region: string): string {
  if (existingContent == null) return `${region}\n`
  const start = existingContent.indexOf(MANAGED_START)
  const end = existingContent.indexOf(MANAGED_END)
  if (start === -1 || end === -1 || end < start) {
    const trimmed = existingContent.replace(/\s+$/, '')
    return `${trimmed}\n\n${region}\n`
  }
  const before = existingContent.slice(0, start)
  const after = existingContent.slice(end + MANAGED_END.length)
  return `${before}${region}${after}`
}
