import { publishMachineEvent } from './events.js'
import {
  createBashTool,
  createFsTools,
  NodeFsProvider,
  NodeShellProvider,
  type ApproveFn,
  type ShellProvider,
  type ShellResult,
} from '@openharness/core'
import type { ToolSet } from 'ai'
import type { Agent } from './catalogue.js'
import { ask, levelFor, type Level } from './permissions.js'
import { ports } from './host-ports.js'

/**
 * ── The tools an agent can use ───────────────────────────────────────────────
 *
 * Registered in-process. Under the old runtime these lived in a plugin loaded
 * by a foreign binary, which is why answering a tool needed a loopback bridge
 * (utils/widgets.ts) — here a tool is a function and its approval is an awaited
 * promise.
 *
 * Every tool is SCOPED TO ITS SESSION'S DIRECTORY. A session belongs to the
 * personal space or to one project checkout, and its file and shell tools are
 * built with that directory as their root — so "read a file" cannot mean a file
 * in somebody else's project just because the agent guessed a path.
 *
 **/

/** The library's file tools, renamed to the words the rest of the product
 *  speaks. A tool's name is not an internal detail: the model reads it, the
 *  permission store keys on it, the audit trail records it, and every client
 *  dispatches its card on it — the web app's diff view, the TUI's ┃-card, the
 *  activity line that says "Writing demo.txt". All three clients were written
 *  against `write`/`read`/`edit`/`list`, so `writeFile` silently fell through
 *  to the generic wrench-icon card with no diff and no path. Renaming here, in
 *  the one place tools are registered, is cheaper and less fragile than
 *  teaching three clients a second vocabulary for the same five tools. */
const FILE_TOOL_NAMES: Record<string, string> = {
  readFile: 'read',
  writeFile: 'write',
  editFile: 'edit',
  listFiles: 'list',
  deleteFile: 'delete',
}

/** The built-in set. Hoshi's own tools join this registry next, each
 *  contributed by the plugin that owns its domain (`host.tools.add`); the shape
 *  they plug into is deliberately just a ToolSet, so writing one is writing a
 *  function rather than satisfying a plugin host. */
/**
 *
 * The real shell, with every call echoed into the one a person can attach to.
 *
 * Execution is untouched — same provider, same captured streams, same exit code
 * — because `bash` is the machine's most-used tool and its output is what the
 * model reads. The mirror is a second audience for the same call, and it fails
 * on its own: a machine that cannot host a PTY runs every command exactly as it
 * did before and simply has no shell to show (`agentShell` in host-ports.ts).
 *
 **/
class MirroredShell implements ShellProvider {
  constructor(
    private readonly inner: ShellProvider,
    private readonly directory: string,
  ) {}

  async exec(command: string, options?: { timeout?: number; cwd?: string; env?: Record<string, string> }) {
    let mirror: { done(result: ShellResult | null): void } | null = null
    try {
      mirror = ports().agentShell?.(options?.cwd ?? this.directory, command) ?? null
    } catch {
      /** A mirror that cannot open is not a reason to refuse the command. */
    }
    try {
      const result = await this.inner.exec(command, options)
      try {
        mirror?.done(result)
      } catch {
        /** Same again on the way out. */
      }
      return result
    } catch (error) {
      try {
        mirror?.done(null)
      } catch {
        /** Same again. */
      }
      throw error
    }
  }
}

function builtInTools(directory: string): ToolSet {
  const fs = new NodeFsProvider({ cwd: directory })
  const shell = new MirroredShell(new NodeShellProvider({ cwd: directory }), directory)
  const files = Object.fromEntries(
    Object.entries(createFsTools(fs)).map(([name, tool]) => [FILE_TOOL_NAMES[name] ?? name, tool]),
  )
  /**
   *
   * Hoshi's own tools used to be an OpenCode plugin loaded into another
   * process. They are ordinary functions in this one now — which is what lets a
   * tool answer back without the loopback HTTP bridge that existed only because
   * a plugin could not.
   *
   **/
  return { ...files, ...createBashTool(shell) } as ToolSet
}

/** Everything that changes something outside the conversation.
 *
 *  A specialist described as "investigate and report", or an agent described as
 *  changing nothing, is only actually that if it CANNOT change anything — so
 *  this is the list both derive from, and it covers the machine's own tools as
 *  well as the file ones. Leaving it at the four file tools was a false floor:
 *  an agent barred from `write` could still commit, start a process, or create
 *  a project, which is a change by any reading.
 *
 *  `task` is here because a guarantee that can be laundered through a child is
 *  not a guarantee: a read-only agent able to delegate could have a subagent
 *  make the change it is not allowed to make itself.
 *
 *  Memory tools are deliberately NOT here. They change what the agent knows,
 *  not what the user has — a planner that cannot keep a note of what it found
 *  is worse at planning and no safer. */
const MUTATING = new Set([
  'bash',
  'write',
  'edit',
  'delete',
  'git_branch',
  'git_commit',
  'git_pr',
  'process_start',
  'process_stop',
  'skill_create',
  'command_create',
  'project_create',
  'task',
])

/** What a turn actually runs as, once the SESSION has had its say.
 *
 *  A chat is read-only, and it is read-only by BEING a read-only agent rather
 *  than by a second list of tools to withhold. Everything downstream already
 *  knows what `readOnly` means: `withoutDisabled` below strips the mutating set
 *  from the whole tool list — contributed plugin tools included — and turns.ts
 *  withholds the library's own `task` tool from a read-only agent, which is the
 *  half a tool filter cannot reach. So forcing the flag IS the implementation.
 *
 *  It has a name and lives here, rather than being a ternary inside the turn
 *  loop, because it is the one place a promise about a session becomes a
 *  promise about an agent — and because a rule with a name can be tested
 *  without standing up a model.
 *
 *  Note what this deliberately is not: `readOnlyTools(directory)` below, which
 *  subagents.ts uses. That filters the BUILT-INS only, so a chat built on it
 *  would also lose every read-only tool a plugin contributes — memory, the
 *  widget surface, the browser's read half — none of which change anything and
 *  all of which are most of what makes a chat worth asking. */
export function agentForSession<T extends { readOnly: boolean }>(
  definition: T,
  session: { chat?: boolean } | null | undefined,
): T {
  if (!session?.chat || definition.readOnly) return definition
  return { ...definition, readOnly: true }
}

/** What a read-only specialist is handed: everything that observes, nothing
 *  that changes. Built by REMOVING the mutating tools rather than by listing
 *  the safe ones — a tool added later is then read-write until somebody says
 *  otherwise, which is the direction that fails safely. */
export function readOnlyTools(directory: string): ToolSet {
  return Object.fromEntries(Object.entries(builtInTools(directory)).filter(([name]) => !MUTATING.has(name))) as ToolSet
}

/** Everything a turn can call: the built-ins, plus whatever the machine's
 *  plugins contribute (Hoshi's own widget tools, MCP connectors, anything a
 *  plugin adds). A contributor that fails contributes nothing and does not stop
 *  the turn — a missing connector must cost its own tools, never the whole
 *  conversation. */
export async function buildTools(
  sessionId: string,
  directory: string,
  agent?: Agent,
  /** What the turn these tools are for is running on (kernel/host-ports.ts). */
  model?: string | null,
): Promise<ToolSet> {
  /**
   *
   * Hoshi's own widget tools are contributed by the host, not imported here:
   * they are a plugin (docs/decisions/0002-own-harness.md), and a kernel that imported
   * them could not ship without them.
   *
   **/
  const contributed =
    (await ports().extraTools?.({ sessionId, directory, agent: agent?.name ?? 'build', model: model ?? null })) ?? {}
  /**
   *
   * The BUILT-INS WIN. A tool name is a wire contract: the permission store
   * keys on it (kernel/permissions.ts writes `tool-permissions.json` by bare
   * name) and every client picks a card by it. So a contribution called `bash`
   * would not merely shadow the built-in — it would inherit whatever the user
   * already answered for `bash`, including "always allow", and run with no
   * card shown. MCP tool names come verbatim off a remote server
   * (plugins/mcp/servers.ts), so this is reachable by renaming a tool upstream.
   *
   * Dropped rather than thrown, unlike the route table's hard conflict: routes
   * are static and settled at boot, whereas a connector's tool list can change
   * under us mid-life, and this function's own contract is that a bad
   * contributor costs its own tools and never the conversation.
   *
   **/
  const builtIn = builtInTools(directory)
  const safe: ToolSet = {}
  for (const [name, tool] of Object.entries(contributed)) {
    if (name in builtIn) {
      console.error(
        `[tools] refused a contributed tool named "${name}": that name belongs to a built-in and is not overridable.`,
      )
      continue
    }
    safe[name] = tool
  }
  const all = { ...builtIn, ...safe }
  return withoutDisabled(all, agent)
}

/** Drop the tools an agent's own definition switches off.
 *
 *  Removed from the SET rather than refused at the gate: a tool the model was
 *  never shown cannot be attempted, cannot half-run, and cannot be argued into.
 *  Refusing at the gate instead would put a permission card on screen for a
 *  tool the agent was never meant to have, and teach the model to keep asking.
 *
 *  Absent means offered — an agent that says nothing about a tool added later
 *  gets it, which is the direction that keeps a definition from silently
 *  freezing an agent's abilities at the day it was written. */
function withoutDisabled(tools: ToolSet, agent?: Agent): ToolSet {
  const off = new Set(
    Object.entries(agent?.tools ?? {})
      .filter(([, enabled]) => enabled === false)
      .map(([name]) => name),
  )
  /**
   *
   * `readOnly` is the same promise expressed once instead of enumerated: an
   * agent that says it changes nothing keeps that promise as the tool list
   * grows, which a hand-written list of four names does not.
   *
   **/
  if (agent?.readOnly) for (const name of MUTATING) off.add(name)
  if (off.size === 0) return tools
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !off.has(name))) as ToolSet
}

/** The gate every tool call passes through.
 *
 *  `deny` refuses without asking anybody — a rule the user already set is an
 *  answer, not a reason to interrupt them again. `allow` runs. `ask` suspends
 *  the turn on a promise that only a client's answer resolves, which is what
 *  makes the permission out-of-band: the question can be answered from a phone,
 *  minutes later, by whoever is around.
 *
 *  There is no timeout. A turn waiting on a person is not a stuck turn, and
 *  turning "not yet" into "no" after some arbitrary interval is exactly the
 *  behaviour that teaches people to grant everything up front. */
/** Tools already reported, so a chatty session says it once. */
const ungoverned = new Set<string>()

/** A tool asked for permission that the machine does not list.
 *
 *  Every such tool defaults to `ask`, and an ask nobody can answer is a turn
 *  that hangs forever — which is exactly what `task` and `skill` did, because
 *  the engine's library grows them from options rather than from any registry
 *  this machine enumerates. That failed silently: no error, no log, just a turn
 *  that never finished and a session that looked frozen.
 *
 *  It cannot be derived: the library does not expose the tools it adds. So the
 *  machine SAYS SO instead — loudly, once per tool, on the log and on the event
 *  bus. A gap that announces itself is one somebody can close; a gap that hangs
 *  a turn is one somebody has to bisect for. */
function systemToolNames(): Set<string> {
  return new Set([...SYSTEM_TOOLS, ...(ports().systemToolNames?.() ?? [])])
}

function reportUngoverned(tool: string): void {
  if (ungoverned.has(tool) || systemToolNames().has(tool) || toolNames().includes(tool)) return
  ungoverned.add(tool)
  console.warn(
    `[harness] "${tool}" asked for permission but is not in this machine's tool list — ` +
      'it cannot be pre-granted from Customize, and an unattended turn will hang on it. ' +
      'Add it to SYSTEM_TOOLS in kernel/tools.ts, or register it so it can be governed.',
  )
  publishMachineEvent('tool.ungoverned', { tool })
}

export function buildApprover(sessionId: string, directory: string, agent?: Agent): ApproveFn {
  return async (call) => {
    /**
     *
     * The INPUT, not just the tool name: a rule is written about the command or
     * the path, and a gate that only knew the tool could not honour one.
     *
     **/
    /**
     *
     * System tools skip the gate entirely — before any level is read, so an
     * agent definition cannot re-gate one either. See SYSTEM_TOOLS: these change
     * nothing outside the conversation, and the one thing asking about them
     * reliably produced was a turn that never finished.
     *
     **/
    if (systemToolNames().has(call.toolName)) return true
    const level = effectiveLevel(await levelFor(call.toolName, call.input), agent?.permission?.[call.toolName])
    if (level === 'deny') return false
    if (level === 'allow') return true
    reportUngoverned(call.toolName)
    return ask({ sessionId, directory, tool: call.toolName, input: call.input })
  }
}

/** The stricter of the machine's level and the agent's own.
 *
 *  One direction only. An agent definition is a file on the machine, and a
 *  definition able to grant itself `allow` would turn every machine-wide `ask`
 *  into a suggestion — the setting exists precisely so that no agent, seeded or
 *  authored, can decide for the person that it needs no permission. Tightening
 *  is always allowed: a coordinator saying "never me" is exactly what these are
 *  for. */
function effectiveLevel(machine: Level, agent?: Level): Level {
  if (!agent) return machine
  const strictness: Record<Level, number> = { allow: 0, ask: 1, deny: 2 }
  return strictness[agent] > strictness[machine] ? agent : machine
}

/**
 * ── System tools ─────────────────────────────────────────────────────────────
 *
 * The machine's own plumbing. Never gated, never listed in Customize → Tools —
 * there is nothing there for a person to decide.
 *
 * The test is not "is it harmless" but "does it change anything outside the
 * conversation". None of these do:
 *
 *   user_whoami                    reads who the person already is
 *   task_route                     sizes a request; changes nothing
 *   skill                          loads prose this machine already ships
 *   task                           hands work to a specialist — whose OWN tools
 *                                  are gated exactly as they would be here, so
 *                                  nothing is waved through by delegating
 *   session_update / session_info  name and read THIS session — the machine's
 *                                  standing instruction is to name every session
 *                                  on its first turn, so gating it would put a
 *                                  card at the top of every new conversation
 *                                  asking permission to write its own title
 *
 * Asking about them was worse than noise. A permission nobody answers hangs the
 * turn forever. Delegation had that shape: an unattended turn could not delegate
 * at all, because no one was there to allow it. Product plugins can declare
 * their own conversation-only tools through `systemToolNames`, without making
 * the harness know their protocol.
 */
const SYSTEM_TOOLS = new Set([
  'user_whoami',
  'task_route',
  'skill',
  'task',
  'session_update',
  'session_info',
  /**
   *
   * The whole memory family. Asking permission to remember is friction with
   * nothing behind it: this is the machine's own notes about its own owner,
   * kept in its own state directory — no file of theirs is touched, nothing
   * leaves the machine, and the person on the other side of the prompt is the
   * only one it is about. What a permission card there actually buys is a
   * conversation interrupted to approve the agent recalling your name.
   *
   * Writes included, deliberately. A memory the agent may read but not update
   * is one that goes stale and quietly starts being wrong, which is worse than
   * either remembering or forgetting cleanly.
   *
   **/
  'memory_recall',
  'memory_list',
  'memory_search',
  'memory_save',
  'memory_forget',
  'memory_consolidate',
])

/** Every tool name the machine can offer, for the Customize surface. Derived
 *  from the registry rather than a hand-kept list, so a tool added to the engine
 *  cannot be missing from the screen that governs it — minus the system tools,
 *  which that screen has no question to ask about. */
export function toolNames(): string[] {
  return [...Object.keys(builtInTools(process.cwd())), ...(ports().extraToolNames?.() ?? [])]
    .filter((name) => !systemToolNames().has(name))
    .sort()
}
