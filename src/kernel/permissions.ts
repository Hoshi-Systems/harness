import { randomUUID } from 'node:crypto'
import type { PermissionAsk } from '../wire/index.js'
import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'
import { publishMachineEvent } from './events.js'
import { tell } from './host-ports.js'
import { foldRule, grantSuggestions, levelFromRules, subjectOf, type ToolRule } from './tool-patterns.js'

/**
 * ── Tool permissions ─────────────────────────────────────────────────────────
 *
 * Two halves that are easy to confuse and must not be:
 *
 *   LEVELS are policy — a durable per-tool rule (allow / ask / deny) the user
 *   edits in Customize. Changing one is a plain file write and NEVER costs a
 *   running turn: the level is read when a tool is about to run, not baked into
 *   a process at startup. Under the old runtime this was a global-config write
 *   that disposed the whole runtime, which is why "save a setting, lose your
 *   work" was a real bug and why a parking queue had to exist.
 *
 *   ASKS are events — one live question about one tool call, waiting for an
 *   answer. They live in memory because they belong to a turn in this process;
 *   an ask restored from disk would reference a turn that died with the previous
 *   one, and no client could ever resolve it.
 *
 * The ask is out-of-band by design (R4): it leaves the machine, reaches
 * whichever client is connected, waits as long as it takes, and may be answered
 * by a different client than the one that triggered the turn.
 *
 **/

const LEVELS = ['allow', 'ask', 'deny'] as const
export type Level = (typeof LEVELS)[number]

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

const LEVELS_FILE = () => hoshiFile('tool-permissions.json')

/**
 * ── What a tool's level is when nobody has said ──────────────────────────────
 *
 * Everything used to default to `ask`, and the reason given was a good one:
 * a machine that silently ran anything an agent asked for would be a worse
 * default than one that asks too often, because the first is discovered after
 * the damage and the second is only an annoyance.
 *
 * That is true of *anything*. It is not true of THIS MACHINE'S OWN TOOLS ON
 * THIS USER'S OWN MACHINE — one person's isolated box, provisioned for them and
 * reachable only by them. It is the same argument SYSTEM_TOOLS (kernel/tools.ts)
 * already makes for `ui_*`, `user_whoami` and the memory family, applied to the
 * rest of what the machine ships: asking to read a file, list a directory,
 * screenshot the page the agent just opened or tail the logs of a process it
 * started is friction with nothing behind it.
 *
 * And the annoyance was never only an annoyance. An UNATTENDED turn — a
 * schedule, a goal working overnight, a workflow step, a dispatched run — has
 * nobody to answer, and an ask has no timeout on purpose. So the practical
 * default for every automated surface the product has was "stop on the first
 * tool call and wait forever" until each user pre-granted, tool by tool, in
 * Customize.
 *
 * WRITTEN AS AN ALLOWLIST, deliberately, and not as "anything that is not a
 * connector". A connector's tool names are only known once it has been
 * connected to — plugins/mcp/index.ts reports none for exactly that reason — so
 * there is no set of them to exclude from. Naming what the machine vouches for
 * is the only form of this rule that can be true at the moment the gate needs
 * an answer, and it fails in the safe direction: a tool nobody here recognises
 * asks.
 *
 * The cost is that a tool added to the machine later asks until it is named
 * here. That is the direction to fail in, and this file's two neighbours
 * (SYSTEM_TOOLS, MUTATING) are hand-kept for the same reason.
 *
 **/

/** Every gated tool this machine ships — the inventory the rule is carved out
 *  of. The ungated ones are SYSTEM_TOOLS in kernel/tools.ts and never reach
 *  here; a connector's are absent because they cannot be known in advance. */
const SHIPPED = new Set([
  /** The library's file and shell tools, under the names kernel/tools.ts gives
   *  them. */
  'read',
  'list',
  'grep',
  'write',
  'edit',
  'delete',
  'bash',
  /** web-control. */
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_read_page',
  'browser_find',
  'browser_form_input',
  'browser_get_page_text',
  /** git. */
  'git_branch',
  'git_commit',
  'git_pr',
  /** The rest of what the machine ships. */
  'image_generate',
  'skill_create',
  'command_create',
  'project_create',
  'process_start',
  'process_stop',
  'process_list',
  'process_logs',
  'team_plan',
  'team_resume',
  'context_open',
])

/** Ours, and still worth a card.
 *
 *  NOT "the mutating ones" — kernel/tools.ts's MUTATING set answers a different
 *  question (what a read-only agent must not be handed) and includes `write`
 *  and `edit`, which are the ordinary work of a machine somebody provisioned in
 *  order to have work done. These five are the ones a person would want to have
 *  seen happen:
 *
 *    bash           runs whatever the model wrote, with the machine's own rights
 *    delete         removes what nothing here restores
 *    git_commit     writes into somebody else's repository
 *    git_pr         and publishes it, under the user's name
 *    process_start  long-lived, and it opens a port
 */
const ASKS_ANYWAY = new Set(['bash', 'delete', 'git_commit', 'git_pr', 'process_start'])

/** The level in force for a tool nobody has ruled on. */
export function defaultLevelFor(tool: string): Level {
  return SHIPPED.has(tool) && !ASKS_ANYWAY.has(tool) ? 'allow' : 'ask'
}

/** What is stored per tool. A bare level is still accepted — the file is
 *  hand-editable and older machines wrote it that way, and `{"bash": "allow"}`
 *  says exactly what it means. */
type StoredPolicy = Level | { level?: Level; rules?: ToolRule[] }

export interface ToolPolicy {
  /** The tool-wide level, when one is set. */
  level?: Level
  /** Pattern-scoped rules, checked before the level (engine/tool-patterns.ts). */
  rules: ToolRule[]
}

function normalizePolicy(stored: StoredPolicy | undefined): ToolPolicy | null {
  if (isLevel(stored)) return { level: stored, rules: [] }
  if (!stored || typeof stored !== 'object') return null
  const rules = (Array.isArray(stored.rules) ? stored.rules : []).filter(
    (rule): rule is ToolRule => !!rule && typeof rule.pattern === 'string' && !!rule.pattern && isLevel(rule.level),
  )
  const level = isLevel(stored.level) ? stored.level : undefined
  return level || rules.length > 0 ? { ...(level ? { level } : {}), rules } : null
}

export async function readPolicies(): Promise<Record<string, ToolPolicy>> {
  const data = await readHoshiJson<{ tools?: Record<string, StoredPolicy> }>(LEVELS_FILE())
  const out: Record<string, ToolPolicy> = {}
  for (const [tool, stored] of Object.entries(data?.tools ?? {})) {
    const policy = normalizePolicy(stored)
    if (policy) out[tool] = policy
  }
  return out
}

async function writePolicies(policies: Record<string, ToolPolicy>): Promise<void> {
  /**
   *
   * Written back in the simplest shape that carries the meaning: a tool with no
   * rules stays a bare level, so the common file keeps reading like one.
   *
   **/
  const tools: Record<string, StoredPolicy> = {}
  for (const [tool, policy] of Object.entries(policies)) {
    if (policy.rules.length === 0) {
      if (policy.level) tools[tool] = policy.level
      continue
    }
    tools[tool] = { ...(policy.level ? { level: policy.level } : {}), rules: policy.rules }
  }
  await writeHoshiJson(LEVELS_FILE(), { tools })
}

/** The level in force for one call.
 *
 *  A matching pattern rule wins over the tool-wide level, because it is the
 *  more specific statement about the same thing: "ask before running shell
 *  commands, except `git status`" is one decision, and the rule is the half
 *  that carries the exception. */
export async function levelFor(tool: string, input?: unknown): Promise<Level> {
  const policy = (await readPolicies())[tool]
  if (!policy) return defaultLevelFor(tool)
  const fromRules = levelFromRules(policy.rules, subjectOf(tool, input))
  return fromRules ?? policy.level ?? defaultLevelFor(tool)
}

/** Set a tool's level. Applies immediately — there is deliberately no
 *  "deferred" outcome to report, because nothing here can interrupt a turn. */
export async function setLevel(tool: string, level: Level): Promise<void> {
  const policies = await readPolicies()
  policies[tool] = { ...(policies[tool] ?? { rules: [] }), level }
  await writePolicies(policies)
  publishMachineEvent('tool.permission.updated', { tool, level })
}

/** Add (or replace) one pattern rule under a tool. */
async function setRule(tool: string, pattern: string, level: Level): Promise<void> {
  const policies = await readPolicies()
  const policy = policies[tool] ?? { rules: [] }
  policies[tool] = { ...policy, rules: foldRule(policy.rules, pattern, level) }
  await writePolicies(policies)
  publishMachineEvent('tool.permission.updated', { tool, level })
}

/** Drop a tool's explicit level — it goes back to inheriting the default.
 *  False when it had none, so a caller can answer 404 rather than pretend. */
export async function clearLevel(tool: string): Promise<boolean> {
  const policies = await readPolicies()
  if (!(tool in policies)) return false
  /**
   *
   * Rules go with it: they are exceptions to a decision the user is undoing,
   * and leaving them behind would keep silently granting after a reset.
   *
   **/
  delete policies[tool]
  await writePolicies(policies)
  publishMachineEvent('tool.permission.updated', { tool, level: defaultLevelFor(tool) })
  return true
}

/** Set one level for every tool named, in a single write. Written as one file
 *  and one event rather than a loop of `setLevel`: thirty-seven writes and
 *  thirty-seven events for one user action is a way to lose some of them. */
export async function setAllLevels(tools: string[], level: Level): Promise<number> {
  const policies = await readPolicies()
  for (const tool of tools) policies[tool] = { ...(policies[tool] ?? { rules: [] }), level }
  await writePolicies(policies)
  publishMachineEvent('tool.permissions.reset', { level, count: tools.length })
  return tools.length
}

/** Forget every explicit level — everything inherits the default again. */
export async function clearAllLevels(): Promise<number> {
  const policies = await readPolicies()
  const count = Object.keys(policies).length
  if (count === 0) return 0
  await writePolicies({})
  /**
   *
   * `level: null` because there is no longer one value to name: each tool goes
   * back to ITS OWN default, and `ask` — which this said when every tool shared
   * one — would now be wrong about most of them.
   *
   **/
  publishMachineEvent('tool.permissions.reset', { level: null, count })
  return count
}

/**
 * ── Live asks ────────────────────────────────────────────────────────────────
 *
 **/

/**
 *
 * A tool call waiting on a person, exactly as `@hoshi/shared` publishes it —
 * this IS what every client reads off `GET /permissions`, so declaring it a
 * second time here meant the wire's shape depended on which copy you happened
 * to open (docs/STRUCTURE_REVIEW.md P-05). `PermissionAsk` is the name on the
 * wire; `PendingAsk` is what this file has always called it internally, and the
 * alias keeps both true.
 *
 **/
export type PendingAsk = PermissionAsk

interface LiveAsk extends PendingAsk {
  resolve: (allowed: boolean) => void
}

const asks = new Map<string, LiveAsk>()

/** Every pending ask on the machine. Machine-wide with no scope to get wrong,
 *  and durable enough to survive a client reload: an ask stays here until it is
 *  answered, so reopening the tab re-renders the card instead of stranding the
 *  turn behind a question nobody can see any more. */
export function listAsks(): PendingAsk[] {
  return [...asks.values()].map(strip)
}

/** A live ask as the rest of the world may see it — without the promise
 *  resolver, which is this module's own business. */
function strip({ resolve: _resolve, ...ask }: LiveAsk): PendingAsk {
  return ask
}

/** Raise an ask and wait. Unbounded on purpose — the person who has to answer
 *  may be asleep, and a timeout would silently turn "not yet" into "no". */
export function ask(request: Omit<PendingAsk, 'id' | 'createdAt' | 'patterns' | 'always'>): Promise<boolean> {
  const id = `prm_${randomUUID().replace(/-/g, '')}`
  const { exact, prefix } = grantSuggestions(request.tool, request.input)
  const full = { ...request, patterns: exact, always: prefix, id, createdAt: new Date().toISOString() }
  return new Promise<boolean>((resolve) => {
    asks.set(id, { ...full, resolve })
    publishMachineEvent('permission.asked', { permission: full })
    /**
     *
     * The event reaches whoever is already watching this machine. This reaches
     * whoever is NOT — the whole point of an alert is the tab nobody has open.
     *
     **/
    tell('permissionAsked', (port) => port(full))
  })
}

/** How a pending ask ended. Kept as a named union because the audit trail
 *  records it and "nobody answered" is a materially different fact from "the
 *  user said no". */
export type PermissionResolution = 'answered' | 'cancelled'

/** The only three answers this machine accepts, as a runtime list so the route
 *  that validates and the test that guards it read the same thing rather than
 *  each restating it — a fourth restatement of this vocabulary is what broke
 *  two clients (permissions.test.ts pins it to @hoshi/shared, which is where
 *  every client reads it from). */
export const ASK_RESPONSES = ['allow', 'reject', 'always'] as const

export type AskResponse = (typeof ASK_RESPONSES)[number]

/** Answer an ask. `always` allows this call AND persists it, so "don't ask me
 *  again" is one action rather than an approval plus a trip to settings.
 *
 *  HOW WIDELY is the answerer's choice, carried on the same call rather than a
 *  second one: a pattern equal to the tool id grants the whole tool, anything
 *  else becomes a rule scoped to it (`git push *`).
 *
 *  With no patterns given it grants the whole tool, because that is what
 *  "always allow" plainly means and what an API caller has always got here.
 *  Narrowing is the CLIENT's job, and the card does it: it offers the rungs the
 *  ask suggests and sends the one that was picked — which is the fix for a card
 *  showing one harmless command silently approving every command there will
 *  ever be. */
export async function answer(id: string, response: AskResponse, patterns?: string[]): Promise<boolean> {
  const entry = asks.get(id)
  if (!entry) return false
  asks.delete(id)
  if (response === 'always') {
    const scopes = (patterns ?? []).filter((pattern) => typeof pattern === 'string' && pattern.trim())
    if (scopes.length === 0 || scopes.includes(entry.tool)) await setLevel(entry.tool, 'allow')
    else for (const pattern of scopes) await setRule(entry.tool, pattern, 'allow')
  }
  const granted = response !== 'reject'
  entry.resolve(granted)
  publishMachineEvent('permission.replied', { id, response })
  tell('permissionResolved', (port) => port(strip(entry), 'answered', granted))
  return true
}

/** Drop every ask belonging to a session — its turn is over, so the questions
 *  are moot. Without this an aborted turn leaves cards on screen that can never
 *  be answered into anything. */
export function cancelAsksFor(sessionId: string): void {
  for (const [id, entry] of asks) {
    if (entry.sessionId !== sessionId) continue
    asks.delete(id)
    entry.resolve(false)
    publishMachineEvent('permission.replied', { id, response: 'cancelled' })
    tell('permissionResolved', (port) => port(strip(entry), 'cancelled', false))
  }
}
