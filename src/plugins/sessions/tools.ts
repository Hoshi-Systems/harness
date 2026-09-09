import { bindTools, defineHoshiTool, z, type HoshiToolSet } from '../define-tool.js'
import type { PluginToolContext } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import {
  getSession,
  getSpendBySession,
  markAgentTitle,
  releaseTitle,
  renameSession,
  titleOwner,
  type TitleOwner,
} from '../../kernel/index.js'

/**
 * ── The session a turn is running in ─────────────────────────────────────────
 *
 * Two tools, and both are about the SAME session — the one this turn belongs
 * to, taken from the tool context rather than from an argument. That is the
 * whole security model here: an id parameter would make one conversation able
 * to rename another, and there is no case for it. A specialist in a delegated
 * session sees its own session, never its parent's.
 *
 * `session_update` exists because the machine's own titler is the wrong writer
 * for the job. It waits for a turn to settle, clips the last twelve messages,
 * and asks a small model to summarize them — while the agent knew what the task
 * was before it wrote a word. It also cannot run while the machine is
 * generating (kernel/session-titles.ts), so a busy machine is exactly the one
 * whose sessions stay untitled longest. The titler stays as the fallback for a
 * turn that never calls this.
 *
 **/

/** Long enough for a real sentence, short enough for a sidebar. The same cap
 *  routes/sessions.id.patch.ts applies to a person's rename, because a title
 *  that is legal from one writer and not the other is a bug waiting to be
 *  reported as one. */
const MAX_TITLE = 200

/** How `session_info` says who owns the name. Second person for the agent
 *  BECAUSE it is reading its own session: "named by you" is the sentence that
 *  tells it the name is its to change, which is the decision the field is
 *  there to inform. */
const NAMED_BY: Record<TitleOwner, string> = {
  machine: 'the machine',
  agent: 'you',
  user: 'the user',
}

const sessionUpdate = defineHoshiTool({
  description: [
    'Name the session you are working in, so the user can find it later in their session list.',
    'Call it on your first turn in a new session, as soon as you know what the work is,',
    'and again whenever the subject genuinely moves on — not for every small step.',
    "Write what the work IS, in the user's own language: a short noun phrase under about",
    '50 characters ("Billing webhook signature migration"), never a status line and never',
    'a greeting. Pass null to clear the name and hand it back to the machine.',
    'If the user has named this session themselves, it is theirs and this leaves it alone.',
  ].join(' '),
  args: {
    title: z
      .string()
      .nullable()
      .describe('The new title — a short noun phrase saying what this session is about. Null clears it.'),
  },
  async execute({ title }, context) {
    const session = await getSession(context.sessionId)
    if (!session) {
      return { title: 'Session', output: 'This session no longer exists.', metadata: { ok: false } }
    }

    /**
     *
     * The user's name for their own session outranks ours. Said rather than
     * silently ignored: a tool that reports success over a write that did not
     * happen teaches the model that the title it chose is the one on screen.
     *
     **/
    if ((await titleOwner(context.sessionId)) === 'user') {
      return {
        title: 'Session name unchanged',
        output: `The user named this session "${session.title}" themselves, so it is theirs — leave it. Nothing was changed.`,
        metadata: { ok: false, reason: 'named-by-user', title: session.title },
      }
    }

    const cleaned = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) || null : null
    if (cleaned === session.title) {
      return {
        title: 'Session name unchanged',
        output: `This session is already named "${session.title ?? '(untitled)'}".`,
        metadata: { ok: true, title: session.title },
      }
    }

    const updated = await renameSession(context.sessionId, cleaned)
    if (!updated) {
      return { title: 'Session', output: 'This session no longer exists.', metadata: { ok: false } }
    }
    /**
     *
     * Clearing hands the session BACK: asking for no name is asking for the
     * machine's again, exactly as it is when a person clears one.
     *
     **/
    if (cleaned) await markAgentTitle(context.sessionId)
    else await releaseTitle(context.sessionId)

    return {
      title: cleaned ? `Session renamed to "${cleaned}"` : 'Session name cleared',
      output: cleaned
        ? `This session is now called "${cleaned}". The user sees it under that name in their session list.`
        : 'This session is untitled again; the machine will name it from the conversation.',
      metadata: { ok: true, title: cleaned },
    }
  },
})

const sessionInfo = defineHoshiTool({
  description: [
    'Read the session you are working in: its id, its name, the directory its work happens in,',
    'whether it is a chat, whether it was delegated to you by another session, and what it has',
    'cost so far. Use it to report where your work lives, or to check whether this session',
    'already has a name worth keeping. It only ever answers about your own session.',
  ].join(' '),
  args: {},
  async execute(_input, context) {
    const session = await getSession(context.sessionId)
    if (!session) {
      return { title: 'Session', output: 'This session no longer exists.', metadata: { ok: false } }
    }
    /**
     *
     * The same figure `GET /sessions` folds in, from the machine's own ledger —
     * not a sum over the turns this conversation happens to still hold. A turn
     * is charged whether or not anyone was watching it.
     *
     **/
    const spend = (await getSpendBySession())[session.id] ?? { cost: 0, unpricedTurns: 0 }
    const owner = await titleOwner(session.id)

    const lines = [
      `id: ${session.id}`,
      `title: ${session.title ?? '(untitled)'}${session.title ? ` — named by ${NAMED_BY[owner]}` : ''}`,
      `directory: ${session.directory}`,
      `chat: ${session.chat ? 'yes — this session stays a leaf and runs read-only' : 'no'}`,
      `delegated: ${session.parentId ? `yes — spawned by ${session.parentId}` : 'no'}`,
      `created: ${session.createdAt}`,
      /**
       *
       * Unpriced is not free. Saying so here for the same reason every client
       * says it: a bare `$0.00` on a model nobody published a price for reads
       * as "this costs nothing to run".
       *
       **/
      `cost: $${spend.cost.toFixed(4)}${spend.unpricedTurns > 0 ? ` (a floor — ${spend.unpricedTurns} turn(s) ran on a model with no published price)` : ''}`,
    ]
    return {
      title: session.title ?? 'This session',
      output: lines.join('\n'),
      metadata: {
        ok: true,
        id: session.id,
        title: session.title,
        titleOwner: owner,
        directory: session.directory,
        chat: !!session.chat,
        parentId: session.parentId ?? null,
        spend,
      },
    }
  },
})

const factories = {
  session_update: sessionUpdate,
  session_info: sessionInfo,
}

export function sessionTools(context: PluginToolContext): HoshiToolSet {
  return bindTools(factories, machineToolContext(context))
}

export function sessionToolNames(): string[] {
  return Object.keys(factories)
}
