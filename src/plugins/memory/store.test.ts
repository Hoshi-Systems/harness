import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * ── The memory store ─────────────────────────────────────────────────────────
 *
 * This file format is the whole product surface of Hoshi's memory: the agent's
 * `memory_*` tools, the Customize screen's `/memory` routes and the AGENTS.md
 * digest the model is handed on every turn all read and write it.
 *
 * It went untested through the period when it existed TWICE — the tools carried
 * a private copy of the store, and the two drifted (docs/STRUCTURE_REVIEW.md
 * H-08). One implementation is what makes that class of bug impossible; a suite
 * over the format is what makes a change to it deliberate.
 *
 * The workspace root is selected at module load for ordinary direct-kernel
 * use, so this test points it at a scratch directory before importing the
 * store. State paths themselves are resolved through `hoshiFile()` at use
 * time, which is what lets an embedded harness select its own state root.
 *
 **/

let store: typeof import('./store.js')
let home: string
let workspace: string

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'hoshi-memory-'))
  workspace = path.join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  process.env.HOME = home
  process.env.WORKSPACE_ROOT = workspace
  store = await import('./store.js')
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('memory ids', () => {
  it('round-trips every scope', () => {
    for (const record of [
      { scope: 'user' as const, project: null, name: 'coffee' },
      { scope: 'org' as const, project: null, name: 'handbook' },
      { scope: 'project' as const, project: 'acme-web', name: 'deploys' },
    ]) {
      expect(store.parseMemoryId(store.memoryId(record))).toEqual(record)
    }
  })

  it('refuses an id it cannot resolve, rather than guessing a scope', () => {
    for (const bad of ['', 'user', 'user:', 'project:acme', 'project:acme:', 'nope:x', 'user:a:b']) {
      expect(store.parseMemoryId(bad)).toBeNull()
    }
  })
})

describe('slugs', () => {
  it('is stable across the punctuation a model will actually write', () => {
    expect(store.slugifyMemoryName('Deploy Process (v2)')).toBe('deploy-process-v2')
    expect(store.slugifyMemoryName('  spaced  out  ')).toBe('spaced-out')
    expect(store.slugifyMemoryName('Ünïcødé')).toBe('n-c-d')
  })

  it('never returns an empty name, because a file needs one', () => {
    expect(store.slugifyMemoryName('!!!')).toBe('entry')
    expect(store.slugifyMemoryName('')).toBe('entry')
  })

  it('is bounded, so a model cannot name a file 4kB long', () => {
    expect(store.slugifyMemoryName('a'.repeat(500))).toHaveLength(80)
  })
})

describe('project scope', () => {
  it('resolves from the directory, not from anything the model says', () => {
    expect(store.projectSlugFromDirectory(path.join(workspace, 'acme', 'web'))).toBe('acme-web')
  })

  it('is null outside a checkout, so the caller can say so instead of writing to "no project"', () => {
    expect(store.projectSlugFromDirectory(workspace)).toBeNull()
    expect(store.projectSlugFromDirectory('/somewhere/else')).toBeNull()
  })

  it('takes the last two segments, so unrelated single-segment dirs cannot collide', () => {
    expect(store.projectSlugFromDirectory(path.join(workspace, 'a', 'b', 'c'))).toBe('b-c')
  })
})

describe('the file format', () => {
  const record = {
    scope: 'user' as const,
    project: null,
    name: 'coffee',
    description: 'How I take it',
    kind: 'preference' as const,
    content: 'Flat white, no sugar.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'user' as const,
    hasDocument: false,
  }

  it('writes frontmatter the parser can read back', () => {
    const text = store.serializeRecord(record)
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: coffee')
    expect(text).toContain('kind: preference')
    expect(text).toContain('source: user')
    expect(text.trimEnd().endsWith('Flat white, no sugar.')).toBe(true)
  })

  it('quotes a description that would otherwise break the frontmatter', () => {
    /**
     *
     * A colon is the field separator, so a description containing one has to be
     * quoted or the parser reads half of it. YAML's own answer, and the reason
     * `yamlString` exists.
     *
     **/
    const text = store.serializeRecord({ ...record, description: 'Rule: never decaf' })
    expect(text).toContain('description: "Rule: never decaf"')
  })

  it('mentions a document only when there is one', () => {
    expect(store.serializeRecord(record)).not.toContain('document:')
    expect(store.serializeRecord({ ...record, hasDocument: true })).toContain('document: true')
  })
})

describe('saving and reading back', () => {
  it('round-trips through a real file', async () => {
    const saved = await store.writeEntryFile({
      scope: 'user',
      project: null,
      name: 'Coffee Order',
      description: 'How I take it',
      kind: 'preference',
      content: 'Flat white, no sugar.',
      source: 'user',
    })
    const read = await store.readEntry('user', null, saved.record.name)
    expect(read?.content).toBe('Flat white, no sugar.')
    expect(read?.kind).toBe('preference')
    expect(read?.name).toBe(saved.record.name)
  })

  it('updates in place rather than growing a second file', async () => {
    await store.writeEntryFile({
      scope: 'user',
      project: null,
      name: 'Coffee Order',
      description: 'How I take it',
      kind: 'preference',
      content: 'Decaf after four.',
      source: 'agent',
    })
    const all = (await store.listEntries('user', null)).filter((entry) => entry.name.startsWith('coffee'))
    expect(all).toHaveLength(1)
    expect(all[0]?.content).toBe('Decaf after four.')
  })

  it('refuses to write into org scope, which is a read-only mirror of the Platform', async () => {
    await expect(
      store.writeEntryFile({
        scope: 'org',
        project: null,
        name: 'handbook',
        description: 'ours',
        kind: 'reference',
        content: 'nope',
        source: 'agent',
      }),
    ).rejects.toBeInstanceOf(store.OrgMemoryReadOnlyError)
  })

  it('removes an entry file, and says whether there was one', async () => {
    expect(await store.removeEntryFile('user', null, 'coffee-order')).toBe(true)
    expect(await store.removeEntryFile('user', null, 'coffee-order')).toBe(false)
  })
})
