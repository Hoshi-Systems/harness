import { forgetEntry, replaceScope, saveEntry } from './writes.js'
import { bindTools, defineHoshiTool, jsonish, z, type HoshiToolFactories, type HoshiToolSet } from '../define-tool.js'
import type { PluginToolContext } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import { backfillGraphOnce } from './graph-backfill.js'
import { graphEnabled, graphSearchScope, type SearchHit } from './graph-mirror.js'
import { ports } from './host.js'
import {
  listEntries,
  MEMORY_KINDS,
  projectSlugFromDirectory,
  slugifyMemoryName as slugify,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from './store.js'

/**
 * ── The agent's memory tools ─────────────────────────────────────────────────
 *
 * The six `memory_*` tools a turn can call. They lived in a package of their
 * own, next to a second, private copy of the
 * whole store — the file format, the AGENTS.md index, the search mirror
 * and the org proposal, all written twice and held together by a comment on
 * each half asking the next reader to keep them in step
 * (docs/STRUCTURE_REVIEW.md H-08). Now they sit in the plugin that already owns
 * the store, beside the HTTP routes that serve the same files, and every body
 * below calls ./store.ts.
 *
 * They keep `defineHoshiTool` (../define-tool.ts) — it is what gives a tool its
 * `title`/`output`/`metadata` shape, and `jsonish` for models that send JSON
 * strings where objects were asked for. What moved is the storage, not the tool
 * contract.
 *
 * Contributed through `host.tools.add`, exactly like the MCP connectors and the
 * widget tools: the kernel cannot tell one source of tools from another, which
 * is why none of them had to be built into it.
 *
 **/

/** The session's directory is where project scope comes from — never a name the
 *  model supplies. Outside a checkout there is no project to write to, and
 *  saying so is better than silently writing somewhere else. */
function requireProjectSlug(directory: string): string {
  const slug = projectSlugFromDirectory(directory)
  if (!slug) {
    throw new Error(
      'This session isn\'t rooted in a project checkout, so there is no project to save memory against. Use scope "user" instead, or ask the user to open a project.',
    )
  }
  return slug
}

/** Appended to any recall/list output that contains org entries. Scope is not
 *  cosmetic here: "this is organization policy" and "you mentioned this on
 *  Tuesday" carry very different weight, and an answer that flattens the two is
 *  wrong even when the fact is right. */
const ORG_ATTRIBUTION_NOTE =
  'Entries under "org" are the ORGANIZATION\'s curated knowledge, not this user\'s. When an answer rests on one, attribute it as organization policy/knowledge — never present it as something the user told you. They are read-only: propose a change with memory_save (scope "org") instead of editing. An entry with "hasDocument": true has long-form markdown at ~/.hoshi/memory/org/documents/<name>.md — read that file when the entry alone is not enough.'

const memorySave = defineHoshiTool({
  description: [
    'Save (or update) a durable memory entry about the user or the current project.',
    'Call this proactively, not only when asked: user preferences, decisions made together, corrections the user gives, and — at the end of substantive work — one compact lesson learned.',
    'Saving again with the same name UPDATES that entry in place (no duplicates) — reuse the same name for the same fact instead of creating a near-duplicate.',
    "scope 'project' resolves the project from the current session's directory; it fails outside a project checkout.",
    "scope 'org' does NOT write: it PROPOSES the entry to the organization, and a person with permission decides whether it becomes shared knowledge. Use it sparingly and only for something true of the whole organization — a convention, a decision, a piece of product vocabulary — never for anything personal or project-local.",
  ].join(' '),
  args: {
    scope: z.enum(['user', 'project', 'org']).describe('Whose memory this belongs to'),
    name: z.string().describe("Stable short key, e.g. 'prefers-pnpm' — reuse an existing name to update it"),
    description: z.string().describe('One-line summary shown in the index'),
    kind: z
      .enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]])
      .describe('preference | fact | feedback | decision | lesson | reference'),
    content: z.string().describe('The full memory content (a few sentences to a short paragraph)'),
  },
  async execute(args, context) {
    if (args.scope === 'org') {
      const reviewer = ports().orgKnowledge?.()
      if (!reviewer) {
        throw new Error(
          'This machine has nobody behind it who curates shared knowledge, so there is no organization to propose to. Save it under scope "user" or "project" instead.',
        )
      }
      const { name } = await reviewer.propose({
        name: args.name,
        description: args.description,
        kind: args.kind,
        content: args.content,
        source: 'agent',
      })
      return {
        title: `Proposed to the organization: ${name}`,
        output: `Sent "${name}" to the organization's knowledge review queue. It is NOT shared knowledge yet and no other machine can see it — someone with permission to curate must accept it first. Tell the user that, rather than implying it's already org policy.`,
        metadata: { hoshi: { memory: { action: 'save', updated: false, scope: 'org', project: null, name } } },
      }
    }
    const project = args.scope === 'project' ? requireProjectSlug(context.directory) : null
    const { record, updated } = await saveEntry({
      scope: args.scope,
      project,
      name: args.name,
      description: args.description,
      kind: args.kind,
      content: args.content,
      source: 'agent',
    })
    return {
      title: `${updated ? 'Updated' : 'Saved'}: ${record.name}`,
      output: `${updated ? 'Updated' : 'Saved'} ${args.scope} memory "${record.name}" (${record.kind}).`,
      metadata: {
        hoshi: {
          memory: {
            action: 'save',
            updated,
            scope: record.scope,
            project: record.project,
            name: record.name,
            description: record.description,
            kind: record.kind,
          },
        },
      },
    }
  },
})

const memoryRecall = defineHoshiTool({
  description: [
    'Recall memory: with no names, returns the index (name + description) for the given scope(s).',
    'With names, returns the full content of those entries.',
    'Call this when starting substantive work in a project — its memory is never in your always-on context, only user and organization memory are.',
    "scope 'org' is the organization's shared, curated knowledge — read-only, and it must be attributed as such in your answer.",
  ].join(' '),
  args: {
    scope: z.enum(['user', 'project', 'org']).optional().describe('Omit to recall every scope'),
    names: z.array(z.string()).optional().describe('Specific entry names to fetch in full; omit for the index only'),
  },
  async execute(args, context) {
    const scopes: MemoryScope[] = args.scope ? [args.scope] : ['user', 'org', 'project']
    const project = scopes.includes('project') ? projectSlugFromDirectory(context.directory) : null

    const results: Record<string, MemoryRecord[]> = {}
    for (const scope of scopes) {
      if (scope === 'project' && !project) continue
      const all = await listEntries(scope, project)
      results[scope] = args.names?.length ? all.filter((r) => args.names!.map(slugify).includes(r.name)) : all
    }

    const summary = Object.entries(results)
      .map(([scope, records]) => `${scope} (${records.length}): ${records.map((r) => r.name).join(', ') || 'none'}`)
      .join('\n')
    const body = args.names?.length
      ? JSON.stringify(results, null, 2)
      : `${summary}\n\nCall memory_recall with "names" to get full entry content.`
    return {
      title: 'Memory',
      output: results.org?.length ? `${body}\n\n${ORG_ATTRIBUTION_NOTE}` : body,
      metadata: { hoshi: { memory: { action: 'recall', scope: args.scope ?? 'all' } } },
    }
  },
})

const memoryForget = defineHoshiTool({
  description: [
    'Delete a memory entry by scope and name. Use when a fact is no longer true or the user asks you to forget it.',
    "Organization knowledge cannot be deleted from here — it is curated on the Platform, so ask the user to have a curator retire it. That's why 'org' is not an option below.",
  ].join(' '),
  args: {
    scope: z.enum(['user', 'project']).describe('Which scope the entry belongs to'),
    name: z.string().describe("The entry's name"),
  },
  async execute(args, context) {
    const project = args.scope === 'project' ? requireProjectSlug(context.directory) : null
    const found = await forgetEntry(args.scope, project, args.name)
    return {
      title: found ? `Forgot: ${args.name}` : 'Not found',
      output: found
        ? `Deleted ${args.scope} memory "${slugify(args.name)}".`
        : `No ${args.scope} memory named "${args.name}" was found.`,
      metadata: {
        hoshi: { memory: { action: 'forget', found, scope: args.scope, project, name: slugify(args.name) } },
      },
    }
  },
})

const memoryList = defineHoshiTool({
  description:
    'List every memory index (user, the organization, and the current project if any) in one call — model-facing overview; the app UI uses its own routes.',
  args: {},
  async execute(_args, context) {
    const project = projectSlugFromDirectory(context.directory)
    const user = await listEntries('user', null)
    const org = await listEntries('org', null)
    const projectEntries = project ? await listEntries('project', project) : []
    const body = JSON.stringify(
      {
        user: user.map(({ name, description, kind }) => ({ name, description, kind })),
        org: org.map(({ name, description, kind, hasDocument }) => ({ name, description, kind, hasDocument })),
        project: project
          ? {
              slug: project,
              entries: projectEntries.map(({ name, description, kind }) => ({ name, description, kind })),
            }
          : null,
      },
      null,
      2,
    )
    return {
      title: 'Memory index',
      output: org.length > 0 ? `${body}\n\n${ORG_ATTRIBUTION_NOTE}` : body,
      metadata: { hoshi: { memory: { action: 'list' } } },
    }
  },
})

const memorySearch = defineHoshiTool({
  description: [
    "Full-text search memory by meaning/keywords when you don't already know an entry's exact name — memory_recall needs the exact name, this doesn't.",
    'Backed by a machine-local search graph (CYB-81); degrades to zero results if that graph is unavailable on this machine. An empty result does not mean no memory exists — fall back to memory_list/memory_recall if you expected a hit and got none.',
  ].join(' '),
  args: {
    query: z
      .string()
      .describe("Search text — keywords or a short natural-language description of what you're looking for"),
    scope: z.enum(['user', 'project', 'org']).optional().describe('Omit to search every scope'),
  },
  async execute(args, context) {
    if (!graphEnabled()) {
      return {
        title: 'Memory search unavailable',
        output:
          'Memory search is disabled on this machine (MACHINE_MEMORY_GRAPH=off). Use memory_recall or memory_list instead.',
        metadata: { hoshi: { memory: { action: 'search', available: false } } },
      }
    }
    await backfillGraphOnce()
    const project = projectSlugFromDirectory(context.directory)
    const scopes: MemoryScope[] = args.scope ? [args.scope] : ['user', 'org', 'project']
    const results: SearchHit[] = []
    for (const scope of scopes) {
      if (scope === 'project' && !project) continue
      const hits = await graphSearchScope(args.query, scope)
      results.push(...(scope === 'project' ? hits.filter((h) => h.project === project) : hits))
    }
    results.sort((a, b) => b.score - a.score)
    const top = results.slice(0, 10)
    return {
      title: `Memory search: ${results.length} ${results.length === 1 ? 'hit' : 'hits'}`,
      output:
        results.length > 0
          ? `${JSON.stringify(top, null, 2)}${top.some((hit) => hit.scope === 'org') ? `\n\n${ORG_ATTRIBUTION_NOTE}` : ''}`
          : 'No matches (or the memory graph is temporarily unavailable — try memory_recall/memory_list if you expected a hit).',
      metadata: { hoshi: { memory: { action: 'search', query: args.query, count: results.length } } },
    }
  },
})

const memoryConsolidate = defineHoshiTool({
  description: [
    "Two-step consolidation of a memory scope. Call with just 'scope' first: returns every entry's full content so you can judge what to merge/drop.",
    "Then call again with the same 'scope' plus 'replace' — the full rewritten entry set — to apply it. Entries omitted from 'replace' are deleted; this is a full replace of the scope, not a patch.",
    'Use when the user-scope index passes ~40 entries, or when asked to clean up memory.',
    "Organization knowledge is curated on the Platform, not here, so 'org' is not an option below.",
  ].join(' '),
  args: {
    scope: z.enum(['user', 'project']).describe('Which scope to consolidate'),
    /**
     *
     * Each entry is `jsonish`: a model that sends the array full of JSON
     * strings instead of objects gets its call run rather than refused. Seen in
     * the wild, and the failure was worse than a refusal — the tool did not
     * run, and the model reported to the user that their memory had been
     * consolidated anyway.
     *
     **/
    replace: z
      .array(
        jsonish(
          z.object({
            name: z.string(),
            description: z.string(),
            kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]),
            content: z.string(),
          }),
        ),
      )
      .optional()
      .describe('Omit to fetch the current full content; provide to apply the merged/rewritten set'),
  },
  async execute(args, context) {
    const project = args.scope === 'project' ? requireProjectSlug(context.directory) : null

    if (!args.replace) {
      const entries = await listEntries(args.scope, project)
      return {
        title: `Consolidate ${args.scope} memory`,
        output: JSON.stringify(entries, null, 2),
        metadata: { hoshi: { memory: { action: 'consolidate-read', scope: args.scope, count: entries.length } } },
      }
    }

    const saved = await replaceScope(args.scope, project, args.replace)
    return {
      title: `Consolidated ${args.scope} memory`,
      output: `${args.scope} memory now has ${saved.length} ${saved.length === 1 ? 'entry' : 'entries'}.`,
      metadata: { hoshi: { memory: { action: 'consolidate-write', scope: args.scope, count: saved.length } } },
    }
  },
})

const factories: HoshiToolFactories = {
  memory_save: memorySave,
  memory_recall: memoryRecall,
  memory_forget: memoryForget,
  memory_list: memoryList,
  memory_search: memorySearch,
  memory_consolidate: memoryConsolidate,
}

/** The names alone, with no turn to bind to — the permission screen has to list
 *  every tool the machine HAS, not only the ones a session happens to run. */
export function memoryToolNames(): string[] {
  return Object.keys(factories)
}

export function memoryTools(context: PluginToolContext): HoshiToolSet {
  return bindTools(factories, machineToolContext(context))
}
