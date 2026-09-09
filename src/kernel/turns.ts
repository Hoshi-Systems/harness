import { randomUUID } from 'node:crypto'
import { Agent, Session as HarnessSession, type CompactionCheckInfo, type TokenUsage } from '@openharness/core'
import { publishMachineEvent } from './events.js'
import { archetypeAsAgent } from './archetypes.js'
import { resolveAgent, SKILLS_DIR } from './catalogue.js'
import { projectSkillRoots } from './project-assets.js'
import { overflowing, tailPreservingCompaction } from './compaction.js'
import { flushPendingContext, historyStore, imagelessHistory } from './history.js'
import { subagentSessions, withParentSession } from './subagent-sessions.js'
import { appendMessage, updateMessage, type Message } from './messages.js'
import { turnParts } from './turn-parts.js'
import { describeFailure } from './turns/failure.js'
import { runTurnFinalization } from './turns/finalize.js'
import { flushLive, maybeFlush } from './turns/live-flush.js'
import { editedFile, settleTool, toolMetadata, turnCost } from './turns/tool-results.js'
import { refuseTurn, TURN_REFUSAL_MESSAGE } from './turns/admission.js'
import { isTurnRunning, liveTurn, registerTurn, unregisterTurn } from './turns/live.js'
import type { LiveTurn, Subscriber } from './turns/types.js'
import { buildModel, ModelUnavailableError, resolveModelRef } from './model.js'
import { cancelAsksFor } from './permissions.js'
import { ports } from './host-ports.js'
import { clearSessionStep, getSession, setSessionProgress, setSessionState, touchSession } from './sessions.js'
import { archetypeCatalog } from './subagents.js'
import type { ModelMessage } from 'ai'
import { buildUserMessage, type OutgoingFile } from './attachments.js'
import { describeToolOutput } from './tool-output.js'
import { agentForSession, buildApprover, buildTools } from './tools.js'
import { recordTurnSpend } from './spend.js'
import { machineInstructions, projectInstructions, systemPrompt } from './instructions.js'
import { getPreferences } from './preferences.js'
import type { ReasoningEffort } from './reasoning.js'

/**
 * ── Running a turn ───────────────────────────────────────────────────────────
 *
 * The agent loop: @openharness/core's Agent + Session driving one turn. The
 * library is confined to engine/ — this file, tools.ts, subagents.ts, mcp.ts —
 * and everything above it, routes and clients, sees sessions and messages,
 * never an agent library (docs/HARNESS_MIGRATION.md).
 *
 * A turn is FIRE-AND-FORGET by design. `POST /sessions/:id/messages` accepts and
 * returns; the answer arrives on the stream. A request that blocked until the
 * model finished could not show a token as it arrived and would tie the turn's
 * life to one HTTP connection — close the laptop and the work dies. Everything
 * here follows from that: live turns are tracked in a registry so a
 * reconnecting client can rejoin one, and aborting is a separate call rather
 * than dropping a socket.
 *
 * It is LONG, and the length is the loop. Four hundred of these lines are one
 * function — `run` — and a function is not a directory: cutting it into files
 * would move the same control flow behind imports and make it harder to read,
 * not easier. What CAN leave has left, and did: the failure prose, the live
 * flush, the tool-result shaping and the compaction check are all leaves next
 * door (docs/STRUCTURE_REVIEW.md H-02). The same argument, measured the same
 * way, keeps `plugins/workflows/workflow-runs.ts` in one piece — see the header
 * of its `workflow-run-support.ts`.
 *
 **/

/** The registry itself is `./turns/live.ts` — see its header for why it is not
 *  in this file. Re-exported here because it is kernel API and every caller
 *  reaches it through the kernel barrel. */
export { anyTurnRunning, isTurnRunning } from './turns/live.js'

/** Attach to a running turn: the text so far, then every later chunk. Null when
 *  nothing is running — the caller answers 204, which is how a reconnecting
 *  client tells "no turn" from "a turn I cannot see". */
export function attachToTurn(sessionId: string, subscriber: Subscriber): { replay: string; detach: () => void } | null {
  const turn = liveTurn(sessionId)
  if (!turn || turn.done) return null
  turn.subscribers.add(subscriber)
  return { replay: turn.text, detach: () => turn.subscribers.delete(subscriber) }
}

export function abortTurn(sessionId: string): boolean {
  const turn = liveTurn(sessionId)
  if (!turn) return false
  turn.controller.abort()
  /**
   *
   * Releasing the asks is part of aborting, not cleanup afterwards. A turn
   * suspended inside `approve` is parked on a promise that only an answer
   * resolves — the abort signal alone never reaches it, the loop never unwinds,
   * the `finally` below never runs, and the session stays busy forever. Stopping
   * a turn that is waiting on a person is the ordinary case, so this deadlock is
   * reachable by pressing Stop on a permission card.
   *
   **/
  cancelAsksFor(sessionId)
  return true
}

export class TurnBusyError extends Error {}

/**
 *
 * A spend ceiling the machine must not exceed, raised BEFORE the turn starts.
 *
 * Enforcement lived in the retired proxy's turn gate, and the move into this
 * package left it nowhere: the org-spend plugin still computed the verdict,
 * still answered `spendBlocked`, still pushed a `usage.budget` event a client
 * rendered as blocked — and every turn started anyway. Two peripheral callers
 * (delegation intake, the CI loop) asked; the turn path did not
 * (docs/STRUCTURE_REVIEW.md H-10).
 *
 * Raised HERE rather than in the route, so it covers every way a turn begins —
 * a person typing, a goal continuing, a workflow step, a dispatched task —
 * instead of only the one the proxy happened to sit in front of.
 *
 * The wording is deliberately neutral about WHOSE limit and HOW MUCH: the
 * machine's own budget state rides on the event stream, and a client that
 * renders "blocked" already has the number.
 *
 **/
export class SpendBlockedError extends Error {}

/** Compact a session's memory NOW, on the machine's default model.
 *
 *  The engine already compacts on its own when a conversation approaches the
 *  model's window (see `overflowing`); this is the user asking early — "fold
 *  the past away, I want a fresh run-up". `compacted: false` is a real answer:
 *  a short conversation has nothing worth summarizing, and pretending
 *  otherwise would charge a model call for a no-op. */
/** Re-exported from their own modules: every caller — the routes, the tests —
 *  asks turns.js for these, and the module boundary is an internal concern. */
export { describeFailure } from './turns/failure.js'
export type { LiveTurn, Subscriber } from './turns/types.js'

export async function compactSession(
  sessionId: string,
): Promise<{ compacted: boolean; tokensBefore?: number; tokensAfter?: number }> {
  if (isTurnRunning(sessionId)) throw new TurnBusyError('This session is generating — let the turn finish first.')
  const ref = await resolveModelRef()
  if (!ref) throw new ModelUnavailableError('needs-key', 'This machine has no usable model yet.')
  const { model, contextLimit } = await buildModel(ref)

  const harness = new HarnessSession({
    agent: new Agent({ name: 'compact', model, instructions: false }),
    sessionId,
    sessionStore: historyStore,
    compactionStrategy: tailPreservingCompaction(),
    ...(contextLimit > 0 ? { contextWindow: contextLimit } : {}),
  })
  await harness.load()

  let tokensBefore: number | undefined
  let tokensAfter: number | undefined
  for await (const event of harness.compact()) {
    if (event.type === 'compaction.done') {
      tokensBefore = event.tokensBefore
      tokensAfter = event.tokensAfter
    }
  }
  await harness.save()

  const compacted = tokensBefore !== undefined && tokensAfter !== undefined && tokensAfter < tokensBefore
  if (compacted) publishMachineEvent('session.compacted', { sessionId, tokensBefore, tokensAfter })
  return { compacted, tokensBefore, tokensAfter }
}

export interface SendOptions {
  text: string
  /** What the transcript shows in place of `text`, when the two differ.
   *
   *  They differ for exactly one caller today: a command. `/review` is what the
   *  person typed and what they should see; the template it expands to is for
   *  the model. Storing the expansion made the thread rewrite itself on reload —
   *  the invocation while the turn ran, forty lines of instructions after — and
   *  neither the machine nor the client was wrong on its own, they simply
   *  disagreed about whose text it was.
   *
   *  Nothing is lost by showing the shorter one: the expansion is what went into
   *  the model's conversation, which is stored, and which is what rewind and
   *  fork cut at. */
  display?: string
  /** Files attached to this message, as data URLs. They travel with the turn
   *  into the model's own input (engine/attachments.ts) and stay in the
   *  transcript beside the question. */
  files?: OutgoingFile[]
  /** `provider/model` this send explicitly asks for. The top of the chain: a
   *  person picking a model in the composer is answering about this message. */
  model?: string
  /** What the session that STARTED this one is running on — an engagement's
   *  manager handing its model down to its steps, which is what "inherit" has
   *  always meant there.
   *
   *  Below the agent's own declared model on purpose. An archetype that says it
   *  needs the heavy tier is making a claim about the work; the manager's model
   *  is only where the answer comes from when nothing else has one. Passing it
   *  as `model` instead would make the same archetype run on a different model
   *  depending on whether it was reached through `task` or through `team_plan`,
   *  which is the kind of difference nobody can see and everybody pays for. */
  parentModel?: string
  /** The agent to run as. Falls back to the machine's configured default, then
   *  to `build` — a name that no longer resolves is not worth refusing a turn
   *  over (engine/catalogue.ts `resolveAgent`). */
  agent?: string
  /** How hard the model should think on this turn (engine/reasoning.ts). Falls
   *  back to the machine's preference, and then to the provider's own default —
   *  a choice made per SEND, like the model, because the answer changes with
   *  the question rather than with the machine. */
  effort?: ReasoningEffort
  /** Run this turn as a SPECIALIST rather than as an agent: the archetype's own
   *  prompt and, when it is read-only, its narrowed tool set. Set only by
   *  kernel/engagements.ts, whose steps are sessions of their own — routing
   *  them through this path rather than giving them a private one is what keeps
   *  a specialist's turn identical to every other turn in history, events,
   *  approvals, abort and compaction. Takes precedence over `agent`; an
   *  archetype that no longer exists falls back to the agent path rather than
   *  refusing the turn, exactly as a missing agent name already does. */
  archetype?: string
}

/** Accept a message and start generating. Returns as soon as the turn is
 *  RUNNING — never when it finishes. */
export async function sendMessage(sessionId: string, options: SendOptions): Promise<{ messageId: string }> {
  const session = await getSession(sessionId)
  if (!session) throw new Error('no such session')

  const refusal = refuseTurn({
    running: isTurnRunning(sessionId),
    spendBlocked: ports().spendBlocked?.() ?? false,
  })
  if (refusal === 'busy') throw new TurnBusyError(TURN_REFUSAL_MESSAGE[refusal])
  if (refusal === 'spend-blocked') throw new SpendBlockedError(TURN_REFUSAL_MESSAGE[refusal])

  /**
   *
   * The catalogue is read HERE, as the turn starts — never cached at boot, which
   * is what makes editing an agent safe while the machine works. It is read
   * before the model is built rather than inside `run` because the definition
   * NAMES a model: an agent (or an archetype's tier) that asks for a particular
   * one is answering the question `buildModel` is about to be asked.
   *
   * It used to be read after, and the answer thrown away. `Agent.model` was
   * documented as "`provider/model`, or null to use the machine's default",
   * parsed from the agent's frontmatter, patchable over the API, rendered in
   * Customize — and read by nothing. Every agent ran on whatever the send
   * happened to carry.
   *
   **/
  const definition =
    (options.archetype ? await archetypeAsAgent(options.archetype) : null) ??
    (await resolveAgent(options.agent, session.directory))
  /**
   *
   * Precedence, and the reason for it: what this SEND asked for wins, because a
   * person picking a model in the composer is answering about this message. The
   * agent's own choice is next — it is a standing preference, not an override
   * of the person in front of it. Then the machine's default, then whatever
   * exists (kernel/model.ts `resolveModelRef`).
   *
   **/
  const ref = await resolveModelRef(options.model ?? definition.model ?? options.parentModel)
  if (!ref) throw new ModelUnavailableError('needs-key', 'This machine has no usable model yet.')
  /**
   *
   * The machine's preference is the fallback, not the floor: a person who picks
   * an effort for one question is answering about that question.
   *
   **/
  const effort = options.effort ?? (await getPreferences()).reasoningEffort
  const built = await buildModel(ref, { effort })

  /**
   *
   * The user's message is committed BEFORE the model is called. If generation
   * fails, what they typed must still be there — losing it is the one failure
   * users never forgive. `historyAt` rides along: it is the exact point in the
   * model's memory this turn began at, and the anchor rewind and fork cut at.
   *
   **/
  const historyAt = ((await historyStore.load(sessionId)) ?? []).length
  const files = options.files ?? []
  /**
   *
   * Built BEFORE the message is committed: an attachment too large to carry is
   * a refusal, and refusing after the message is in the transcript would leave
   * a question in the history that no turn ever answered.
   *
   **/
  /**
   *
   * Said out loud, because the alternative is a mystery: when an image is
   * withheld the model announces it cannot see, and from the outside that is
   * indistinguishable from a model that simply says so on its own. One line
   * names the model and what the catalogue claimed about it, so the next report
   * of "it says it is blind" is answerable in one look at the log.
   *
   **/
  if (files.some((file) => (file.mime || '').startsWith('image/')) && !built.acceptsImages) {
    console.warn(
      `[harness] withholding ${files.length} image attachment(s) from ${built.modelRef}: ` +
        'its catalogue entry lists input modalities without "image". If it can in fact see, ' +
        "the entry is wrong — clear the model's modalities to let images through.",
    )
  }
  const input = buildUserMessage(options.text, files, {
    acceptsImages: built.acceptsImages,
    contextLimit: built.contextLimit,
  })
  await appendMessage(sessionId, {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    role: 'user',
    parts: [
      ...files.map((file) => ({
        type: 'file' as const,
        filename: file.filename,
        mime: file.mime,
        url: file.url,
      })),
      /**
       *
       * Only when there are words. A message that is just a picture renders as
       * the picture; an empty text part under it is a blank bubble the person
       * did not write.
       *
       **/
      ...(options.display || options.text ? [{ type: 'text' as const, text: options.display || options.text }] : []),
    ],
    createdAt: new Date().toISOString(),
    historyAt,
  })

  const messageId = `msg_${randomUUID().replace(/-/g, '')}`
  await appendMessage(sessionId, {
    id: messageId,
    role: 'assistant',
    parts: [{ type: 'text', text: '' }],
    createdAt: new Date().toISOString(),
  })

  const turn: LiveTurn = {
    sessionId,
    messageId,
    controller: new AbortController(),
    text: '',
    reasoning: '',
    flushing: false,
    flushedAt: performance.now(),
    tools: [],
    subscribers: new Set(),
    done: false,
  }
  registerTurn(sessionId, turn)
  /**
   *
   * Before the turn, not after: a session you are talking to right now should
   * sort to the top of the list while the answer is still coming.
   *
   **/
  await touchSession(sessionId)
  setSessionState(sessionId, 'busy')

  /**
   *
   * The WHOLE turn runs inside the parent context, not just the call that starts
   * the stream. `harness.send()` returns an async generator whose body does not
   * execute until it is iterated — so a context set only around that call is
   * already gone by the time a delegated child saves anything, and every child
   * came out with no parent. The turn is the honest scope: anything it spawns,
   * at any depth, belongs to it.
   *
   **/
  void withParentSession({ sessionId, directory: session.directory }, () =>
    run(turn, built, input, session.directory, definition, effort),
  ).catch((error) => console.error(`[engine] turn escaped finalization on ${sessionId}:`, error))
  return { messageId }
}

/** The tools whose input IS a plan. `@openharness/core` ships them; the machine
 *  never defines them, so they are matched by name rather than by registry. */
const PLAN_TOOLS = new Set(['todowrite', 'todoread'])

/** The newest plan's progress from a plan-tool call, or `undefined` when the
 *  call is not one — `undefined` leaves the stored plan alone, where `null`
 *  would clear it.
 *
 *  A plan every item of which is finished reports `null`: a completed plan has
 *  stopped meaning anything, and "7/7" on a row forever is worse than nothing. */
export function planFrom(tool: string, input: unknown): { done: number; total: number } | null | undefined {
  if (!PLAN_TOOLS.has(tool.toLowerCase())) return undefined
  const todos = (input as { todos?: unknown })?.todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const done = todos.filter((item) => {
    const status = (item as { status?: unknown })?.status
    return status === 'completed' || status === 'cancelled'
  }).length
  return done === todos.length ? null : { done, total: todos.length }
}

/**
 *
 * The call in flight, as the two facts a client needs: which tool, and the one
 * argument that says which THING it is about.
 *
 * Not a sentence. This used to return `${tool} · ${detail}` and a sidebar row
 * printed it verbatim, so every client showed `edit ·
 * apps/app/app/composables/useMachineUrl.ts` where the design asks for "Editing
 * useMachineUrl.ts". The machine cannot write that line: it has no locale, and
 * four clients read this field. It reports WHAT; each of them says it.
 *
 * The subject stays whole — a client shortens it to fit its own surface, and a
 * path truncated here could not be un-truncated there.
 *
 **/
export function describeStep(
  tool: string,
  input: unknown,
): { tool: string; subject: string | null; field: string | null } {
  const args = (input ?? {}) as Record<string, unknown>
  /**
   *
   * The FIELD travels with the value, because the client's phrasing is keyed on
   * it: "Reading notes.md" and "Searching for notes.md" come from the same
   * string under a different name. Ordered most-specific first, and matching
   * the fields the clients' own tool vocabulary reads
   * (`packages/core/app/composables/useToolView.ts`) — a name here that nothing
   * reads there is a step that renders as the generic phrase.
   *
   **/
  for (const field of [
    'name',
    'agent',
    'filePath',
    'path',
    'pattern',
    'command',
    'url',
    'query',
    'prompt',
    'message',
    'selector',
    'text',
    'description',
    'title',
  ]) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) return { tool, subject: value, field }
  }
  return { tool, subject: null, field: null }
}

async function run(
  turn: LiveTurn,
  built: Awaited<ReturnType<typeof buildModel>>,
  input: string | ModelMessage[],
  directory: string,
  /** Resolved by `sendMessage`, which needed it to decide the model. Passed in
   *  rather than resolved again so the turn cannot run one agent's prompt on
   *  another agent's model — a catalogue edit landing between the two reads is
   *  rare, and silent. */
  requested: Awaited<ReturnType<typeof resolveAgent>>,
  /** What this turn asked the model for, so a specialist built on a DIFFERENT
   *  model is asked for the same. */
  effort: ReasoningEffort,
): Promise<void> {
  const { model, modelRef, contextLimit, pricing } = built
  let failure: { name: string; message: string } | null = null
  let usage: TokenUsage | null = null
  let finishReason: string | null = null
  /**
   *
   * How long the MODEL itself was working, summed across the turn's steps.
   *
   * Not the turn's wall clock, which is what a client can already measure and
   * what makes the number useless: a turn that ran thirteen tools spends most
   * of its life waiting on a shell, and dividing tokens by that reports a model
   * ten times slower than it is. A step is exactly the span between asking the
   * model and it answering, so the sum is the generation time and nothing else.
   *
   **/
  let modelMs = 0
  let stepStartedAt: number | null = null
  /** How many times the provider had to be asked again. The library retries
   *  transient failures itself and the machine already reacts to that (the
   *  session shows "retrying"), but nothing kept the count — so "the answer
   *  arrived on the third attempt" was invisible the moment the turn ended. */
  let retries = 0
  /** Set when the model's memory was folded mid-turn. The user is told at the
   *  time ("Compacting…") and then the record forgets: reopening the session
   *  shows a conversation that quietly lost detail, with nothing saying why. */
  let compacted: { tokensBefore: number; tokensAfter: number } | null = null
  const inputs = new Map<string, unknown>()
  try {
    /**
     *
     * The session gets its say: a chat runs read-only whatever agent was asked
     * for, which withholds both the mutating tools and the `task` tool that
     * would let a chat launder a change through a child. See `agentForSession`.
     *
     **/
    const definition = agentForSession(requested, await getSession(turn.sessionId))
    /**
     *
     * The machine's standing instructions ride in front of the agent's own
     * brief — see kernel/instructions.ts for why this is read per turn.
     *
     **/
    /**
     *
     * The project's own AGENTS.md / CLAUDE.md rides along — every other harness
     * reads them, so a repo that has one has already said how it wants to be
     * worked on (engine/instructions.ts).
     *
     **/
    const system = systemPrompt(await machineInstructions(), await projectInstructions(directory), definition.prompt)
    const agent = new Agent({
      name: definition.name,
      ...(system ? { systemPrompt: system } : {}),
      model,
      /**
       *
       * The definition itself, not just its name: an agent can switch tools off
       * and tighten permissions, and both are read from it here (engine/tools.ts).
       *
       **/
      tools: await buildTools(turn.sessionId, directory, definition, modelRef),
      approve: buildApprover(turn.sessionId, directory, definition),
      /**
       *
       * Specialists this machine knows about (engine/archetypes.ts). Handing
       * them over grows the `task` tool; the library runs the child loop.
       *
       * Withheld entirely from a read-only agent, because `task` is the library's
       * own tool rather than one of ours: filtering our set cannot remove it, and
       * an agent that changes nothing but can ask a subagent to change something
       * has not been stopped from changing anything.
       *
       **/
      ...(definition.readOnly
        ? {}
        : {
            subagents: archetypeCatalog({
              model,
              /**
               *
               * What the parent is running on, so a specialist that inherits
               * can be given exactly it, and one whose archetype declares a
               * tier can be told apart from one that does not.
               *
               **/
              modelRef,
              effort,
              sessionId: turn.sessionId,
              directory,
            }),
            /**
             *
             * A delegated specialist gets its own SESSION, not just its own
             * conversation in memory. Without this the library ran the child
             * entirely in RAM and the work vanished when the turn ended — the
             * only account left was the summary the specialist wrote about
             * itself. `new` rather than `stateless` for the same reason: a
             * stateless child has nothing to keep.
             *
             * ONE object for the whole machine, deliberately — see
             * kernel/subagent-sessions.ts. The library keys a subagent's
             * session bookkeeping off this object's IDENTITY, so a fresh
             * literal per turn gave every turn a fresh, empty one.
             *
             **/
            subagentSessions,
          }),
      /**
       *
       * Skills installed on this machine (engine/catalogue.ts writes them, one
       * SKILL.md per folder — the layout discoverSkills already expects). The
       * library turns them into a `skill` tool the model loads on demand.
       * Without this they were prose sitting on disk that nothing ever read.
       *
       **/
      /**
       *
       * The machine's skills AND the checkout's own (`.claude/skills` and
       * friends). Listing a project skill on a screen while withholding it from
       * the turn would be the worst of both: visible, described, and impossible
       * to actually use.
       *
       **/
      skills: { paths: [SKILLS_DIR(), ...(await projectSkillRoots(directory))] },
      instructions: false,
    })
    const harness = new HarnessSession({
      agent,
      /**
       *
       * The library owns the model's conversation and persists it itself
       * (engine/history.ts). Keyed on OUR session id so the two line up.
       *
       **/
      sessionId: turn.sessionId,
      /**
       *
       * A session that already holds a picture is a session a text-only model
       * cannot answer AT ALL — the rejection is of the whole request, not of the
       * one message, so it repeats on every turn from then on. Switching to such
       * a model reads the history without the images rather than leaving the
       * conversation permanently unusable. What the USER sees is untouched: the
       * transcript is its own store, and the picture is still in it.
       *
       **/
      sessionStore: built.acceptsImages ? historyStore : imagelessHistory,
      /**
       *
       * What makes auto-compaction run at all: with no context window the
       * library has no idea when the conversation is about to overflow, and a
       * long session simply dies at the provider's limit.
       *
       **/
      ...(contextLimit > 0 ? { contextWindow: contextLimit, shouldCompact: overflowing } : {}),
      compactionStrategy: tailPreservingCompaction(),
    })
    await harness.load()

    /**
     *
     * Who any child spawned during this turn belongs to. The library's store
     * interface is given only a session id — it has no channel to say who
     * spawned the child — so the parent is set for the duration of the stream
     * and read at the moment a delegated session first saves.
     *
     **/
    for await (const event of harness.send(input, { signal: turn.controller.signal })) {
      if (event.type === 'reasoning.delta') {
        /**
         *
         * The model thinking out loud. Its own event and its own transcript
         * part, never mixed into the answer — a reader folds reasoning away,
         * and a client that cannot tell them apart cannot offer that.
         *
         **/
        turn.reasoning += event.text
        publishMachineEvent('message.reasoning.delta', {
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          text: event.text,
        })
        maybeFlush(turn)
      } else if (event.type === 'text.delta') {
        turn.text += event.text
        for (const subscriber of turn.subscribers) subscriber.onChunk(event.text)
        publishMachineEvent('message.delta', { sessionId: turn.sessionId, messageId: turn.messageId, text: event.text })
        maybeFlush(turn)
      } else if (event.type === 'tool.start') {
        /**
         *
         * The audit trail is built from these. A turn that runs tools without
         * announcing them leaves the trail silently empty — which reads exactly
         * like an agent that did nothing.
         *
         **/
        publishMachineEvent('tool.started', {
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          input: event.input,
        })
        turn.tools.push({
          callId: event.toolCallId,
          name: event.toolName,
          status: 'running',
          input: event.input,
          startedAt: performance.now(),
          textAt: turn.text.length,
        })
        /**
         *
         * What a sidebar row says a task is doing. Published from here because
         * this is the only place that knows: the alternative is a client
         * loading a session's whole transcript to find out, which a list of
         * forty tasks is never going to do.
         *
         **/
        setSessionProgress(turn.sessionId, directory, {
          step: describeStep(event.toolName, event.input),
          ...(planFrom(event.toolName, event.input) !== undefined
            ? { plan: planFrom(event.toolName, event.input) }
            : {}),
        })
        /**
         *
         * Written now, not at the next opportunity. An interactive plugin may
         * stop the turn until a person answers, and until this flush existed
         * nothing about it reached the transcript — no text was streaming to
         * trigger a flush and no completion was coming. A tab reloaded while
         * the prompt was up found a turn with nothing in it, which is the same
         * disappearing act a half-written answer used to do, one layer down.
         *
         **/
        void flushLive(turn)
        /**
         *
         * Remembered so the completion carries it too: the audit trail records
         * WHAT ran, and "bash" without its command tells an auditor nothing.
         *
         **/
        inputs.set(event.toolCallId, event.input)
      } else if (event.type === 'tool.done') {
        /**
         *
         * What the call PRODUCED, not merely that it ended. A card that can
         * only say "bash finished" is the shell equivalent of hiding the
         * terminal: the whole reason anybody expands a tool call is to read
         * what came back. The harness hands it over here and nowhere else —
         * it is not recoverable afterwards.
         *
         **/
        const output = describeToolOutput(event.output)
        const metadata = toolMetadata(event.output)
        settleTool(turn, event.toolCallId, 'completed', {
          ...(output ? { output } : {}),
          ...(metadata ? { metadata } : {}),
        })
        /**
         *
         * Written at once, not on the throttle: a finished tool call is the
         * expensive part of a turn — minutes of a build, a command that changed
         * the filesystem — and losing the record of it to a refresh is losing
         * the only account of what the machine did.
         *
         **/
        void flushLive(turn)
        publishMachineEvent('tool.completed', {
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          status: 'ok',
          input: inputs.get(event.toolCallId),
          ...(output ? { output } : {}),
          /**
           *
           * The result's own metadata rides along. An interactive plugin can
           * report an outcome there; a client that rebuilt the tool part from
           * an event without it would show an already-answered prompt as still
           * pending until a reload, even though the transcript had the answer.
           *
           **/
          ...(metadata ? { metadata } : {}),
        })
        /**
         *
         * A write that succeeded is a fact about the FILESYSTEM, not just the
         * turn — the file panel follows the agent with it, and a viewer with
         * that file open reloads instead of showing a stale copy.
         *
         **/
        const editedPath = editedFile(event.toolName, inputs.get(event.toolCallId))
        if (editedPath) {
          publishMachineEvent('file.edited', { sessionId: turn.sessionId, path: editedPath })
        }
      } else if (event.type === 'tool.error') {
        settleTool(turn, event.toolCallId, 'error', { error: event.error })
        publishMachineEvent('tool.completed', {
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          status: 'error',
          error: event.error,
          input: inputs.get(event.toolCallId),
        })
      } else if (event.type === 'error') {
        failure = describeFailure(event.error)
      } else if (event.type === 'step.done') {
        if (stepStartedAt !== null) {
          modelMs += performance.now() - stepStartedAt
          stepStartedAt = null
        }
        /**
         *
         * WHY the model stopped, kept from the last step because that is the one
         * that ended the turn. Without it, a turn cut off at the output cap and a
         * turn that genuinely finished look identical — same tokens, same tools,
         * an answer that just happens to stop mid-sentence, and nothing anywhere
         * saying which happened.
         *
         **/
        finishReason = event.finishReason
      } else if (event.type === 'turn.done') {
        /**
         *
         * What the turn cost. A goal's token budget is a safety limit, and a
         * safety limit reading a number nobody writes is not a limit.
         *
         **/
        usage = event.usage
      } else if (event.type === 'retry') {
        /**
         *
         * The library retries transient provider failures on its own; saying so
         * is what turns a session that looks frozen into one that is visibly
         * waiting. This is the only thing that ever sets 'retrying'.
         *
         **/
        retries += 1
        setSessionState(turn.sessionId, 'retrying')
      } else if (event.type === 'step.start') {
        /**
         *
         * A step starting means the retry above landed — back to plain busy.
         *
         * It also opens the model's own clock. There is deliberately only ONE
         * branch for this event: a second one added beside it would shadow this
         * whole body, and a session stuck showing "retrying" for the rest of the
         * turn is a quiet regression nothing else here would catch.
         *
         **/
        setSessionState(turn.sessionId, 'busy')
        stepStartedAt = performance.now()
      } else if (event.type === 'compaction.done') {
        compacted = { tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter }
        /**
         *
         * The conversation outgrew the model's window and was summarized down.
         * Announced because it is the honest explanation for an agent that
         * suddenly remembers a session in less detail than it did a turn ago.
         *
         **/
        publishMachineEvent('session.compacted', {
          sessionId: turn.sessionId,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
        })
      }
    }
  } catch (error) {
    /**
     *
     * An abort is a normal outcome, not a failure: the user asked for it, and
     * what streamed before it stays in the history.
     *
     **/
    const aborted = turn.controller.signal.aborted
    if (!aborted) {
      failure = describeFailure(error)
      console.error(`[engine] turn failed on ${turn.sessionId}:`, error)
    }
  } finally {
    turn.done = true
    const cost = turnCost(usage, pricing)
    const persistenceErrors = await runTurnFinalization([
      {
        name: 'transcript persistence',
        run: () =>
          updateMessage(turn.sessionId, turn.messageId, {
            parts: turnParts(turn),
            completedAt: new Date().toISOString(),
            error: failure,
            usage,
            cost,
            model: modelRef,
            finishReason,
            modelMs: Math.round(modelMs) || null,
            retries: retries || null,
            compacted,
          }),
      },
      {
        name: 'spend persistence',
        run: () =>
          recordTurnSpend({
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            model: modelRef,
            usage,
            cost,
          }),
      },
      {
        name: 'pending context persistence',
        run: () => flushPendingContext(turn.sessionId),
      },
    ])
    if (!failure && persistenceErrors[0]) failure = describeFailure(persistenceErrors[0])
    /**
     *
     * The step is over; the plan is NOT. A task that stopped halfway through a
     * seven-item plan is still halfway through it, and a row that forgot as
     * soon as the turn settled would only ever say so while nobody needed
     * telling. The plan clears when its own last item completes, in `planFrom`.
     *
     **/
    await runTurnFinalization([
      {
        name: 'pending permission cleanup',
        run: () => cancelAsksFor(turn.sessionId),
      },
      {
        name: 'session progress cleanup',
        run: () => clearSessionStep(turn.sessionId, directory),
      },
      {
        name: 'live turn release',
        run: () => {
          unregisterTurn(turn.sessionId)
          setSessionState(turn.sessionId, 'idle')
        },
      },
      {
        name: 'stream completion',
        run: () => {
          for (const subscriber of turn.subscribers) {
            try {
              subscriber.onDone()
            } catch (error) {
              console.error(`[engine] turn subscriber failed on ${turn.sessionId}:`, error)
            }
          }
          turn.subscribers.clear()
        },
      },
      {
        name: 'completion event',
        run: () =>
          publishMachineEvent('message.completed', {
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            aborted: turn.controller.signal.aborted,
            error: failure,
            usage,
            cost,
            model: modelRef,
            finishReason,
            modelMs: Math.round(modelMs) || null,
            retries: retries || null,
            compacted,
          }),
      },
    ])
  }
}
