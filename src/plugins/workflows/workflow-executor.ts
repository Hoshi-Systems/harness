import { ports } from './host.js'
import {
  listCheckoutMeta,
  latestAssistantMessage,
  replyText,
  turnErrorSummary,
  type OcAssistantMessage,
  createSession,
  renameSession,
  resolveSessionDirectory,
  abortTurn,
  sendMessage,
  markManualTitle,
  workspaceRoot,
} from '../../kernel/index.js'
import type { WorkflowAgentNode } from './graph/index.js'

/**
 * ── Workflow node execution helpers ──────────────────────────────────────────
 *
 * The stateless OpenCode side of running a workflow: create the run's session,
 * fire an agent node's prompt, read the reply back, extract structured output. The
 * run state machine itself (queue, transitions, persistence) lives in
 * utils/workflow-runs.ts and calls down into these — same store-vs-mechanics
 * split as utils/task-queue.ts over utils/dispatch.ts, kept dependency-free of
 * the store so the two files can never import-cycle.
 *
 **/

/** Sessions are directory-scoped: every call about a scoped session carries
 *  the same `?directory=` it was created with (the goal-audit convention). */
function dirQuery(directory: string | null): string {
  return directory ? `?directory=${encodeURIComponent(directory)}` : ''
}

/** Where a run's session lives. A project-bound workflow runs inside its
 *  checkout — and only a `ready` one; a missing or still-provisioning checkout
 *  fails the run cleanly rather than silently landing the pipeline in the
 *  wrong directory. No project = the personal workspace root, so the session
 *  shows up in the client's personal scope (unlike dispatched tasks, which
 *  are unscoped — a workflow run must be a first-class, openable thread). */
export async function resolveRunDirectory(projectId: string | null): Promise<string | null> {
  if (!projectId) return workspaceRoot()
  const meta = (await listCheckoutMeta()).find((m) => m.id === projectId && m.status === 'ready')
  return meta?.directory ?? null
}

/** Create the session a run executes in, or — when `parentId` is given — a
 *  fresh-session step's own SUBSESSION of it (same `parentID`-linked shape
 *  `team_recruit` uses for its specialists). Titled `🤖 <name>` either way. A root run session is
 *  pinned manual so the title refresher (utils/session-titles.ts) never
 *  renames a multi-step run's thread, and posted to the Platform's project
 *  view when project-bound; a subsession needs neither — the refresher
 *  already skips any session with a parentID outright, and the client's own
 *  session partitioning (apps/app/app/stores/sessions.ts `withSubSessions`)
 *  walks parentID to fold a subsession into its root's project scope without
 *  a separate Platform registration. It also renders as a nested "sub-session"
 *  chip under the run's main thread (SessionRelationChips.vue) instead of an
 *  unrelated second top-level session in the sidebar. */
export async function createRunSession(
  title: string,
  directory: string | null,
  projectId: string | null,
  parentId?: string,
): Promise<string> {
  const session = await createSession(await resolveSessionDirectory(directory ?? undefined))
  await renameSession(session.id, `🤖 ${title}`)
  if (!parentId) {
    void markManualTitle(session.id)
    if (projectId) void ports().bindSessionToProject?.(projectId, session.id)
  }
  /**
   *
   * A workflow run has nobody watching, same as a dispatched task — register it
   * before the first prompt so the org policy's unattended rules are already in
   * force when the step's first tool call happens (utils/agent-policy.ts).
   *
   **/
  await ports().markUnattended?.(session.id)
  return session.id
}

/** Fire one agent node's rendered prompt into its session — fire-and-forget;
 *  the reply is picked up by the runner's completion poll. */
export async function sendNodePrompt(
  sessionId: string,
  _directory: string | null,
  node: WorkflowAgentNode,
  prompt: string,
): Promise<void> {
  /**
   *
   * A node's stored model is the old runtime's split shape; the engine takes a
   * single `provider/model` reference. Converted here rather than migrating
   * every saved workflow — a published workflow is a user's document, and a
   * format change would invalidate ones they cannot re-publish.
   *
   **/
  const model = node.model ? `${node.model.providerID}/${node.model.modelID}` : undefined
  await sendMessage(sessionId, { text: prompt, ...(model ? { model } : {}) })
}

/** Best-effort abort of a run's in-flight turn (cancel, step timeout). */
export async function abortSession(sessionId: string, _directory: string | null): Promise<void> {
  abortTurn(sessionId)
}

/** What a schema-bearing step appends to its rendered prompt — the contract
 *  `extractJsonOutput` parses against. */
export function schemaInstruction(outputSchema: string): string {
  return [
    '',
    '---',
    'When you are done, end your reply with a fenced ```json code block containing ONLY a single JSON object matching this schema (no commentary inside the block):',
    '```json',
    outputSchema,
    '```',
  ].join('\n')
}

/** The one-shot correction turn after a reply that failed to parse. */
export function retryInstruction(outputSchema: string): string {
  return [
    'Your previous reply did not end with valid JSON matching the required schema.',
    'Reply again with ONLY a fenced ```json code block containing a single JSON object matching this schema:',
    '```json',
    outputSchema,
    '```',
  ].join('\n')
}

/** Pull a step's structured output out of its reply: the last fenced ```json
 *  block that parses, falling back to the first `{...}` substring (the
 *  goal-audit parseVerdict tolerance — models occasionally skip the fence).
 *  Returns undefined when nothing parses. */
export function extractJsonOutput(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i]![1]!)
    if (parsed !== undefined) return parsed
  }
  const brace = text.match(/\{[\s\S]*\}/)
  return brace ? tryParse(brace[0]) : undefined
}

function tryParse(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw.trim())
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
