// ── The engagement graph ─────────────────────────────────────────────────────
// An ENGAGEMENT is the manager's declared process: who it hires, what each of
// them owes, and who hands their result to whom. It is a DAG of NODES joined by
// one kind of edge — `dependsOn` — and everything else falls out of that:
//
//   A node runs once every node it depends on is done, and each of those nodes'
//   reports is spliced into its kickoff message.
//
// That single rule is what buys the three properties the delegation protocol
// was missing. Independent nodes are ready at the same moment, so PARALLELISM
// is structural rather than a plea in the prompt that a model may or may not
// honour. A report travels along the edge to the next worker, so the manager
// stops being the mailbox every result has to pass through. And the shape is
// declared before anything runs, so a client can draw the whole process while
// it is still hiring.
//
// TWO NODE KINDS, NOT TEN. `assignment` is a specialist doing work;
// `checkpoint` is the manager itself sitting in its own flow — the run stops
// there and hands control back, and the manager's answer becomes that node's
// report and flows on down the same edges. Resisting a `branch`/`loop`/`http`
// menagerie here is deliberate: an engagement is minted per turn by a model and
// never drawn, so it is a different object from a user-authored workflow on a
// canvas. If an engagement ever needs conditions, it should become a workflow
// rather than grow a second copy of that engine.
//
// WHAT THIS IS NOT: a replacement for the library's own delegation. An Agent
// given `subagents` already grows a `task` tool and runs a child loop — one
// specialist, one job, decided in the moment. This is the layer above: the
// manager states the whole shape ONCE, and the machine schedules it. That is
// the part the model kept getting wrong when it was left to sequence the calls
// itself.
//
// Everything in this file is PURE: validation, cycle detection, the ready set,
// and how a node's kickoff is assembled. The store, the engine and the clock
// live in ./engagements.ts, which is what makes the hard part testable
// (./graph.test.ts).

import { apiError } from '../../kernel/index.js'

// ── Limits ───────────────────────────────────────────────────────────────────
// A run embeds its whole graph in every event it publishes, so these are
// ceilings rather than guidance. The assignment cap matches a cap that keeps one
// engagement from being an unbounded fan-out.

const MAX_NODES = 16
const MAX_KEY = 40
const MAX_ROLE = 60
const MAX_BRIEF = 8_000
const MAX_QUESTION = 2_000
/** How much of one report is carried into a dependent's kickoff. A report is
 *  written for a machine and is meant to be terse; a runaway one must not be
 *  able to blow up every downstream prompt. */
const MAX_INHERITED_REPORT = 12_000

/** How a node is addressed by another node's `dependsOn`. Slug-shaped, so a
 *  key never needs quoting and reads as a name in the UI. */
const NODE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/

export interface EngagementAssignmentNode {
  kind: 'assignment'
  key: string
  /** Display role — "researcher", "market analyst". What the UI names this step. */
  role: string
  /** Seeded archetype this instantiates, or null for a freeform hire. */
  archetype: string | null
  brief: string
  readOnly: boolean
  /** `provider/model`, or null to inherit — the engagement's model, and failing
   *  that the machine's default. Kept as the REF the rest of the machine speaks
   *  (`SendOptions.model`) rather than a parsed pair, so nothing has to
   *  reassemble it on the way to a turn. */
  model: string | null
  dependsOn: string[]
  /** Force this node's report into the manager's final result. Sinks (nothing
   *  depends on them) are included regardless — this is for the mid-graph node
   *  whose findings the manager wants to see even though a colleague consumed
   *  them. */
  reportToManager: boolean
}

export interface EngagementCheckpointNode {
  kind: 'checkpoint'
  key: string
  /** What the manager is being called back to decide. */
  question: string
  dependsOn: string[]
}

export type EngagementNode = EngagementAssignmentNode | EngagementCheckpointNode

export type EngagementNodeStatus =
  /** Nothing has started it yet: something it depends on hasn't finished, or
   *  it is ready and the next dispatch pass will pick it up. The frontier is
   *  DERIVED from this plus the dependency statuses ({@link readyNodes}) —
   *  there is no separate "ready" state to keep in sync with the graph. */
  | 'blocked'
  | 'running'
  /** A checkpoint the manager hasn't answered yet. Holds no concurrency. */
  | 'waiting'
  | 'done'
  | 'error'
  /** The engagement ended before this could run. */
  | 'cancelled'

export interface EngagementNodeRun {
  key: string
  status: EngagementNodeStatus
  /** The specialist's child session — created up front, so a client can open a
   *  worker's transcript from the moment the team is assembled rather than once
   *  it reports. Null for a checkpoint, which has no session of its own. */
  sessionId: string | null
  /** The archetype this worker was instantiated from, or null for a freeform hire. */
  archetype: string | null
  /** What it handed back: an assignment's report, a checkpoint's decision. */
  report: string | null
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export type EngagementStatus = 'running' | 'checkpoint' | 'done' | 'error' | 'cancelled'

export interface Engagement {
  id: string
  /** The manager's own model ref, inherited by every step that names none. */
  model?: string
  /** The manager's session — an engagement answers only the turn that declared it. */
  parentSessionId: string
  /** Working directory every child session is pinned to (null = machine scope). */
  directory: string | null
  title: string
  status: EngagementStatus
  nodes: EngagementNode[]
  runs: Record<string, EngagementNodeRun>
  createdAt: number
  updatedAt: number
}

/** Statuses that mean the engagement still has work in flight. */
const ACTIVE_NODE_STATUSES: ReadonlySet<EngagementNodeStatus> = new Set<EngagementNodeStatus>([
  'blocked',
  'running',
  'waiting',
])

// ── Validation ───────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY)
}

/** Validate a model reference: `provider/model`, or the literal "inherit" for
 *  whatever the manager is running on — the same spelling every model reference
 *  on this machine takes (kernel/model.ts `INHERIT`). */
function parseModel(spec: string, where: string): string | null {
  if (spec === 'inherit') return null
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) {
    apiError(
      400,
      'engagement_invalid_model',
      `${where}: model "${spec}" is not a provider/model reference (or the literal "inherit").`,
    )
  }
  return spec
}

/** Validate and normalize a declared plan into nodes. Rejects — with a reason
 *  the model can act on — anything the scheduler would otherwise have to guess
 *  about: duplicate keys, a dependency on a node that doesn't exist, a cycle,
 *  an assignment with neither role nor archetype. */
export function parseEngagementPlan(input: unknown, knownArchetypes: string[]): EngagementNode[] {
  const raw = (input as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(raw) || raw.length === 0) {
    apiError(400, 'engagement_empty_plan', 'An engagement needs at least one node.')
  }
  if (raw.length > MAX_NODES) {
    apiError(
      400,
      'engagement_too_many_nodes',
      `An engagement is capped at ${MAX_NODES} nodes; this one declared ${raw.length}.`,
    )
  }

  const nodes: EngagementNode[] = []
  const seen = new Set<string>()

  raw.forEach((entry, index) => {
    const spec = (entry ?? {}) as Record<string, unknown>
    const where = `Node #${index + 1}`
    const key = slug(str(spec.key))
    if (!key || !NODE_KEY.test(key)) {
      apiError(400, 'engagement_invalid_key', `${where}: "key" must be a short slug (letters, digits, - and _).`)
    }
    if (seen.has(key)) apiError(400, 'engagement_duplicate_key', `${where}: duplicate key "${key}".`)
    seen.add(key)

    const dependsOn = Array.isArray(spec.dependsOn)
      ? [...new Set(spec.dependsOn.map((d) => slug(str(d))).filter(Boolean))]
      : []
    if (dependsOn.includes(key)) {
      apiError(400, 'engagement_self_dependency', `${where}: "${key}" cannot depend on itself.`)
    }

    if (str(spec.kind) === 'checkpoint') {
      const question = str(spec.question)
      if (!question) {
        apiError(
          400,
          'engagement_checkpoint_question',
          `${where}: a checkpoint needs a "question" — what are you deciding?`,
        )
      }
      if (!dependsOn.length) {
        apiError(
          400,
          'engagement_checkpoint_dependency',
          `${where}: a checkpoint must depend on at least one node — it exists to review their reports.`,
        )
      }
      nodes.push({ kind: 'checkpoint', key, question: question.slice(0, MAX_QUESTION), dependsOn })
      return
    }

    const archetypeSpec = str(spec.archetype)
    const archetype = archetypeSpec ? slug(archetypeSpec) : null
    if (archetype && !knownArchetypes.includes(archetype)) {
      apiError(
        400,
        'engagement_unknown_archetype',
        `${where}: unknown archetype "${archetypeSpec}". This machine has: ${knownArchetypes.join(', ') || 'none seeded'}.`,
      )
    }
    const role = (str(spec.role) || archetype || '').slice(0, MAX_ROLE)
    if (!role) {
      apiError(400, 'engagement_missing_role', `${where}: give either an archetype or a freeform role label.`)
    }
    const brief = str(spec.brief)
    if (!brief)
      apiError(400, 'engagement_missing_brief', `${where} ("${role}"): a brief is required — nobody works blind.`)

    nodes.push({
      kind: 'assignment',
      key,
      role,
      archetype,
      brief: brief.slice(0, MAX_BRIEF),
      readOnly: spec.readOnly === true,
      model: parseModel(str(spec.model) || 'inherit', `${where} ("${role}")`),
      dependsOn,
      reportToManager: spec.reportToManager === true,
    })
  })

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!seen.has(dependency)) {
        apiError(
          400,
          'engagement_unknown_dependency',
          `Node "${node.key}" depends on "${dependency}", which isn't in this engagement.`,
        )
      }
    }
  }
  assertAcyclic(nodes)
  return nodes
}

/** Kahn sweep — a plan with a cycle can never reach a frontier, so it is
 *  refused at declaration time rather than hanging at run time. */
function assertAcyclic(nodes: EngagementNode[]): void {
  const remaining = new Map(nodes.map((node) => [node.key, new Set(node.dependsOn)]))
  let progressed = true
  while (progressed && remaining.size) {
    progressed = false
    for (const [key, deps] of remaining) {
      if (deps.size) continue
      remaining.delete(key)
      for (const other of remaining.values()) other.delete(key)
      progressed = true
    }
  }
  if (remaining.size) {
    apiError(
      400,
      'engagement_cyclic_plan',
      `These nodes depend on each other in a circle and can never start: ${[...remaining.keys()].join(', ')}.`,
    )
  }
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export function nodeOf(engagement: Engagement, key: string): EngagementNode | undefined {
  return engagement.nodes.find((node) => node.key === key)
}

/** Nodes whose every dependency is done and that haven't started — the
 *  frontier. Every one of them is dispatched in the same pass, which is where
 *  parallelism actually comes from. */
export function readyNodes(engagement: Engagement): EngagementNode[] {
  return engagement.nodes.filter((node) => {
    const run = engagement.runs[node.key]
    if (!run || run.status !== 'blocked') return false
    return node.dependsOn.every((key) => engagement.runs[key]?.status === 'done')
  })
}

/** Cancel every node that can never become ready, because something it depends
 *  on failed or was itself cancelled. Without this a single failed worker would
 *  leave its dependents `blocked` forever and the engagement would never
 *  settle. Repeated until nothing changes, so a whole downstream chain goes
 *  with it. Returns the keys it cancelled. */
export function settleUnreachable(engagement: Engagement): string[] {
  const cancelled: string[] = []
  const dead: ReadonlySet<EngagementNodeStatus> = new Set<EngagementNodeStatus>(['error', 'cancelled'])
  let progressed = true
  while (progressed) {
    progressed = false
    for (const node of engagement.nodes) {
      const run = engagement.runs[node.key]
      if (!run || run.status !== 'blocked') continue
      if (!node.dependsOn.some((key) => dead.has(engagement.runs[key]?.status ?? 'blocked'))) continue
      run.status = 'cancelled'
      run.endedAt = Date.now()
      run.error ??= 'Skipped — work it depended on did not finish.'
      cancelled.push(node.key)
      progressed = true
    }
  }
  return cancelled
}

/** Whether anything is still in flight. */
export function isActive(engagement: Engagement): boolean {
  return Object.values(engagement.runs).some((run) => ACTIVE_NODE_STATUSES.has(run.status))
}

/** The status the engagement as a whole has settled to, given its node runs.
 *  A checkpoint waiting on the manager is its own state, because the run has
 *  not failed and has not finished — it is holding for an answer. */
export function deriveEngagementStatus(engagement: Engagement): EngagementStatus {
  const runs = Object.values(engagement.runs)
  if (runs.some((run) => run.status === 'waiting')) return 'checkpoint'
  if (isActive(engagement)) return 'running'
  if (runs.some((run) => run.status === 'error')) return 'error'
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled'
  return 'done'
}

/** Nodes nothing else depends on — the ends of the process, whose reports are
 *  what the manager actually asked for. */
export function sinkKeys(engagement: Engagement): string[] {
  const consumed = new Set(engagement.nodes.flatMap((node) => node.dependsOn))
  return engagement.nodes.filter((node) => !consumed.has(node.key)).map((node) => node.key)
}

/** The kickoff message for a node: its own brief, preceded by the report of
 *  every node it depends on. This is the edge doing its job — a worker reads
 *  its predecessor's result directly instead of the manager relaying it. */
export function kickoffMessage(engagement: Engagement, node: EngagementNode): string {
  const inherited = node.dependsOn
    .map((key) => ({ node: nodeOf(engagement, key), run: engagement.runs[key] }))
    .filter((entry) => entry.run?.report)
    .map((entry) => {
      const from = entry.node?.kind === 'checkpoint' ? `${entry.node.key} (your manager's decision)` : entry.node?.key
      return [`### From ${from}`, '', entry.run!.report!.slice(0, MAX_INHERITED_REPORT)].join('\n')
    })

  if (node.kind === 'checkpoint') return node.question
  if (!inherited.length) return node.brief

  return [
    'Work that came before you in this engagement, in full — treat it as given and do not redo it:',
    '',
    ...inherited,
    '',
    '---',
    '',
    '## Your task',
    '',
    node.brief,
  ].join('\n')
}

/** What the manager gets back when the engagement settles: every sink's report
 *  plus anything explicitly marked `reportToManager`, in declaration order.
 *  Intermediate results deliberately do NOT appear — they already travelled
 *  along their edge to whoever needed them, which is the whole point of
 *  declaring the process instead of relaying every message by hand. */
export function managerReport(engagement: Engagement): Array<{ key: string; role: string; report: string }> {
  const sinks = new Set(sinkKeys(engagement))
  return engagement.nodes
    .filter((node) => node.kind === 'assignment' && (sinks.has(node.key) || node.reportToManager))
    .map((node) => ({
      key: node.key,
      role: (node as EngagementAssignmentNode).role,
      report: engagement.runs[node.key]?.report ?? engagement.runs[node.key]?.error ?? '(no report)',
    }))
}
