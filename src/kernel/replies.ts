import { readMessages } from './messages.js'

/**
 * ── Reading a session's answer ───────────────────────────────────────────────
 *
 * "What did this session say, and did it fail?" — asked by everything that
 * starts a turn and later has to report what came of it: workflow steps, the
 * agent inbox, delegated work. It is a question about a TRANSCRIPT, so it lives
 * with the transcript rather than in whichever area happened to need it first.
 *
 **/

/** The envelope the runner reads a turn through.
 *
 *  Kept in this shape deliberately. workflow-runs.ts asks three questions of a
 *  turn — which message is it, has it finished, did it fail — in about a dozen
 *  places, and changing the shape would have rewritten 1100 lines of scheduling
 *  logic that has nothing to do with which runtime is underneath. So the engine's
 *  message is mapped INTO the shape those callers already speak. */
export interface OcAssistantMessage {
  info: {
    id: string
    role: 'user' | 'assistant'
    time?: { created?: number; completed?: number }
    error?: { name?: string; data?: { message?: string } }
  }
  parts: Array<{ type: string; text?: string; ignored?: boolean; synthetic?: boolean }>
}

/** The session's newest assistant message (complete or not), or null before the
 *  first reply exists. */
export async function latestAssistantMessage(
  sessionId: string,
  _directory: string | null,
): Promise<OcAssistantMessage | null> {
  const messages = await readMessages(sessionId)
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!last) return null
  return {
    info: {
      id: last.id,
      role: last.role,
      time: {
        created: Date.parse(last.createdAt) || undefined,
        /**
         *
         * Absent while the turn is still streaming — the runner polls on
         * precisely this, and reporting a half-written answer as finished
         * would advance the workflow on a truncated result.
         *
         **/
        completed: last.completedAt ? Date.parse(last.completedAt) || undefined : undefined,
      },
      ...(last.error ? { error: { name: last.error.name, data: { message: last.error.message } } } : {}),
    },
    parts: last.parts.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type })),
  }
}

/** The assistant's actual prose for a turn — skips tool/reasoning parts and
 *  OpenCode's `ignored`/`synthetic` markers, same filter goal-runner.ts and
 *  the client's render path use. Empty for a pure tool-call turn. */
export function replyText(entry: OcAssistantMessage): string {
  return entry.parts
    .filter((p) => p.type === 'text' && !p.ignored && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function turnErrorSummary(error: NonNullable<OcAssistantMessage['info']['error']>): string {
  return error.data?.message?.trim() || error.name || 'The turn ended with an error.'
}
