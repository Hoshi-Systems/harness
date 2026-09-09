import type { Message } from './messages.js'

/**
 *
 * The turn's answer so far, in the shape the transcript stores — extracted from
 * turns.ts so the ordering rule is a pure function with its own tests.
 *
 * One function because it is written TWICE: continuously while the turn runs
 * (flushLive), and once more when it ends. The two must agree — a reload
 * mid-turn that showed a different shape from the finished turn would be its
 * own bug.
 *
 **/

/** A tool call as the live turn tracks it. */
export interface LiveToolRecord {
  callId: string
  name: string
  status: string
  input?: unknown
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  startedAt?: number
  ms?: number
  /** How much of the turn's text had streamed when this call STARTED — the
   *  interleaving anchor. Without it the stored turn clustered every tool
   *  above one concatenated text block, so a session that asked several
   *  interactive questions re-rendered at turn end with them stacked on top and
   *  the whole conversation's prose underneath — a dialog flattened into two
   *  piles. The transcript is the durable record of the ORDER things happened
   *  in, and this is the one number that order needs. */
  textAt?: number
}

/**
 * The stored parts of a turn, in the order things actually happened:
 * reasoning first (folded away by a reader), then the turn's text SPLIT at the
 * point each tool call began — prose, the call it led to, the prose that
 * followed it, and so on.
 *
 * A tool with no `textAt` (a record from before the anchor existed) sorts at
 * the current cursor, which degrades to the old tools-then-text shape rather
 * than misplacing anything.
 */
export function turnParts(turn: { reasoning: string; text: string; tools: LiveToolRecord[] }): Message['parts'] {
  const parts: Message['parts'] = []
  if (turn.reasoning) parts.push({ type: 'reasoning', text: turn.reasoning })

  let cursor = 0
  for (const tool of turn.tools) {
    /**
     *
     * Clamped both ways: never before text already attributed to an earlier
     * tool (tools are pushed in start order, so offsets are monotonic anyway),
     * never past the text that exists.
     *
     **/
    const at = Math.min(Math.max(tool.textAt ?? cursor, cursor), turn.text.length)
    if (at > cursor) {
      parts.push({ type: 'text', text: turn.text.slice(cursor, at) })
      cursor = at
    }
    parts.push({
      type: 'tool',
      name: tool.name,
      callId: tool.callId,
      state: {
        status: tool.status,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        ...(tool.output ? { output: tool.output } : {}),
        ...(tool.error ? { error: tool.error } : {}),
        ...(tool.metadata ? { metadata: tool.metadata } : {}),
        ...(tool.ms !== undefined ? { ms: tool.ms } : {}),
      },
    })
  }

  /**
   *
   * The remainder — the prose after the last call. An empty trailing part is
   * kept only when the turn has no tools, preserving the seeded
   * `[{ type: 'text', text: '' }]` shape an untouched turn starts with; after
   * a tool, an empty text part would just be a blank bubble.
   *
   **/
  const rest = turn.text.slice(cursor)
  if (rest || turn.tools.length === 0) parts.push({ type: 'text', text: rest })
  return parts
}
