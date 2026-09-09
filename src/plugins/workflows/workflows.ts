import { apiError, createCachedStore, publishMachineEvent } from '../../kernel/index.js'
import { validateWorkflowGraph, type WorkflowGraph } from './graph/index.js'

/**
 * ── Workflow store ───────────────────────────────────────────────────────────
 *
 * A workflow is a graph of typed nodes (utils/workflow-graph.ts). Definitions
 * are machine-owned config — same tier as schedules.json — persisted to
 * ~/.hoshi/workflows.json. Execution state is a different concern and lives in
 * utils/workflow-runs.ts (workflow-runs.json), the same config-vs-history split
 * as triggers.ts vs task-queue.ts.
 *
 * A workflow has a DRAFT and a PUBLISHED version, and the distinction is the
 * point: a schedule that fires at 03:00 must not pick up whatever half-finished
 * edit was on the canvas at 02:59. Triggers resolve the published graph and
 * nothing else; the draft is what the builder edits and what a manual "run this
 * now" executes, which is how you try a change before committing to it.
 *
 * Publishing snapshots the draft as an immutable version. Versions are kept so a
 * bad publish can be walked back — `restoreWorkflowVersion` copies an old graph
 * back onto the DRAFT rather than silently changing what runs, so a rollback is
 * reviewed like any other edit before it goes live.
 *
 **/

const MAX_NAME = 120
const MAX_DESCRIPTION = 2_000
/** Enough history to walk back a bad afternoon; the whole list lives in one JSON
 *  file and each entry carries a full graph, so it is not unbounded. */
const MAX_VERSIONS = 20

/**
 *
 * `WorkflowVersion` and `Workflow` are field-for-field the wire shapes in
 * `@hoshi/shared` (machine-events.ts), and deliberately NOT aliased — held in
 * `check:wire-types`' KNOWN_DUPLICATES ledger instead. The graph chain under
 * them is why: this module's `WorkflowGraph` types every mapping as the
 * discriminated `Mapping` union the engine evaluates, while the wire types it
 * as the open record a client round-trips (`WorkflowMapping`), and an
 * interface is not assignable to an index-signature type. Aliasing these two
 * retires with unifying `Mapping` across the seam.
 *
 **/
export interface WorkflowVersion {
  /** 1-based, monotonic per workflow. Never reused, so a run's recorded version
   *  always names the graph it actually executed. */
  version: number
  graph: WorkflowGraph
  publishedAt: string
  note: string | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  /** Whether triggers may fire this workflow at all. Independent of publishing:
   *  an enabled workflow with nothing published still cannot be triggered. */
  enabled: boolean
  /** Optional Platform checkout binding — a run's session is created in that
   *  checkout's directory. Null = personal space. */
  projectId: string | null
  /** The editable graph. Always present: a workflow is created with one. */
  draft: WorkflowGraph
  /** Which version triggers fire. Null until the first publish. */
  publishedVersion: number | null
  /** Newest first, capped at MAX_VERSIONS. */
  versions: WorkflowVersion[]
  createdAt: string
  updatedAt: string
}

interface WorkflowStore {
  workflows: Workflow[]
}

const workflowStore = createCachedStore<WorkflowStore>('workflows.json', (stored) => {
  const parsed = stored as WorkflowStore | null
  const store = parsed && Array.isArray(parsed.workflows) ? parsed : { workflows: [] }
  /**
   *
   * Anything that isn't already a graph workflow is dropped rather than guessed
   * at. There is no released version of this product to be compatible with, and
   * a half-understood definition running on a schedule is worse than an empty
   * list — but say so in the log rather than vanishing quietly.
   *
   **/
  const before = store.workflows.length
  store.workflows = store.workflows.filter((workflow) => workflow && typeof workflow === 'object' && workflow.draft)
  if (store.workflows.length !== before) {
    console.warn(
      `[workflows] dropped ${before - store.workflows.length} definition(s) from workflows.json that predate the graph model.`,
    )
  }
  for (const workflow of store.workflows) {
    workflow.versions ??= []
    workflow.publishedVersion ??= null
  }
  return store
})

/** The graph a TRIGGER should run: the published one, or null if the workflow
 *  has never been published. Callers turn null into their own refusal — a
 *  schedule logs and skips, a webhook 404s — so this never guesses. */
export function publishedGraph(workflow: Workflow): WorkflowGraph | null {
  if (workflow.publishedVersion === null) return null
  return workflow.versions.find((entry) => entry.version === workflow.publishedVersion)?.graph ?? null
}

export async function listWorkflows(): Promise<Workflow[]> {
  return (await workflowStore.load()).workflows
}

export async function getWorkflow(id: string): Promise<Workflow | undefined> {
  return (await workflowStore.load()).workflows.find((entry) => entry.id === id)
}

export async function createWorkflow(fields: {
  name: string
  description: string
  projectId: string | null
  draft: WorkflowGraph
}): Promise<Workflow> {
  const store = await workflowStore.load()
  const now = new Date().toISOString()
  const workflow: Workflow = {
    id: crypto.randomUUID(),
    name: fields.name,
    description: fields.description,
    enabled: true,
    projectId: fields.projectId,
    draft: fields.draft,
    publishedVersion: null,
    versions: [],
    createdAt: now,
    updatedAt: now,
  }
  store.workflows.push(workflow)
  workflowStore.persist()
  publishMachineEvent('workflow.updated', { workflow })
  return workflow
}

/** Merge a partial into a workflow and stamp `updatedAt` — the one mutation path
 *  every route funnels through, so persistence and the `workflow.updated` push
 *  never drift from a field change. `draft` replaces wholesale (the builder
 *  always submits the full graph). */
export async function updateWorkflow(
  id: string,
  patch: Partial<Pick<Workflow, 'name' | 'description' | 'enabled' | 'projectId' | 'draft'>>,
): Promise<Workflow | undefined> {
  const store = await workflowStore.load()
  const workflow = store.workflows.find((entry) => entry.id === id)
  if (!workflow) return undefined
  Object.assign(workflow, patch, { updatedAt: new Date().toISOString() })
  workflowStore.persist()
  publishMachineEvent('workflow.updated', { workflow })
  return workflow
}

/** Snapshot the draft as the next immutable version and make it the one triggers
 *  fire. The draft is left exactly as it is — publishing is a checkpoint, not a
 *  handoff, so editing can continue straight afterwards. */
export async function publishWorkflow(id: string, note: string | null): Promise<Workflow | undefined> {
  const store = await workflowStore.load()
  const workflow = store.workflows.find((entry) => entry.id === id)
  if (!workflow) return undefined

  const version = (workflow.versions[0]?.version ?? 0) + 1
  workflow.versions.unshift({
    version,
    /**
     *
     * Deep-copied so a later draft edit cannot reach back and mutate a published
     * graph through a shared reference — the whole guarantee of a version.
     *
     **/
    graph: structuredClone(workflow.draft),
    publishedAt: new Date().toISOString(),
    note,
  })
  workflow.versions = workflow.versions.slice(0, MAX_VERSIONS)
  workflow.publishedVersion = version
  workflow.updatedAt = new Date().toISOString()

  workflowStore.persist()
  publishMachineEvent('workflow.updated', { workflow })
  return workflow
}

/** Copy an old version's graph back onto the draft. Deliberately does NOT change
 *  what triggers run: a rollback lands in the builder where it can be looked at,
 *  and goes live through the same Publish everything else does. */
export async function restoreWorkflowVersion(id: string, version: number): Promise<Workflow | undefined> {
  const store = await workflowStore.load()
  const workflow = store.workflows.find((entry) => entry.id === id)
  if (!workflow) return undefined

  const snapshot = workflow.versions.find((entry) => entry.version === version)
  if (!snapshot) apiError(404, 'workflow.versionNotFound', `This workflow has no version ${version}.`)

  workflow.draft = structuredClone(snapshot.graph)
  workflow.updatedAt = new Date().toISOString()
  workflowStore.persist()
  publishMachineEvent('workflow.updated', { workflow })
  return workflow
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const store = await workflowStore.load()
  const before = store.workflows.length
  store.workflows = store.workflows.filter((entry) => entry.id !== id)
  if (store.workflows.length === before) return false
  workflowStore.persist()
  publishMachineEvent('workflow.removed', { id })
  return true
}

/**
 *
 * Validation is per-field (not one all-or-nothing payload check) so the patch
 * route can validate exactly the fields a partial update carries. The graph's
 * own rules live in utils/workflow-graph.ts.
 *
 **/

export function validateWorkflowName(nameRaw: unknown): string {
  if (typeof nameRaw !== 'string' || !nameRaw.trim() || nameRaw.trim().length > MAX_NAME) {
    apiError(400, 'workflow.nameLength', `Enter a name (1–${MAX_NAME} characters).`, { max: MAX_NAME })
  }
  return nameRaw.trim()
}

export function validateWorkflowDescription(descriptionRaw: unknown): string {
  const description = descriptionRaw == null ? '' : descriptionRaw
  if (typeof description !== 'string' || description.trim().length > MAX_DESCRIPTION) {
    apiError(400, 'workflow.descriptionLength', `The description must be at most ${MAX_DESCRIPTION} characters.`, {
      max: MAX_DESCRIPTION,
    })
  }
  return description.trim()
}

export function validateWorkflowDraft(draftRaw: unknown): WorkflowGraph {
  return validateWorkflowGraph(draftRaw)
}

export function validateVersionNote(noteRaw: unknown): string | null {
  if (noteRaw == null) return null
  if (typeof noteRaw !== 'string' || noteRaw.trim().length > MAX_NAME) {
    apiError(400, 'workflow.versionNoteLength', `A version note must be at most ${MAX_NAME} characters.`, {
      max: MAX_NAME,
    })
  }
  return noteRaw.trim() || null
}
