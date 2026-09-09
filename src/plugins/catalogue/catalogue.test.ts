import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import { bindTools } from '../define-tool.js'

/**
 * ── The machine authoring its own catalogue ──────────────────────────────────
 *
 * `skill_create` and `command_create` are the two tools whose arguments become
 * things ON THIS MACHINE — a directory name, a file, a command the user will
 * later invoke. The name comes from the model, so the slug is the guard in
 * front of the filesystem, and the frontmatter writer is the guard in front of
 * the skill index.
 *
 * Both fail silently when they fail. A skill whose frontmatter no longer parses
 * does not error — it simply stops appearing in the list the model is shown,
 * which is indistinguishable from never having been written.
 *
 * The scratch HOME goes in first so this direct-plugin test keeps all of its
 * state under a disposable directory.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'catalogue-'))
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = home

const { catalogueTools } = await import('./tools.js')

const created: Array<{ name: string; command: { template: string; description?: string } }> = []

function tool(name: 'skill_create' | 'command_create'): Tool {
  return bindTools(
    { [name]: catalogueTools[name]! },
    {
      sessionId: 'ses_1',
      directory: '/w/acme/api',
      worktree: '/w/acme/api',
      model: null,
      agent: 'hoshi',
      publish: vi.fn(),
      machine: {
        complete: async () => '',
        providers: async () => [],
        tierModel: async () => null,
        providerKey: async () => null,
        createCommand: async (commandName: string, command: { template: string; description?: string }) => {
          created.push({ name: commandName, command })
        },
        createSkill: async () => undefined,
      },
    },
  )[name]!
}

const run = (name: 'skill_create' | 'command_create', args: Record<string, unknown>) =>
  (
    tool(name).execute as (
      input: unknown,
      options: { abortSignal?: AbortSignal },
    ) => Promise<{ output: string; metadata?: Record<string, unknown> }>
  )(args, { abortSignal: undefined })

const skillsDir = path.join(home, '.hoshi', 'skills')
const skillFile = (slug: string) => path.join(skillsDir, slug, 'SKILL.md')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
})

describe('a skill name the model chose', () => {
  it('becomes a plain directory segment, whatever was asked for', async () => {
    /**
     *
     * The name reaches the filesystem. `../` surviving the slug would let a
     * turn write a SKILL.md anywhere the daemon can reach.
     *
     **/
    const result = await run('skill_create', {
      name: '../../../etc/cron.d/evil',
      description: 'nothing good',
      content: 'body',
    })
    const slug = (result.metadata as { hoshi: { internal: { name: string } } }).hoshi.internal.name
    expect(slug).not.toContain('/')
    expect(slug).not.toContain('..')
    expect(readFileSync(skillFile(slug), 'utf8')).toContain('body')
  })

  it('is lowercased and dashed, so the index and the directory agree', async () => {
    const result = await run('skill_create', {
      name: 'Deploy Checklist!!',
      description: 'how we ship',
      content: 'body',
    })
    expect(result.metadata).toMatchObject({ hoshi: { internal: { name: 'deploy-checklist', created: true } } })
  })

  it('never has an empty name, even when nothing survives the slug', async () => {
    const result = await run('skill_create', { name: '!!!', description: 'x', content: 'y' })
    expect(result.metadata).toMatchObject({ hoshi: { internal: { name: 'untitled' } } })
  })
})

describe('writing the skill file', () => {
  it('quotes a description that would otherwise break the frontmatter', async () => {
    /**
     *
     * A colon or a newline in an unquoted YAML scalar produces a document that
     * no longer parses — and a skill whose frontmatter does not parse is
     * silently absent from the list the model reads.
     *
     **/
    await run('skill_create', {
      name: 'tricky',
      description: 'ship: fast\nand safely',
      content: 'body',
    })
    const written = readFileSync(skillFile('tricky'), 'utf8')
    expect(written).toContain('description: "ship: fast\\nand safely"')
    expect(written.split('\n').filter((line) => line === '---')).toHaveLength(2)
  })

  it('refuses to write without a description or a body, rather than writing a stub', async () => {
    await expect(run('skill_create', { name: 'blank-a', description: '   ', content: 'body' })).rejects.toThrow(
      /description is required/,
    )
    await expect(run('skill_create', { name: 'blank-b', description: 'x', content: '  ' })).rejects.toThrow(
      /content is required/,
    )
  })

  it('NEVER overwrites an existing skill — it says so and changes nothing', async () => {
    /**
     *
     * Someone's hand-written skill is not the agent's to replace on a name
     * collision it did not know about.
     *
     **/
    mkdirSync(path.join(skillsDir, 'existing'), { recursive: true })
    writeFileSync(skillFile('existing'), 'the human wrote this')
    const result = await run('skill_create', { name: 'existing', description: 'x', content: 'y' })
    expect(result.metadata).toMatchObject({ hoshi: { internal: { created: false } } })
    expect(readFileSync(skillFile('existing'), 'utf8')).toBe('the human wrote this')
  })
})

describe('a command the machine writes for itself', () => {
  it('accepts the shape the /commands route accepts, and no more', async () => {
    /**
     *
     * Validation mirrors the route that does the same job, so a name this tool
     * accepts and that route refuses cannot exist.
     *
     **/
    for (const name of ['deploy', 'deploy-checklist', 'deploy_2']) {
      created.length = 0
      await run('command_create', { name, template: 'do the thing' })
      expect(created).toHaveLength(1)
    }
    for (const name of ['Deploy', 'deploy checklist', '-deploy', '../deploy', '', 'x'.repeat(65)]) {
      await expect(run('command_create', { name, template: 'do the thing' })).rejects.toThrow(
        /lowercase letters, digits, dashes/,
      )
    }
  })

  it('refuses an empty template — a command that dispatches nothing is a broken menu entry', async () => {
    await expect(run('command_create', { name: 'empty', template: '   ' })).rejects.toThrow(/template is required/)
  })

  it('passes the description through only when there is one', async () => {
    created.length = 0
    await run('command_create', { name: 'plain', template: 'go' })
    await run('command_create', { name: 'described', template: 'go', description: 'ship it' })
    expect(created.map((entry) => entry.command)).toEqual([
      { template: 'go' },
      { template: 'go', description: 'ship it' },
    ])
  })
})
