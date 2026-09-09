import type { ContextLink, MachineSession, PermissionOutcome, SessionProgress, TerminalInfo } from './machine.js'
import type { AgentPolicy, AgentPolicyMode } from './agents.js'
import type { BudgetState } from './usage.js'
import type { MachineLogEntry } from './machine-log.js'

/**
 *
 * The machine's `/events` wire, as ONE declaration.
 *
 * Every variant here is a frame the harness publishes on its bus
 * (packages/harness/src/kernel/events.ts) and a client consumes off
 * `GET /events`. This union — and the payload shapes under it — used to be
 * hand-mirrored three times: a 430-line copy inside App:Web's machineEvents
 * store, a partial second copy in its workflows composable, and a third in the
 * TUI's own api/types. Nothing on the wire was typechecked across the seam, so
 * a drift was a runtime bug: the store's session copy silently never grew
 * `parentId` or `spend`, and `message.completed`'s cost/model fields were sent
 * for weeks before any client's type admitted they existed.
 *
 * Declared here — the wire contract package both sides import — so a field
 * added to one side is a compile error on the other. The clients ALIAS these
 * (their old modules re-export, keeping icons/labels/helpers beside them);
 * the harness is the publishing side and still writes frames as literals —
 * typing `publishMachineEvent` against this union is the follow-up that
 * closes the loop, and it requires enumerating the machine-internal events
 * first.
 *
 * A client that only cares about sessions still must not break when the
 * machine learns to publish something new: handlers switch on `type` and let
 * unknown frames fall through, and this union describes the KNOWN vocabulary,
 * not a promise that nothing else will ever arrive.
 *
 **/

/** The machine's connect-time snapshot (packages/harness/src/kernel/machine-state.ts)
 *  — the first event every `/events` connection receives, re-pushed whenever a
 *  field changes. What a client's entry flow routes on. */
export interface MachineState {
  /** The machine can take a turn right now. False means the client shows what
   *  is missing rather than a composer whose send button cannot work. */
  ready: boolean
  /** No provider has usable credentials yet — the one setup step that leaves a
   *  fully-booted machine unable to do anything, and the reason `ready` is
   *  false often enough to deserve its own field. */
  needsProvider: boolean
  /** The first-run wizard has been finished or skipped on this machine. False
   *  routes a client to the wizard; it is a machine fact, so every client that
   *  connects reads the same one. */
  setupComplete: boolean
  /** Image version this machine reports; null in dev. */
  version: string | null
  /** Every part of this machine and how it is doing. A `degraded` entry
   *  carries the REASON — "this feature is unavailable and here is why" is a
   *  thing a client can show and a 404 is not. */
  plugins: Array<{ name: string; description: string; state: 'ready' | 'degraded'; reason: string | null }>
}

/* ── Goals ────────────────────────────────────────────────────────────────── */

export type GoalStatus =
  | 'running'
  | 'paused'
  /** The auditor confirmed the objective was achieved. */
  | 'done'
  /** The auditor returned "stuck" three ticks in a row. */
  | 'stuck'
  /** The token budget was hit. */
  | 'budget-reached'
  /** The continuation cap was hit before the auditor said "done". */
  | 'stopped'
  /** The session's last turn ended in a provider/runtime error. */
  | 'error'

export interface Goal {
  id: string
  sessionId: string
  /** The user's original message — what the auditor judges every reply against. */
  objective: string
  status: GoalStatus
  /** Short human-readable summary of the latest audit — what the status strip
   *  shows as "what's happening". Null before the first audit runs. */
  progressNote: string | null
  /** True while an audit call is in flight — the client's "Evaluating…" cue. */
  auditing: boolean
  /** Automatic continuations sent so far. */
  continuationCount: number
  /** Safety cap on continuationCount. */
  maxContinuations: number
  /** Consecutive "stuck" verdicts. Reset to 0 by any "keep going" verdict. */
  stuckCount: number
  /** Cumulative token usage across every turn since the goal was armed. */
  tokensUsed: number
  /** Optional safety ceiling; null = unlimited (still bounded by maxContinuations). */
  tokenBudget: number | null
  /** The last assistant message the loop has already audited — guards against
   *  auditing the same completed turn twice. */
  lastMessageId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/* ── Background processes and services ────────────────────────────────────── */

export interface TrackedProcess {
  id: string
  name: string
  command: string
  cwd: string
  pid: number
  status: 'running' | 'exited' | 'failed' | 'stopped'
  /** Only known when the daemon was still alive to see the child's own 'exit'
   *  event fire — null when a liveness check is what detected the process was
   *  gone (the common case after the daemon itself restarted, since a detached
   *  child outlives it). */
  exitCode: number | null
  startedAt: string
  endedAt: string | null
}

export type ServiceScope = 'project' | 'machine'
export type ServiceSource = 'user' | 'manifest' | 'detected'
export type ServiceStatus = 'stopped' | 'running' | 'failed' | 'exited'

export interface Service {
  id: string
  name: string
  command: string
  cwd: string
  port: number | null
  scope: ServiceScope
  source: ServiceSource
  env: Record<string, string> | null
  processId: string | null
  /** Which checkout it belongs to; null is the personal space (the workspace
   *  root), which has no checkout above it. Derived machine-side from `cwd`. */
  projectId: string | null
  status: ServiceStatus
  pid: number | null
  startedAt: string | null
  /** Whether `port` is actually accepting connections. `running && !listening`
   *  is the real gap between hitting Run and the preview being worth opening. */
  listening: boolean
  createdAt: string
  updatedAt: string
}

/** A process running on the machine that no service claims — in practice one
 *  the agent started with `process_start`. */
export interface UnmanagedProcess {
  processId: string
  name: string
  command: string
  cwd: string
  pid: number
  projectId: string | null
  startedAt: string
}

/* ── Dispatched tasks ─────────────────────────────────────────────────────── */

/** Where an inbound task came from. Display strings plus one opaque `ref` —
 *  the machine is deliberately never told the channel, thread or bot token, so
 *  it can only ever answer back into the conversation it was dispatched from. */
export interface TaskOrigin {
  /** The Platform's `integration_tasks.id`, echoed on every callback. */
  ref: string
  provider: 'slack' | 'linear' | 'github'
  /** '#eng', 'CYB-63', 'acme/api#12'. */
  source: string
  /** '@kate'. */
  actor: string
  /** Permalink back to the originating message or issue. */
  url: string | null
}

export interface DispatchedTask {
  id: string
  source: 'schedule' | 'webhook' | 'inbox'
  triggerId: string
  triggerName: string
  prompt: string
  projectId: string | null
  origin: TaskOrigin | null
  directory: string | null
  sessionId: string | null
  status: 'queued' | 'running' | 'done' | 'error'
  error: string | null
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
}

/* ── Engagements (the specialist team a manager tool runs) ────────────────── */

export type EngagementStepStatus = 'blocked' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled'
export type EngagementStatus = 'running' | 'checkpoint' | 'done' | 'error' | 'cancelled'

export interface EngagementNode {
  kind: 'assignment' | 'checkpoint'
  key: string
  role?: string
  question?: string
  dependsOn: string[]
}

export interface EngagementNodeRun {
  key: string
  status: EngagementStepStatus
  sessionId: string | null
  archetype: string | null
  report: string | null
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface Engagement {
  id: string
  parentSessionId: string
  title: string
  status: EngagementStatus
  nodes: EngagementNode[]
  runs: Record<string, EngagementNodeRun>
  createdAt: number
  updatedAt: number
}

/* ── Workflows ────────────────────────────────────────────────────────────── */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type WorkflowHttpMethod = (typeof HTTP_METHODS)[number]

/** Mirrors the machine's workflow-graph MAX_NODE_RETRIES. */
export const MAX_NODE_RETRIES = 5
/** Mirrors the machine's workflow-graph MAX_LOOP_ITERATIONS. */
export const MAX_LOOP_ITERATIONS = 100

export interface WorkflowRetries {
  count: number
  backoffSeconds: number
}

export interface WorkflowHttpRequest {
  method: WorkflowHttpMethod
  url: string
  headers: Record<string, string>
  body: string | null
}

/** A value mapping (the machine's workflow-mapping module). Deliberately loose
 *  here: a client edits the handful of ops it offers and round-trips the rest,
 *  and the machine is the authority on what is valid. */
export interface WorkflowMapping {
  op: string
  [key: string]: unknown
}

export interface WorkflowBranchCase {
  id: string
  label: string
  when: string
}

export interface WorkflowStateAssignment {
  key: string
  value: WorkflowMapping
}

export const WORKFLOW_NODE_KINDS = [
  'start',
  'agent',
  'http',
  'branch',
  'loop',
  'transform',
  'state',
  'approval',
  'note',
  'end',
] as const
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number]

export type WorkflowJoin = 'all' | 'any'

interface WorkflowNodeBase {
  id: string
  key: string
  name: string
  position: { x: number; y: number }
  /** The loop whose body this node lives in, or null at the top level. */
  parentId: string | null
  join: WorkflowJoin
}

export type WorkflowNode = WorkflowNodeBase &
  (
    | { kind: 'start'; inputSchema: string | null }
    | {
        kind: 'agent'
        prompt: string
        agent: string | null
        model: { providerID: string; modelID: string } | null
        freshSession: boolean
        outputSchema: string | null
        retries: WorkflowRetries | null
      }
    | { kind: 'http'; http: WorkflowHttpRequest; retries: WorkflowRetries | null }
    | { kind: 'branch'; cases: WorkflowBranchCase[] }
    | {
        kind: 'loop'
        mode: 'foreach' | 'while'
        source: WorkflowMapping | null
        while: string | null
        maxIterations: number
      }
    | { kind: 'transform'; mapping: WorkflowMapping }
    | { kind: 'state'; assignments: WorkflowStateAssignment[] }
    | {
        kind: 'approval'
        title: string
        message: string
        timeoutSeconds: number | null
        onTimeout: 'approved' | 'rejected' | 'fail'
      }
    | { kind: 'note'; body: string; size: { width: number; height: number } }
    | { kind: 'end'; output: WorkflowMapping | null; outcome: 'done' | 'error'; message: string | null }
  )

export interface WorkflowEdge {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: 'in'
  label: string | null
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowVersion {
  version: number
  graph: WorkflowGraph
  publishedAt: string
  note: string | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  enabled: boolean
  projectId: string | null
  /** What the builder edits. Saving this never changes what triggers run. */
  draft: WorkflowGraph
  /** Which version triggers fire. Null until the first publish. */
  publishedVersion: number | null
  versions: WorkflowVersion[]
  createdAt: string
  updatedAt: string
}

export type WorkflowRunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled'

export type WorkflowNodeRunStatus =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'retrying'
  | 'waiting'
  | 'done'
  | 'error'
  /** The graph decided against this path — skipped, not failed. */
  | 'pruned'
  | 'cancelled'

export interface WorkflowRunAttempt {
  attempt: number
  sessionId: string | null
  error: string
  startedAt: string | null
  failedAt: string
}

export interface WorkflowRunApproval {
  requestedAt: string
  expiresAt: string | null
  decision: 'approved' | 'rejected' | null
  decidedAt: string | null
  decidedBy: string | null
  comment: string | null
}

export interface WorkflowRunNodeRun {
  id: string
  nodeId: string
  key: string
  kind: WorkflowNodeKind
  /** '' at the top level, else `<loopNodeId>#<index>` segments joined by '/'. */
  path: string
  seq: number
  status: WorkflowNodeRunStatus
  inbound: Record<string, 'satisfied' | 'pruned'>
  port: string | null
  /** The rendered prompt as sent, with `{{secrets.*}}` masked — the machine
   *  never stores or pushes resolved values. */
  prompt: string | null
  text: string | null
  truncated: boolean
  output: unknown
  error: string | null
  warnings: string[]
  sessionId: string | null
  messageId: string | null
  retried: boolean
  attempt: number
  attempts: WorkflowRunAttempt[]
  retryAt: string | null
  startedAt: string | null
  completedAt: string | null
  loop: { index: number; total: number | null; items: unknown[] | null; results: unknown[] } | null
  approval: WorkflowRunApproval | null
}

export interface WorkflowRun {
  id: string
  workflowId: string
  workflowName: string
  /** The published version this ran, or null for a draft preview. */
  version: number | null
  projectId: string | null
  directory: string | null
  source: 'manual' | 'schedule' | 'webhook'
  triggerId: string | null
  status: WorkflowRunStatus
  input: { body: unknown; headers: Record<string, string>; query: Record<string, string> } | null
  sessionId: string | null
  sessionCursor: string | null
  graph: WorkflowGraph
  nodeRuns: WorkflowRunNodeRun[]
  state: Record<string, unknown>
  output: unknown
  error: string | null
  warnings: string[]
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
}

/* ── Budgets, policy, delegation ──────────────────────────────────────────── */

export interface MachineBudget {
  budgets: BudgetState[]
  /** An exceeded `enforce` budget — the machine refuses to start new turns. */
  blocked: boolean
  /** The blocking budget, or the worst breached warning. */
  primary: BudgetState | null
}

/** What the machine reports when a policy rule stopped something — a refused
 *  tool call, or an "Always allow" that may not be made permanent. */
export interface AgentPolicyBlock {
  action: 'tool' | 'grant'
  tool: string | null
  subject: string | null
  ruleId: string
  ruleMode?: AgentPolicyMode
  ruleDescription?: string
  sessionId?: string
  rootSessionId?: string
}

/** One delegation as the RECEIVING machine knows it — who asked, what it was
 *  called, which session ran it. The org-wide picture (pending approvals, the
 *  consent rules, who else was asked) is Platform state and is read from the
 *  Platform; the machine deliberately holds only this much. */
export interface MachineDelegation {
  id: string
  title: string
  fromName: string
  sessionId: string | null
  status: 'queued' | 'running' | 'done' | 'error'
  receivedAt: string
  settledAt: string | null
}

/* ── The union ────────────────────────────────────────────────────────────── */

export type MachineEvent =
  /** A declared process moving (the engagements plugin). A tool publishes
   *  nothing until it settles, so this is the ONLY way a client sees one run. */
  | { type: 'engagement.updated'; properties: { engagement: Engagement } }
  | { type: 'machine.state'; properties: { state: MachineState } }
  /**
   * ── A turn, as the engine tells it ─────────────────────────────────────────
   *
   * Three kinds where the old runtime had eleven. There is no "message created"
   * event because the message IS the turn: the first delta opens it, and
   * `message.completed` closes it however it ended.
   *
   **/
  | { type: 'message.delta'; properties: { sessionId: string; messageId: string; text: string } }
  /** Appended outside a turn — the shell's transcript write. */
  | { type: 'message.appended'; properties: { sessionId: string; messageId: string } }
  /** The model thinking out loud — a separate stream from the answer, folded
   *  away by default in the thread. */
  | { type: 'message.reasoning.delta'; properties: { sessionId: string; messageId: string; text: string } }
  /** A write that succeeded is a fact about the filesystem, not just the turn:
   *  the file panel follows the agent with it. */
  | { type: 'file.edited'; properties: { sessionId: string; path: string } }
  | {
      type: 'message.completed'
      properties: {
        sessionId: string
        messageId: string
        aborted: boolean
        error: { name: string; message: string } | null
        usage: {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          reasoningTokens?: number
          cachedInputTokens?: number
        } | null
        /** What the turn cost and what ran it. */
        cost: number | null
        model: string | null
        /** Why the model stopped — `length` is the one that matters, because a
         *  truncated answer looks exactly like a finished one. */
        finishReason: string | null
        /** How long the model itself generated, for tokens per second. */
        modelMs: number | null
        retries: number | null
        compacted: { tokensBefore: number; tokensAfter: number } | null
      }
    }
  | {
      type: 'tool.started'
      properties: { sessionId: string; messageId: string; toolCallId: string; tool: string; input: unknown }
    }
  | {
      type: 'tool.completed'
      properties: {
        sessionId: string
        messageId: string
        toolCallId: string
        tool: string
        status: 'ok' | 'error'
        input?: unknown
        /** What the call produced, already rendered to text by the machine. */
        output?: string
        error?: string
      }
    }
  | { type: 'session.status'; properties: { sessionId: string; state: 'idle' | 'busy' | 'retrying' } }
  /** What a session is DOING — the newest plan's progress and the call in
   *  flight; `directory` is what attributes the session to a project. */
  | {
      type: 'session.progress'
      properties: {
        sessionId: string
        directory: string | null
        plan: SessionProgress['plan']
        /** The tool and its subject — the machine reports the facts and each
         *  client words them. */
        step: SessionProgress['step']
      }
    }
  /** Session lifecycle. The machine is the only writer, so these are how every
   *  client — a web tab, the desktop panel, the TUI — learns a session
   *  appeared, was renamed, or went away. */
  | { type: 'session.created'; properties: { session: MachineSession } }
  | { type: 'session.updated'; properties: { session: MachineSession } }
  | { type: 'session.deleted'; properties: { sessionId: string } }
  /** What the conversation has cost so far, republished every time a turn
   *  lands in the spend ledger — including turns nobody was watching. */
  | { type: 'session.spend'; properties: { sessionId: string; cost: number; unpricedTurns: number } }
  /** A passage of one conversation carried into another, and the undoing of
   *  it. Published so BOTH ends update without asking. */
  | { type: 'context.linked'; properties: { link: ContextLink } }
  | { type: 'context.unlinked'; properties: { id: string } }
  | { type: 'permission.replied'; properties: { id: string; response: PermissionOutcome } }
  | { type: 'session.compacted'; properties: { sessionId: string; tokensBefore: number; tokensAfter: number } }
  /** The machine's OWN boot narration (kernel/boot-narration.ts) — same wire
   *  shape as the Platform's provisioning entries so the two render as one
   *  feed. */
  | { type: 'machine.boot.snapshot'; properties: { lines: MachineLogEntry[] } }
  | { type: 'machine.boot.line'; properties: { line: MachineLogEntry } }
  | { type: 'machine.boot.reset'; properties: Record<string, never> }
  | { type: 'goal.updated'; properties: { goal: Goal } }
  | { type: 'goal.removed'; properties: { id: string; sessionId: string } }
  | { type: 'task.updated'; properties: { task: DispatchedTask } }
  | { type: 'workflow.updated'; properties: { workflow: Workflow } }
  | { type: 'workflow.removed'; properties: { id: string } }
  | { type: 'workflow.run.updated'; properties: { run: WorkflowRun } }
  /** A run parked on a human decision. The run push carries the same state,
   *  but a first-class event means a surface can raise a prompt without
   *  diffing a whole run payload to notice one node flipped to `waiting`. */
  | {
      type: 'workflow.approval.requested'
      properties: {
        runId: string
        nodeRunId: string
        workflowId: string
        workflowName: string
        title: string
        message: string
        expiresAt: string | null
        projectId: string | null
      }
    }
  | {
      type: 'workflow.approval.decided'
      properties: { runId: string; nodeRunId: string; decision: 'approved' | 'rejected'; decidedBy: string | null }
    }
  /** The org asset library moved on. A signal to re-read rather than a
   *  snapshot — `assetId` is null when several rows may have changed at once. */
  | {
      type: 'org-asset.updated'
      properties: { action: 'installed' | 'published' | 'removed' | 'org-changed'; assetId: string | null }
    }
  /** The organisation preset this machine was created from has a change to
   *  offer, or one was just applied. Nothing is installed by either action. */
  | { type: 'org-preset.updated'; properties: { action: 'org-changed' | 'synced' } }
  /** An integration pack put its content on this machine. Same "re-read"
   *  signal as `org-asset.updated`, for the same reason. */
  | { type: 'pack.updated'; properties: { action: 'installed'; packId: string } }
  /** This machine's read-only mirror of the org's curated knowledge was
   *  re-synced. Unlike `org-asset.updated`, the sync has already happened. */
  | { type: 'org-knowledge.updated'; properties: { entries: number } }
  | { type: 'ports.changed'; properties: { ports: number[] } }
  /** The shells this machine is running. A whole snapshot: a terminal ends
   *  when its process exits, which has no mutation moment to diff against. */
  | { type: 'terminals.changed'; properties: { terminals: TerminalInfo[] } }
  | { type: 'processes.changed'; properties: { processes: TrackedProcess[] } }
  | { type: 'process.log.changed'; properties: { id: string } }
  /** The declared services with their live runtime resolved. A whole snapshot:
   *  status is DERIVED machine-side, so a crash or an external kill has no
   *  mutation moment to diff against. */
  | { type: 'services.changed'; properties: { services: Service[]; unmanaged: UnmanagedProcess[] } }
  | { type: 'secrets.changed'; properties: { key: string; action: 'set' | 'deleted' } }
  /** One repo's branch/commit/push state moved, whoever moved it — the routes,
   *  the agent's raw `git`, the git plugin. A signal, not a payload. */
  | { type: 'git.changed'; properties: { directory: string } }
  | { type: 'permissions.changed'; properties: { tools: string[] } }
  /** Whether this machine's provider config is behind the org's current
   *  defaults. Applying can abort an in-flight generation, so it is never
   *  automatic. */
  | { type: 'providers.outdated'; properties: { pending: boolean } }
  /** A sign-in to a provider's account moved: the machine polls GitHub for the
   *  approval itself, so this is how the client that started it — or any
   *  other — learns how it ended. `connected` is followed by the ordinary
   *  provider announcements. */
  | {
      type: 'provider.login'
      properties: {
        providerId: string
        status: 'pending' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'failed'
        message?: string
      }
    }
  /** The org spend budgets binding this machine, re-evaluated after every
   *  completed turn. `blocked` means new turns are refused — an in-flight one
   *  always finishes. */
  | { type: 'usage.budget'; properties: { budget: MachineBudget } }
  /** A permission ask no client was subscribed to live — machine-wide by
   *  construction. */
  | {
      type: 'permission.asked'
      properties: {
        permission: {
          id: string
          sessionId: string
          directory: string
          tool: string
          input: unknown
          createdAt: string
        }
      }
    }
  /** `session-ended` means the turn holding the ask died without it ever being
   *  replied to. */
  | {
      type: 'permission.resolved'
      properties: { requestId: string; resolution: 'answered' | 'auto-denied' | 'session-ended' }
    }
  /** The org permission policy this machine enforces — a snapshot on connect,
   *  then a fresh document whenever an admin saves one and the machine
   *  re-pulls it. */
  | { type: 'agent-policy.updated'; properties: { policy: AgentPolicy } }
  /** A policy rule just stopped something. Carries the rule so the UI can say
   *  WHICH one — a refusal the user cannot explain is worse than no policy. */
  | { type: 'agent-policy.blocked'; properties: AgentPolicyBlock }
  /** Who may reach which of this machine's sessions changed. Machine-shaped
   *  rows only: names and emails are org directory data and never cross onto
   *  a machine. The SIGNAL, not the payload. */
  | {
      type: 'session.grants'
      properties: {
        grants: Array<{
          id: string
          sessionId: string
          granteeUserId: number
          level: 'observe' | 'control'
          expiresAt: string
        }>
      }
    }
  /** Cross-machine delegation. `delegation.updated` is the RECEIVING machine's
   *  view; `delegation.reported` fires on the SENDING machine once a settled
   *  delegation's report has been posted into the session that raised it. */
  | { type: 'delegation.updated'; properties: { delegation: MachineDelegation } }
  | {
      type: 'delegation.reported'
      properties: { id: string; sessionId: string; status: 'done' | 'failed' | 'declined' | 'blocked' }
    }
  | { type: 'machine.heartbeat'; properties: Record<string, never> }
