import type { ToolSet } from 'ai'
import type { MachineEvent } from './events.js'
import type { PendingAsk, PermissionResolution } from './permissions.js'
import type { Provider } from './providers.js'
import type { ShellResult } from '@openharness/core'

/**
 * ── What the kernel asks of its host ─────────────────────────────────────────
 *
 * The mirror of the plugin host (docs/decisions/0002-own-harness.md). That one is what
 * a plugin is handed; this is what the kernel calls OUT to — the few moments
 * where running a turn touches something that is not the kernel's business.
 *
 * There are five, and each one was an import reaching out of `engine/` into a
 * neighbour's `utils/` before this existed: the audit trail and the alert
 * channels wanted to know about a permission ask, org policy wanted a say in
 * which providers a machine may use, and budgets and the Platform rollup wanted
 * to hear about spend. All four of those become plugins (docs/decisions/0002-own-harness.md),
 * and a kernel that imported them could not ship without them.
 *
 * Every port is OPTIONAL and has a safe default, which is the property that
 * matters: a harness with no plugins at all still runs turns, still asks for
 * permission, still records what it spent. Nothing here may change what a turn
 * DOES — a port is told, or consulted for policy it may only narrow. A port
 * that could widen permissions would be a way around the approver.
 *
 **/

/** What an organization configured centrally for one provider. The kernel
 *  overlays these onto the open catalogue (a self-hosted endpoint standing in
 *  for a hosted one) and offers them for import. */
export interface OrgProvider {
  providerId: string
  keyEnvVar: string
  /** The org supplies the credential itself, rather than asking the person. */
  orgKey: boolean
  /** Model ids the org exposes, or null for the provider's whole catalogue. */
  models: string[] | null
  name: string | null
  baseUrl: string | null
}

/** What an UNATTENDED actor needs from the machine it runs on.
 *
 *  Four questions, and every one of them has an organization's answer and a
 *  lone machine's answer:
 *
 *    "Is anyone allowed to know this happened?"  → notify
 *    "May this action proceed with nobody watching?" → mayProceed
 *    "Is there any money left?"                  → spendBlocked
 *    "Start this work without a person driving." → dispatch
 *
 *  A machine with no organization behind it answers all four the safe way by
 *  default: nobody to tell, nothing forbidden, nothing blocked, and no
 *  dispatcher — so an actor that needs one finds out rather than proceeding
 *  as though it had. They are grouped because they are one CONTEXT: the CI
 *  loop, goals, workflows and schedules each need all four, and a plugin that
 *  had to assemble them one at a time would end up importing the organization.
 */
export interface UnattendedContext {
  /** Raise something on whatever channels the owner watches. `dedupKey` is
   *  what stops one flapping build from sending forty messages. */
  notify?(alert: {
    kind: 'input' | 'complete' | 'error'
    detail: string | null
    dedupKey: string
    projectId?: string | null
    sessionId?: string | null
    sessionTitle?: string | null
  }): void | Promise<void>

  /** Whether a tool call may run with nobody watching. `deny` refuses it,
   *  `ask` means it must reach a human and may never be remembered as an
   *  "always allow", `null` means no rule applies and the machine's own
   *  settings decide as they always did. */
  mayProceed?(call: {
    tool: string
    subjects: string[]
  }): Promise<{ effect: 'deny' | 'ask' | null; ruleId: string | null }>

  /** True when spend has hit a limit the machine must not exceed. Checked
   *  BEFORE starting unattended work, because the alternative is finding out
   *  afterwards. */
  spendBlocked?(): boolean

  /** Re-read the ceiling before committing to something expensive. Fails open
   *  by contract: an unreachable Platform keeps the last known verdict, so a
   *  hiccup there can never turn into a fleet-wide refusal. */
  refreshSpend?(): Promise<void>

  /** Fire a published workflow. A schedule can point at one instead of a
   *  prompt, and whoever owns workflows answers this — a machine that runs
   *  none simply has nobody to ask, and the schedule is skipped rather than
   *  silently firing nothing.
   *
   *  Returns why it did NOT start when it did not: a schedule pointing at a
   *  disabled or unpublished workflow is an ordinary state a person has to be
   *  able to see, not an error. */
  startWorkflow?(input: {
    workflowId: string
    source: string
    triggerId: string
    /** What fired it, when that carries a payload — a webhook's body, headers
     *  and query. The run reads it as its own input. */
    input?: unknown
  }): Promise<{ started: boolean; reason?: string }>

  /** Start work nobody is watching. Returns the task's id so the caller can
   *  say what it started. */
  dispatch?(task: {
    source: string
    triggerId: string
    triggerName: string
    prompt: string
    projectId: string | null
    model?: string | null
    directory?: string | null
    /** Anything the dispatcher should carry along untouched — who delegated
     *  this, where it came from. Opaque here on purpose: the kernel has no
     *  business knowing the shape of another machine's handover. */
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }>
}

export interface KernelPorts extends UnattendedContext {
  /** Extra standing instructions supplied by installed plugins.
   *
   * The harness owns the order in which a turn is assembled, but not every
   * product convention that belongs in that prompt. A plugin may contribute
   * complete sections here; a standalone harness simply has none. This is
   * prompt text, not a writable AGENTS.md fragment. */
  agentInstructions?(): string[]
  /** Tool names that only affect the current conversation and therefore do not
   * need a permission decision or a Customize setting. Plugins must declare
   * these narrowly: a tool that writes, sends, or reaches outside the turn is
   * governable even if its result happens to be shown in chat. */
  systemToolNames?(): string[]
  /** How this machine reaches its Platform, or null when it has none.
   *
   *  A port rather than an environment read, because "this machine belongs to
   *  an organization" is exactly the fact the kernel must not assume. Four
   *  areas need it — packs fetch their credentials, delegations hand work to a
   *  sibling machine, git reports a pull request, the rollup pushes spend —
   *  and every one of them has to work on a machine that answers null here. */
  platform?(): { platformUrl: string; token: string; machineId: string | null; orgId: string | null } | null
  /**
   *
   * The X display the agent's browser should draw on, or null when this machine
   * has none — which is every machine whose image predates the desktop, and any
   * whose display failed to start.
   *
   * A port because `web-control` and `desktop` are two halves of one feature
   * and a plugin may not import another (docs/decisions/0002-own-harness.md). Read at
   * launch time rather than cached: the browser is spawned per session, and a
   * display that came up after the first one did should still be used by the
   * next.
   *
   **/
  display?(): string | null
  /** What this machine is running and how each part is doing. Answered by the
   *  plugin runtime, so `machine.state` can name what is missing — "Browser
   *  control is unavailable: Chrome is not installed" — instead of leaving a
   *  client to infer it from a status code (docs/decisions/0002-own-harness.md). */
  pluginStatuses?(): Array<{ name: string; description: string; state: 'ready' | 'degraded'; reason: string | null }>
  /** File a session under a Platform project, so it appears in that project's
   *  list wherever the person opens it next. A machine with no Platform files
   *  nothing — the session is no less real for it. */
  bindSessionToProject?(projectId: string, sessionId: string): Promise<void>
  /** This session is running with NOBODY WATCHING. Told before its first
   *  prompt, so an organization's unattended rules are already in force when
   *  the step's first tool call happens — after would be too late. */
  markUnattended?(sessionId: string): Promise<void>
  /** Reading and writing workflows from OUTSIDE the area that owns them —
   *  which is what sharing one as an organization asset is. Kept as three
   *  narrow questions rather than a handle on the store: an asset library may
   *  list what can be shared, take one in, and read one out, and nothing else.
   *
   *  A machine that runs no workflows answers none of these, and an asset
   *  library on it simply has no workflows to offer. */
  workflowLibrary?(): {
    list(): Promise<Array<{ id: string; name: string; publishedVersion: number | null }>>
    read(idOrName: string): Promise<{ id: string; name: string; graph: unknown } | null>
    upsert(input: { name: string; description: string | null; graph: unknown }): Promise<{ id: string }>
  }
  /** A workflow is gone; nothing may still be pointing at it. Answered by
   *  whoever owns schedules and webhooks, so a deleted workflow cannot leave a
   *  trigger that fires into nothing at 03:00. */
  detachTriggersForWorkflow?(workflowId: string): Promise<{ schedules: number; webhooks: number }>
  /** Turn the context links a message carries into the text that goes in front
   *  of it.
   *
   *  A port because the message route is the KERNEL's and a link is spent in a
   *  message, while what a link IS belongs to the plugin that owns them. A
   *  machine without that plugin answers nothing here and the route refuses a
   *  message carrying links — which is the honest outcome, since silently
   *  dropping them would send a question stripped of the thing it was about. */
  contextLinks?(): {
    expand(toSessionId: string, ids: string[]): Promise<{ text: string } | { error: string }>
  }
  /** Is somebody else going to report this session's completion?
   *
   *  An armed goal continues on its own and its settle is the one moment that
   *  matters; a workflow run reports its outcome once, not once per node. Both
   *  answer this, which is why it is the one port plugins COMPOSE rather than
   *  replace: each wraps whatever is already installed, so the answer is "yes
   *  if any of them claims it".
   *
   *  Without it a machine tells its owner about every step of a five-node
   *  workflow, and the notification becomes noise nobody reads. */
  claimsCompletion?(sessionId: string): Promise<boolean>
  /** Why this machine must stay running even though nobody is watching it and
   *  nothing is generating — one short reason per contributor, empty when there
   *  is genuinely nothing to wake for.
   *
   *  COMPOSED, not replaced, for the same reason `claimsCompletion` is: the
   *  reasons live in different plugins and none of them can see the others. A
   *  schedule due at 03:00 is the triggers plugin's business, a listening port
   *  serving somebody's preview is the services plugin's, and the kernel must
   *  not learn either — the next reason should be one plugin answering this,
   *  not an edit here.
   *
   *  The machine reports these; the PLATFORM decides what to do about them. A
   *  machine cannot suspend itself (it does not own its own container) and the
   *  Platform cannot know these facts (they are live properties of a running
   *  machine) — the same split that put `busy` on the health probe. */
  keepAwake?(): Promise<string[]>
  /** What a task carrying a delegation needs from whoever owns handover: how
   *  to word it, and the two moments its sender is waiting to hear about.
   *
   *  One port rather than four, because a queue that had to assemble them
   *  separately would end up importing the delegation area — and a machine
   *  that hands work to nobody answers none of it, which is why every member
   *  is optional and the queue simply runs the task as itself. */
  delegatedTask?(): {
    title(delegation: unknown): string
    prompt(delegation: unknown, brief: string): string
    started(id: string, sessionId: string): void | Promise<void>
    settled(id: string, outcome: { ok: boolean; text: string; sessionId: string | null }): void | Promise<void>
  }
  /** An unattended run is starting. The audit trail records it so a burst of
   *  actions inside that run can be attributed to what asked for it. */
  dispatchStarted?(input: {
    sessionId: string
    title: string
    projectId: string | null
    delegationId: string | null
  }): void | Promise<void>
  /** Which delegation, if any, a session came from. Answered by whoever owns
   *  cross-machine handover; the audit trail asks so a burst of unattended
   *  actions can be attributed to the colleague who asked for them.
   *
   *  This is the first port a PLUGIN answers rather than the host — which is
   *  the point of `host.provide`: two plugins that must not import each other
   *  meet at a named question instead. */
  sessionDelegation?(sessionId: string): Promise<string | null>
  /** A client just connected to the event stream. The kernel has already sent
   *  its own snapshot; this is where everything else the machine owns sends
   *  theirs, so a client-side mirror is complete even when nothing has changed
   *  since it last looked.
   *
   *  Push, don't return: each contributor's snapshot reaches the client the
   *  moment it is ready, and one slow reader cannot hold up the rest. */
  replayOnConnect?(push: (event: MachineEvent) => void): void | Promise<void>
  /**
   *
   * Show the agent's work in a shell a person can attach to and take over.
   *
   * Every `bash` call the agent makes runs exactly as it always did — captured,
   * with its streams split and its exit code intact; that contract is the
   * machine's most-used one and this must not touch it. What this port does is
   * ECHO the call into a real PTY on the same directory, so the Computer's
   * terminal shows the agent's commands and their output as they happen, and so
   * the person watching can type into the same prompt the moment the agent is
   * between calls.
   *
   * A mirror rather than the execution path itself, and that is faithful rather
   * than a compromise: a bash call gets a FRESH shell today, so nothing carries
   * between the agent's calls anyway. Running them inside the person's PTY would
   * invent state sharing that does not exist, merge stdout with stderr, and feed
   * the model a screenful of ANSI it currently never sees.
   *
   * Returns a handle so the command line reaches the shell BEFORE the command
   * runs — a two-minute build that showed nothing until it finished would be a
   * worse view of the agent's work than no view at all. `null` when the machine
   * cannot host a shell, which is the ordinary answer on a machine whose
   * `node-pty` did not build.
   *
   **/
  agentShell?(directory: string, command: string): { done(result: ShellResult | null): void } | null
  /** Tools contributed on top of the built-ins — Hoshi's own widget tools
   *  today, any plugin's tomorrow. Merged into what the model is offered, so
   *  what a host adds here is indistinguishable to a turn from a built-in. */
  extraTools?(context: {
    sessionId: string
    directory: string
    agent: string
    /** The `provider/model` this turn is running on, when it is a turn. A tool
     *  that starts work of its OWN — `team_plan`'s steps are sessions — needs it
     *  to run that work on the same model the conversation is on, which is what
     *  "inherit" has always been documented to mean. Absent when the tool set is
     *  being built outside a turn (the permissions screen listing names). */
    model?: string | null
  }): ToolSet | Promise<ToolSet>
  /** The same tools' NAMES, without building them. The permissions screen lists
   *  every tool the machine has, and building a whole set to read its keys
   *  would mean starting MCP connectors to render a settings page. */
  extraToolNames?(): string[]
  /** A tool call is waiting for a human answer. Raised on whatever channels the
   *  machine's owner watches — without it an unattended machine sits blocked in
   *  silence, which is the failure the whole alerting feature exists to stop.
   *
   *  The whole ask, not a summary: a host has to reach `directory` to name the
   *  project, and `input` to say what is actually being asked. */
  permissionAsked?(ask: PendingAsk): void | Promise<void>
  /** How an ask ended. `cancelled` — the turn went away before anyone answered
   *  — is told too, and is a materially different fact from a refusal; which of
   *  the two is worth recording is the host's call, not the kernel's. */
  permissionResolved?(ask: PendingAsk, resolution: PermissionResolution, granted: boolean): void | Promise<void>
  /** A turn's cost has landed in the ledger. Budgets and the org rollup hang
   *  off this; the ledger write itself already happened. */
  spendRecorded?(spend: { sessionId: string; messageId: string; model: string | null; cost: number | null }): void
  /** Provider ids this machine is limited to, or null for no restriction.
   *  An org's allow-list is enforced at the source rather than by whoever
   *  remembers to filter downstream — so this may only ever NARROW what the
   *  machine already has, never add to it. */
  allowedProviders?(): Promise<Set<string> | null>
  /** What the org configured centrally. Empty on a machine with no org. */
  orgProviders?(): Promise<OrgProvider[]>
  /** Providers a live local-models connector is carrying right now — somebody's
   *  own Ollama or LM Studio reached over the machine's reverse tunnel
   *  (plugins/relay). LIVE state, never configuration: the answer is empty the
   *  moment the connector detaches, which is what keeps "the model list answers
   *  what can run now" true without a liveness poller — and why these entries
   *  are never written into `providers.json`, where a crash would leave rows
   *  pointing at a dead loopback port. Empty on a machine with no connector. */
  relayProviders?(): Promise<Provider[]>
  /** Give the host a chance to re-apply org defaults — after a credential it
   *  supplied was removed, for instance. */
  syncOrgProviders?(): Promise<void>
  /** The daemon has bound its port. Told AFTER `listen` resolves, and that
   *  ordering is the whole point: a control plane that probes this machine
   *  the moment it is asked to would be answered by nothing a second earlier.
   *  Best-effort by construction (`tell`): a failed nudge costs nothing,
   *  because whatever asked to be told has its own way of finding out. */
  listening?(): void | Promise<void>
  /** Somebody outside this machine curates knowledge the agent may recall but
   *  never edit — an organization, today. Answered by whoever owns the mirror
   *  of it, so the memory plugin can PROPOSE an entry there without knowing
   *  who reviews it. A machine with nobody behind it answers nothing, and a
   *  proposal has nowhere to go — which the caller says, rather than saving
   *  it somewhere it will never be reviewed. */
  orgKnowledge?(): {
    propose(proposal: {
      name: string
      description: string
      kind: string
      content: string
      document?: string | null
      source: 'agent' | 'user'
    }): Promise<{ id: string; name: string }>
  }
  /** The read-only shelf in the machine's memory where curated knowledge
   *  lands. Answered by the memory plugin; read by whoever fetches that
   *  knowledge, so the fetcher never learns how memory is laid out on disk and
   *  memory never learns where the knowledge came from. `replaceOrg` is a
   *  REPLACE, not a patch — a retired entry disappears from every machine
   *  rather than lingering as an orphan nothing can reach to remove. */
  memoryMirror?(): {
    kinds(): readonly string[]
    replaceOrg(
      entries: Array<{
        name: string
        description: string
        kind: string
        content: string
        document: string | null
        createdAt: string
        updatedAt: string
      }>,
    ): Promise<{ entries: number; documents: number }>
  }
}

let installed: KernelPorts = {}

/** Install the host's side. Called once, at boot, before anything serves. */
export function configureKernel(ports: KernelPorts): void {
  installed = ports
}

/** Add to what is installed without replacing it.
 *
 *  Two things legitimately answer the same port — the machine hosting this
 *  kernel, and the plugins running inside it — and `configureKernel` alone
 *  would let the second silently erase the first. Composition is the caller's
 *  business: it is handed what is already there. */
export function extendKernel(extend: (current: KernelPorts) => KernelPorts): void {
  installed = extend(installed)
}

/** The kernel's own read. Never exported from the package: a plugin reaching
 *  for this would be reaching around its own host API. */
export function ports(): KernelPorts {
  return installed
}

/** Call a port without letting it break the thing that called it. A failing
 *  audit sink must not fail the permission it was recording, and a budget
 *  refresh that throws must not turn a delivered answer into a failed turn. */
export function tell<K extends keyof KernelPorts>(name: K, run: (port: NonNullable<KernelPorts[K]>) => unknown): void {
  const port = installed[name]
  if (!port) return
  try {
    const result = run(port as NonNullable<KernelPorts[K]>)
    if (result instanceof Promise)
      result.catch((error) => console.error(`[harness] port ${String(name)} failed:`, error))
  } catch (error) {
    console.error(`[harness] port ${String(name)} failed:`, error)
  }
}
