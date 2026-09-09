import { apiError, createCachedStore, keepLatest, publishMachineEvent } from '../../kernel/index.js'
import type { Goal, GoalStatus } from '../../wire/index.js'

/**
 * ── Goal store (CYB-100) ─────────────────────────────────────────────────────
 *
 * "Session goals" turn a single prompt into an automated finish line: the user
 * arms goal mode, sends an objective, and the machine itself (plugins/goal-loop.ts)
 * audits the agent's latest reply after every turn and either sends a generic
 * continuation, marks the goal done, or gives up after three consecutive
 * "stuck" verdicts. This has to survive the browser closing, so it lives here
 * — the machine side — persisted to ~/.hoshi/goals.json, same atomic-write
 * convention as schedules.json (utils/triggers.ts) and tasks.json
 * (utils/task-queue.ts). One goal may be active (running/paused) per session
 * at a time; a session's terminal goal stays around (for the status strip)
 * until the client dismisses it or a new one is armed.
 *
 **/

/** Keep the persisted history from growing unbounded — mirrors task-queue.ts's
 *  MAX_TASKS trim. Only ever drops long-settled goals; an active one is always
 *  among the most recent pushes. */
const MAX_GOALS = 200

export type { GoalStatus }

/** Statuses the goal loop still actively drives. Everything else is terminal
 *  (or paused, which the loop skips until resumed). */
const ACTIVE_GOAL_STATUSES: GoalStatus[] = ['running', 'paused']

/** Whether the loop still drives this goal. Exported because "is a goal running
 *  on this session" is the gate several unattended paths need — notably the
 *  alert reporter, which must not notify per continuation (utils/alerts.ts). */
export function isGoalActive(status: GoalStatus): boolean {
  return ACTIVE_GOAL_STATUSES.includes(status)
}

/** The wire shape — declared in @hoshi/shared (machine-events.ts), where the
 *  field-level docs now live too. A field added here without the contract is a
 *  compile error. */
export type { Goal }

interface GoalStore {
  goals: Goal[]
}

const goalStore = createCachedStore<GoalStore>('goals.json', (stored) => {
  const parsed = stored as GoalStore | null
  return parsed && Array.isArray(parsed.goals) ? parsed : { goals: [] }
})

/** Bounds for the safety limits a goal is created with. */
const DEFAULT_MAX_CONTINUATIONS = 20
const MAX_MAX_CONTINUATIONS = 200
const MIN_TOKEN_BUDGET = 1_000

const MAX_OBJECTIVE_LENGTH = 8_000

export function validateObjective(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_OBJECTIVE_LENGTH) {
    apiError(400, 'goal.objectiveLength', `Enter an objective (1–${MAX_OBJECTIVE_LENGTH} characters).`, {
      max: MAX_OBJECTIVE_LENGTH,
    })
  }
  return value.trim()
}

/** `maxContinuations`/`tokenBudget` are both optional on create — a fixed
 *  sensible default covers v1 (no Settings-page override yet). */
export function validateLimits(
  maxContinuationsRaw: unknown,
  tokenBudgetRaw: unknown,
): { maxContinuations: number; tokenBudget: number | null } {
  let maxContinuations = DEFAULT_MAX_CONTINUATIONS
  if (maxContinuationsRaw !== undefined && maxContinuationsRaw !== null) {
    const n = Number(maxContinuationsRaw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_CONTINUATIONS) {
      apiError(400, 'goal.maxContinuationsRange', `maxContinuations must be 1–${MAX_MAX_CONTINUATIONS}.`, {
        max: MAX_MAX_CONTINUATIONS,
      })
    }
    maxContinuations = n
  }

  let tokenBudget: number | null = null
  if (tokenBudgetRaw !== undefined && tokenBudgetRaw !== null) {
    const n = Number(tokenBudgetRaw)
    if (!Number.isInteger(n) || n < MIN_TOKEN_BUDGET) {
      apiError(400, 'goal.tokenBudgetRange', `tokenBudget must be at least ${MIN_TOKEN_BUDGET}.`, {
        min: MIN_TOKEN_BUDGET,
      })
    }
    tokenBudget = n
  }

  return { maxContinuations, tokenBudget }
}

export async function listGoals(sessionId?: string): Promise<Goal[]> {
  const goals = (await goalStore.load()).goals
  return sessionId ? goals.filter((g) => g.sessionId === sessionId) : goals
}

/** The one goal that matters for a session right now: an active one
 *  (running/paused) if there is one, otherwise the most recent (so a
 *  just-settled goal's status strip survives a page reload until dismissed). */
export async function getCurrentGoalForSession(sessionId: string): Promise<Goal | undefined> {
  const goals = (await goalStore.load()).goals.filter((g) => g.sessionId === sessionId)
  return goals.find((g) => ACTIVE_GOAL_STATUSES.includes(g.status)) ?? goals.at(-1)
}

async function getGoal(id: string): Promise<Goal | undefined> {
  return (await goalStore.load()).goals.find((g) => g.id === id)
}

/** One goal per session at a time — refuses to arm a second one over an
 *  already-active (running/paused) goal. */
export async function createGoal(fields: {
  sessionId: string
  objective: string
  maxContinuations: number
  tokenBudget: number | null
}): Promise<Goal> {
  const store = await goalStore.load()
  const existing = store.goals.find((g) => g.sessionId === fields.sessionId && ACTIVE_GOAL_STATUSES.includes(g.status))
  if (existing) {
    apiError(409, 'goal.alreadyActive', 'This session already has an active goal.')
  }

  const now = new Date().toISOString()
  const goal: Goal = {
    id: crypto.randomUUID(),
    sessionId: fields.sessionId,
    objective: fields.objective,
    status: 'running',
    progressNote: null,
    auditing: false,
    continuationCount: 0,
    maxContinuations: fields.maxContinuations,
    stuckCount: 0,
    tokensUsed: 0,
    tokenBudget: fields.tokenBudget,
    lastMessageId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
  store.goals.push(goal)
  store.goals = keepLatest(store.goals, MAX_GOALS)
  goalStore.persist()
  publishMachineEvent('goal.updated', { goal })
  return goal
}

/** Merge a partial into a goal and stamp `updatedAt`. The one mutation path
 *  every route/plugin tick funnels through, so `updatedAt`/persistence never
 *  drift out of sync with a field change — and the one place a change gets
 *  pushed to watching clients (the live status strip, the settle toast). */
export async function patchGoal(
  id: string,
  patch: Partial<Omit<Goal, 'id' | 'sessionId' | 'createdAt'>>,
): Promise<Goal | undefined> {
  const store = await goalStore.load()
  const goal = store.goals.find((g) => g.id === id)
  if (!goal) return undefined
  Object.assign(goal, patch, { updatedAt: new Date().toISOString() })
  goalStore.persist()
  publishMachineEvent('goal.updated', { goal })
  return goal
}

export async function pauseGoal(id: string): Promise<Goal> {
  const goal = await getGoal(id)
  if (!goal) apiError(404, 'goal.notFound', 'Goal not found.')
  if (goal.status !== 'running') apiError(400, 'goal.notRunning', 'Only a running goal can be paused.')
  return (await patchGoal(id, { status: 'paused' }))!
}

export async function resumeGoal(id: string): Promise<Goal> {
  const goal = await getGoal(id)
  if (!goal) apiError(404, 'goal.notFound', 'Goal not found.')
  if (goal.status !== 'paused') apiError(400, 'goal.notPaused', 'Only a paused goal can be resumed.')
  return (await patchGoal(id, { status: 'running' }))!
}

export async function deleteGoal(id: string): Promise<boolean> {
  const store = await goalStore.load()
  const goal = store.goals.find((g) => g.id === id)
  if (!goal) return false
  store.goals = store.goals.filter((g) => g.id !== id)
  goalStore.persist()
  publishMachineEvent('goal.removed', { id, sessionId: goal.sessionId })
  return true
}

/** Every goal the loop still needs to tick — running only; paused/terminal
 *  goals are inert until resumed. */
export async function listRunningGoals(): Promise<Goal[]> {
  return (await goalStore.load()).goals.filter((g) => g.status === 'running')
}
