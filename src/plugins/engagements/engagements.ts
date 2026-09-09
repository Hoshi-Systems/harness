import { randomUUID } from 'node:crypto'

import {
  deriveEngagementStatus,
  isActive,
  kickoffMessage,
  managerReport,
  nodeOf,
  readyNodes,
  settleUnreachable,
  type Engagement,
  type EngagementAssignmentNode,
  type EngagementNode,
  type EngagementNodeRun,
} from './graph.js'
import {
  abortTurn,
  apiError,
  attachToTurn,
  createCachedStore,
  createSession,
  isTurnRunning,
  keepLatest,
  publishMachineEvent,
  readMessages,
  sendMessage,
} from '../../kernel/index.js'

/**
 * ── Running a declared process ───────────────────────────────────────────────
 *
 * ./graph.ts owns the algebra. This is what makes it happen:
 * open a session per step up front, then repeatedly start everything the graph
 * says is ready and collect what comes back.
 *
 * STARTING IS A SET OPERATION, AND THAT IS THE POINT. `advance` dispatches the
 * ENTIRE ready frontier before it waits on any of it, so two independent
 * specialists begin within milliseconds of each other. Left to sequence the
 * calls itself a model mostly does not — it delegates, waits, delegates again —
 * and a plan that reads as parallel runs strictly serially. Here the model
 * declares the shape once and the schedule is not its problem.
 *
 * EVERY STEP IS A REAL SESSION, and it exists before the work does. A client
 * can open a specialist's transcript from the moment the team is assembled
 * rather than once it reports, which is the difference between watching a
 * process and waiting on one. Opening one costs a file write and no generation.
 *
 * A step runs through `sendMessage` like any other turn — see the `archetype`
 * option there. Giving engagements their own way to run a turn would have meant
 * a second copy of history, events, approvals, abort and compaction, each free
 * to drift from the one the rest of the machine uses.
 *
 * WHY NOT THE LIBRARY'S OWN DELEGATION: an Agent given `subagents` grows a
 * `task` tool and runs one child at a time, decided in the moment — that is
 * still the right thing for a single hand-off and is untouched. This is the
 * layer above it: a whole shape, stated once, scheduled by the machine.
 */

const MAX_ENGAGEMENTS = 40

/** A single step's ceiling. Generous — real work is long — but finite, so a
 *  wedged turn cannot hold an engagement (and the manager's own turn) open
 *  forever. */
const STEP_TIMEOUT_MS = 60 * 60_000

interface EngagementStore {
  engagements: Engagement[]
}

const store = createCachedStore<EngagementStore>('engagements.json', (stored) => {
  const parsed = stored as EngagementStore | null
  const engagements = Array.isArray(parsed?.engagements) ? parsed.engagements : []
  return {
    engagements: engagements.filter((entry) => entry && typeof entry.id === 'string' && Array.isArray(entry.nodes)),
  }
})

/** Resolvers waiting for an engagement to stop being `running` — one per
 *  in-flight `team_plan`/`team_resume` call. */
const waiters = new Map<string, Set<() => void>>()

/** Everything a client would repaint on. */
function signature(engagement: Engagement): string {
  return `${engagement.status}|${engagement.nodes.map((node) => engagement.runs[node.key]?.status).join(',')}`
}

/**
 * The last signature actually pushed, per live engagement.
 *
 * Kept HERE rather than compared inside `restate`, because by the time
 * `restate` runs the mutation it is meant to detect has already happened —
 * `advance` flips a step to `running` and only then asks whether anything
 * moved, so a "before" snapshot taken at that point is the after. That bug made
 * a whole engagement publish exactly twice, all-blocked and then all-done,
 * which is precisely the "it never shows me what is happening now" this feature
 * exists to fix.
 */
const publishedSignatures = new Map<string, string>()

function publish(engagement: Engagement): void {
  engagement.updatedAt = Date.now()
  store.persist()
  if (engagement.status === 'running') publishedSignatures.set(engagement.id, signature(engagement))
  else publishedSignatures.delete(engagement.id)
  publishMachineEvent('engagement.updated', { engagement })
  if (engagement.status !== 'running') {
    const pending = waiters.get(engagement.id)
    if (!pending) return
    waiters.delete(engagement.id)
    for (const resolve of pending) resolve()
  }
}

/** Re-derive the engagement's own status from its steps, and push it if
 *  anything actually moved. */
function restate(engagement: Engagement): void {
  settleUnreachable(engagement)
  engagement.status = deriveEngagementStatus(engagement)
  if (publishedSignatures.get(engagement.id) !== signature(engagement)) publish(engagement)
}

export async function getEngagement(id: string): Promise<Engagement | null> {
  return (await store.load()).engagements.find((entry) => entry.id === id) ?? null
}

export async function listEngagements(parentSessionId?: string): Promise<Engagement[]> {
  const all = [...(await store.load()).engagements].sort((a, b) => b.createdAt - a.createdAt)
  return parentSessionId ? all.filter((entry) => entry.parentSessionId === parentSessionId) : all
}

async function requireEngagement(id: string, parentSessionId: string): Promise<Engagement> {
  const engagement = await getEngagement(id)
  if (!engagement) apiError(404, 'engagement_not_found', `No engagement "${id}" on this machine.`)
  if (engagement.parentSessionId !== parentSessionId) {
    apiError(403, 'engagement_other_session', `Engagement "${id}" belongs to another session.`)
  }
  return engagement
}

// ── Starting ─────────────────────────────────────────────────────────────────

/** Open a session per step and start everything the graph opens with. Returns
 *  as soon as the first frontier is dispatched — the caller decides whether to
 *  wait (see {@link awaitEngagement}). */
export async function startEngagement(input: {
  parentSessionId: string
  directory: string
  title: string
  nodes: EngagementNode[]
  model?: string
}): Promise<Engagement> {
  const runs: Record<string, EngagementNodeRun> = {}
  for (const node of input.nodes) {
    const session =
      node.kind === 'assignment'
        ? await createSession(input.directory, {
            parentId: input.parentSessionId,
            title: `${node.role} · ${input.title}`,
          })
        : null
    runs[node.key] = {
      key: node.key,
      status: 'blocked',
      sessionId: session?.id ?? null,
      archetype: node.kind === 'assignment' ? node.archetype : null,
      report: null,
      error: null,
      startedAt: null,
      endedAt: null,
    }
  }

  const now = Date.now()
  const engagement: Engagement = {
    id: `eng_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    parentSessionId: input.parentSessionId,
    directory: input.directory,
    title: input.title,
    status: 'running',
    nodes: input.nodes,
    runs,
    createdAt: now,
    updatedAt: now,
    ...(input.model ? { model: input.model } : {}),
  }

  const state = await store.load()
  state.engagements = keepLatest([...state.engagements, engagement], MAX_ENGAGEMENTS)
  publish(engagement)

  await advance(engagement)
  return engagement
}

/** Resolve once the engagement stops running — it finished, failed, was
 *  cancelled, or parked on a checkpoint. `signal` is the caller's own abort
 *  (the manager's turn ending), which stops the WAIT without touching the run;
 *  ending the work itself is {@link cancelEngagement}. */
export function awaitEngagement(engagement: Engagement, signal?: AbortSignal): Promise<void> {
  if (engagement.status !== 'running') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const pending = waiters.get(engagement.id) ?? new Set()
    const settle = () => {
      pending.delete(settle)
      signal?.removeEventListener('abort', settle)
      resolve()
    }
    pending.add(settle)
    waiters.set(engagement.id, pending)
    signal?.addEventListener('abort', settle, { once: true })
  })
}

// ── The frontier ─────────────────────────────────────────────────────────────

/** The specialist's own prose from its finished turn — its report. */
async function reportOf(sessionId: string): Promise<string> {
  const messages = await readMessages(sessionId)
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!last) return ''
  return last.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Watch one step's turn to its end, then settle it and open whatever that
 *  unblocked. Event-driven: the turn tells us when it is over.
 *
 *  THE REPORT COMES OFF THE STREAM, not out of storage. Subscribers are told
 *  the turn is done BEFORE its message is written back (kernel/turns.ts's
 *  `finally` notifies, then persists), so a read here would find the parts
 *  still empty and every specialist would come back having "finished without a
 *  written report". The text a step streamed IS its report, so taking it from
 *  the stream removes the race rather than timing around it.
 *
 *  `attachToTurn` returning null means the turn is ALREADY over — a real race,
 *  because `sendMessage` returns as soon as generation starts and a short
 *  answer can beat this line. Then storage is settled and is the right source. */
function watchStep(engagement: Engagement, key: string, sessionId: string): void {
  let streamed = ''
  const settle = (text: string | null) => {
    void finishStep(engagement, key, sessionId, text).catch((error) => {
      console.error(`[engagements] could not settle "${key}" of ${engagement.id}:`, error)
    })
  }
  const attached = attachToTurn(sessionId, {
    onChunk: (chunk) => {
      streamed += chunk
    },
    onDone: () => settle(streamed),
  })
  if (attached) streamed = attached.replay
  else settle(null)
}

async function finishStep(
  engagement: Engagement,
  key: string,
  sessionId: string,
  streamed: string | null,
): Promise<void> {
  const run = engagement.runs[key]
  if (!run || run.status !== 'running') return
  run.endedAt = Date.now()
  const report = (streamed ?? (await reportOf(sessionId))).trim()
  run.status = 'done'
  run.report = report || 'The specialist finished its turn without a written report.'
  await advance(engagement)
}

/** Start everything the graph says is ready, together. A checkpoint parks the
 *  engagement instead of running: it is the manager's own step, and the answer
 *  arrives through {@link resumeEngagement}. */
async function advance(engagement: Engagement): Promise<void> {
  const ready = readyNodes(engagement)
  if (!ready.length) {
    restate(engagement)
    return
  }

  await Promise.all(
    ready.map(async (node) => {
      const run = engagement.runs[node.key]!
      if (node.kind === 'checkpoint') {
        run.status = 'waiting'
        run.startedAt = Date.now()
        return
      }
      if (!run.sessionId) {
        run.status = 'error'
        run.error = 'This step has no session — the engagement outlived it.'
        run.endedAt = Date.now()
        return
      }
      try {
        run.status = 'running'
        run.startedAt = Date.now()
        await sendMessage(run.sessionId, {
          text: kickoffMessage(engagement, node),
          ...((node as EngagementAssignmentNode).archetype
            ? { archetype: (node as EngagementAssignmentNode).archetype! }
            : {}),
          /**
           *
           * The step's own model if it named one; otherwise the manager's, as
           * the rung BELOW whatever the step's archetype asks for. `inherit`
           * parses to null (graph.ts), so a step that said nothing lands here
           * with the manager's model and its archetype's tier still able to
           * speak over it (kernel/turns.ts `parentModel`).
           *
           **/
          ...(node.model ? { model: node.model } : {}),
          ...(engagement.model ? { parentModel: engagement.model } : {}),
        })
        watchStep(engagement, node.key, run.sessionId)
      } catch (error) {
        run.status = 'error'
        run.error = error instanceof Error ? error.message : String(error)
        run.endedAt = Date.now()
      }
    }),
  )
  restate(engagement)
}

/** Sweep live engagements for steps that overran, or that a restart left
 *  believing they were running. Called by the engagements plugin's tick —
 *  everything else here is event-driven, and this is only the backstop. */
export async function sweepEngagements(): Promise<void> {
  for (const engagement of (await store.load()).engagements.filter((entry) => entry.status === 'running')) {
    try {
      let moved = false
      for (const node of engagement.nodes) {
        const run = engagement.runs[node.key]!
        if (run.status !== 'running' || !run.sessionId) continue

        if (run.startedAt && Date.now() - run.startedAt > STEP_TIMEOUT_MS) {
          abortTurn(run.sessionId)
          run.status = 'error'
          run.error = `"${node.key}" ran past the ${STEP_TIMEOUT_MS / 60_000}-minute ceiling and was stopped.`
          run.endedAt = Date.now()
          moved = true
          continue
        }
        // Nothing generating and nothing watching it: the turn ended while this
        // process was not listening (a restart between dispatch and its `onDone`).
        if (!isTurnRunning(run.sessionId)) {
          await finishStep(engagement, node.key, run.sessionId, null)
          moved = true
        }
      }
      if (!moved) restate(engagement)
    } catch (error) {
      console.error(`[engagements] sweep failed for ${engagement.id}:`, error)
    }
  }
}

// ── The manager's own moves ──────────────────────────────────────────────────

/** Answer a checkpoint. The decision becomes that step's report and travels
 *  down its edges exactly like a specialist's would — the manager is a step in
 *  its own process, not a special case outside it. */
export async function resumeEngagement(
  id: string,
  parentSessionId: string,
  key: string,
  decision: string,
): Promise<Engagement> {
  const engagement = await requireEngagement(id, parentSessionId)
  const node = nodeOf(engagement, key)
  const run = engagement.runs[key]
  if (!node || !run) apiError(404, 'engagement_no_such_step', `Engagement "${id}" has no step "${key}".`)
  if (node.kind !== 'checkpoint' || run.status !== 'waiting') {
    const waiting = engagement.nodes
      .filter((entry) => engagement.runs[entry.key]?.status === 'waiting')
      .map((entry) => entry.key)
      .join(', ')
    apiError(
      409,
      'engagement_not_waiting',
      `"${key}" is not a checkpoint waiting on you.${waiting ? ` Waiting right now: ${waiting}.` : ''}`,
    )
  }
  run.status = 'done'
  run.report = decision.trim()
  run.endedAt = Date.now()
  await advance(engagement)
  return engagement
}

/** Stop everything. In-flight specialists are aborted so no orphan keeps
 *  burning tokens; their transcripts stay. */
export async function cancelEngagement(id: string, parentSessionId: string): Promise<Engagement> {
  const engagement = await requireEngagement(id, parentSessionId)
  for (const node of engagement.nodes) {
    const run = engagement.runs[node.key]!
    if (run.status === 'running' && run.sessionId) abortTurn(run.sessionId)
    if (run.status === 'blocked' || run.status === 'running' || run.status === 'waiting') {
      run.status = 'cancelled'
      run.endedAt = Date.now()
    }
  }
  engagement.status = 'cancelled'
  publish(engagement)
  return engagement
}

/** Boot recovery. Sessions and reports are on disk, so an engagement
 *  interrupted by a restart is picked up by the sweep — which finds each step's
 *  turn already over and settles it. One that has nothing left in flight is
 *  simply restated. */
export async function recoverEngagements(): Promise<void> {
  for (const engagement of (await store.load()).engagements) {
    if (engagement.status === 'running' && !isActive(engagement)) restate(engagement)
  }
  await sweepEngagements()
}

/** The engagement's outcome, as the manager reads it. */
export function engagementSummary(engagement: Engagement): {
  status: Engagement['status']
  reports: Array<{ key: string; role: string; report: string }>
  checkpoint: { key: string; question: string } | null
  failures: Array<{ key: string; error: string }>
} {
  const waiting = engagement.nodes.find(
    (node) => node.kind === 'checkpoint' && engagement.runs[node.key]?.status === 'waiting',
  )
  return {
    status: engagement.status,
    reports: managerReport(engagement),
    checkpoint: waiting && waiting.kind === 'checkpoint' ? { key: waiting.key, question: waiting.question } : null,
    failures: engagement.nodes
      .filter((node) => engagement.runs[node.key]?.status === 'error')
      .map((node) => ({ key: node.key, error: engagement.runs[node.key]!.error ?? 'unknown error' })),
  }
}
