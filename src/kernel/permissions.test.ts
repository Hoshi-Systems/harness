import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_ANSWERS } from '../wire/index.js'
import {
  answer,
  ask,
  ASK_RESPONSES,
  cancelAsksFor,
  clearLevel,
  defaultLevelFor,
  levelFor,
  listAsks,
  setLevel,
  type PendingAsk,
  type PermissionResolution,
} from './permissions.js'
import { configureKernel } from './host-ports.js'

/**
 *
 * The regression these guard is not "the wrong thing happened" — it is that
 * NOTHING happened. The previous engine imported the alert and audit sinks and
 * never called either, so a permission ask raised no alert on any channel the
 * owner watches and no decision was ever recorded, and both failures are
 * silent by construction: the turn still blocks, the card still appears, and
 * the only symptom is a machine that sits waiting while nobody is told.
 *
 * A test that asserts the ports are CALLED is therefore the guard. Everything
 * else about alerting and auditing belongs to whoever installs the ports.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-permissions-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

let asked: PendingAsk[]
let resolved: Array<{ ask: PendingAsk; resolution: PermissionResolution; granted: boolean }>

beforeEach(() => {
  asked = []
  resolved = []
  configureKernel({
    permissionAsked: (entry) => {
      asked.push(entry)
    },
    permissionResolved: (entry, resolution, granted) => {
      resolved.push({ ask: entry, resolution, granted })
    },
  })
  for (const pending of listAsks()) cancelAsksFor(pending.sessionId)
  asked = []
  resolved = []
})

function raise(sessionId: string) {
  const pending = ask({ sessionId, directory: home, tool: 'bash', input: { command: 'echo hoshi' } })
  const entry = listAsks().find((candidate) => candidate.sessionId === sessionId)!
  return { pending, entry }
}

describe('the answer vocabulary', () => {
  /**
   *
   * The one assertion that would have caught the split-vocabulary outage: the
   * machine and the clients each had their own idea of what an answer is
   * spelled, and every test on both sides passed because neither side ever
   * read the other's. The unit tests below call `answer()` DIRECTLY, so they
   * never see the wire; the census only ever sent `allow` and `always`, so it
   * never sent the value that was broken. Nothing spanned the seam.
   *
   * @hoshi/shared is what every client answers from, so pinning to it is
   * pinning to them. A dev dependency on purpose — test files are excluded
   * from tsconfig.build.json, so this never reaches the emitted daemon.
   *
   **/
  it('is exactly what @hoshi/shared publishes to the clients', () => {
    expect([...ASK_RESPONSES]).toEqual([...PERMISSION_ANSWERS])
  })

  it('has no synonym for a refusal — `deny` is a tool LEVEL, not an answer', () => {
    expect(ASK_RESPONSES).not.toContain('deny')
    expect(ASK_RESPONSES).toContain('reject')
  })

  it('has no synonym for a one-time allow — the TUI sent `once` and was refused', () => {
    expect(ASK_RESPONSES).not.toContain('once')
    expect(ASK_RESPONSES).toContain('allow')
  })
})

describe('a pending ask', () => {
  it('tells the host, with everything it needs to name what is being asked', async () => {
    const { pending, entry } = raise('ses_alert')
    expect(asked).toHaveLength(1)
    /**
     *
     * The whole ask: a host cannot say which project is blocked without the
     * directory, nor what for without the input.
     *
     **/
    expect(asked[0]!.id).toBe(entry.id)
    expect(asked[0]!.directory).toBe(home)
    expect(asked[0]!.tool).toBe('bash')
    expect(asked[0]!.input).toEqual({ command: 'echo hoshi' })

    await answer(entry.id, 'allow')
    await pending
  })
})

describe('how an ask ended', () => {
  it('reports an approval as granted', async () => {
    const { pending, entry } = raise('ses_allow')
    await answer(entry.id, 'allow')
    expect(await pending).toBe(true)
    expect(resolved).toEqual([
      { ask: expect.objectContaining({ id: entry.id }), resolution: 'answered', granted: true },
    ])
  })

  it('reports a refusal as answered, not as absent', async () => {
    /**
     *
     * "The user said no" and "nobody answered" are different facts, and an
     * audit trail that cannot tell them apart is not a record of decisions.
     *
     **/
    const { pending, entry } = raise('ses_deny')
    await answer(entry.id, 'reject')
    expect(await pending).toBe(false)
    expect(resolved[0]!.resolution).toBe('answered')
    expect(resolved[0]!.granted).toBe(false)
  })

  it('reports a turn that went away as cancelled', async () => {
    const { pending } = raise('ses_gone')
    cancelAsksFor('ses_gone')
    expect(await pending).toBe(false)
    expect(resolved[0]!.resolution).toBe('cancelled')
    expect(resolved[0]!.granted).toBe(false)
  })

  it('never hands the host the promise resolver it is holding', async () => {
    /**
     *
     * `strip` exists for this: the live ask carries the function that unblocks
     * the turn, and a host that could call it would be answering on the user's
     * behalf.
     *
     **/
    const { pending, entry } = raise('ses_strip')
    await answer(entry.id, 'allow')
    await pending
    expect('resolve' in resolved[0]!.ask).toBe(false)
    expect('resolve' in asked[0]!).toBe(false)
  })
})

describe('a harness with no host', () => {
  it('still asks, and still settles', async () => {
    /**
     *
     * Every port is optional. A machine with no alert channels and no audit
     * trail is a perfectly good machine, and must not be a broken one.
     *
     **/
    configureKernel({})
    const { pending, entry } = raise('ses_bare')
    await answer(entry.id, 'allow')
    expect(await pending).toBe(true)
  })
})

describe('the level a tool has when nobody has ruled on it', () => {
  /**
   *
   * The rule is an ALLOWLIST — what the machine ships and vouches for — rather
   * than "anything that is not a connector", and these are the two halves of
   * why. A connector's tool names are only known once it has connected
   * (plugins/mcp/index.ts contributes none on purpose), so there is no set of
   * them to exclude from; and a tool nobody here recognises has to land on
   * `ask`, which is the direction this can afford to be wrong in.
   *
   **/
  it('allows the machine’s own tools, so an unattended turn is not stopped by its own box', () => {
    for (const tool of ['read', 'list', 'grep', 'write', 'edit', 'browser_navigate', 'git_branch', 'context_open']) {
      expect(defaultLevelFor(tool)).toBe('allow')
    }
  })

  it('still asks about the five that execute, remove or publish', () => {
    for (const tool of ['bash', 'delete', 'git_commit', 'git_pr', 'process_start']) {
      expect(defaultLevelFor(tool)).toBe('ask')
    }
  })

  it('asks about anything it cannot vouch for', () => {
    /**
     *
     * A connector's tools arrive namespaced `server_tool` — with an UNDERSCORE,
     * not a colon, which is why matching them by shape was never an option.
     * They are simply not in the list, and neither is anything else invented.
     *
     **/
    expect(defaultLevelFor('linear_create_issue')).toBe('ask')
    expect(defaultLevelFor('acme:deploy')).toBe('ask')
    expect(defaultLevelFor('some_tool_added_next_year')).toBe('ask')
  })

  it('is what levelFor answers on a machine with an empty store', async () => {
    expect(await levelFor('read')).toBe('allow')
    expect(await levelFor('bash', { command: 'rm -rf /' })).toBe('ask')
  })

  it('never outranks a level somebody set', async () => {
    await setLevel('read', 'deny')
    expect(await levelFor('read')).toBe('deny')
    await setLevel('bash', 'allow')
    expect(await levelFor('bash', { command: 'ls' })).toBe('allow')
    /**
     *
     * And clearing it returns the tool to ITS OWN default, which is no longer
     * the same value for every tool — the surface that shows a row reads this
     * same function, so a row cannot say `ask` about a tool that runs unasked.
     *
     **/
    await clearLevel('read')
    expect(await levelFor('read')).toBe('allow')
    await clearLevel('bash')
    expect(await levelFor('bash', { command: 'ls' })).toBe('ask')
  })
})
