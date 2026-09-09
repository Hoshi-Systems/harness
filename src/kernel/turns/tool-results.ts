import type { TokenUsage } from '@openharness/core'
import type { LiveTurn } from './types.js'

/**
 * ── What a finished tool call leaves behind ──────────────────────────────────
 *
 * The turn loop next door decides WHEN a tool call is over; these decide what
 * the transcript keeps of it — how long it took, what the client's card reads
 * from, which file it touched, what it cost. Leaves, all four: they take a
 * value and return one, so they sit outside the loop rather than inside its
 * 400 lines.
 *
 **/

export function editedFile(tool: string, input: unknown): string | null {
  if (!['write', 'edit', 'delete'].includes(tool)) return null
  const args = (input ?? {}) as Record<string, unknown>
  const path = args.filePath ?? args.path
  return typeof path === 'string' && path ? path : null
}

/** Dollars for one turn, or null when either half is unknown. Zero is a real
 *  answer — a free model — which is why unknown is not spelled 0. */
export function turnCost(
  usage: TokenUsage | null,
  pricing: { input: number | null; output: number | null },
): number | null {
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return null
  if (pricing.input === null || pricing.output === null) return null
  return (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000
}

export function settleTool(
  turn: LiveTurn,
  callId: string,
  status: string,
  result: { output?: string; error?: string; metadata?: Record<string, unknown> } = {},
): void {
  const entry = turn.tools.find((tool) => tool.callId === callId)
  if (!entry) return
  entry.status = status
  /**
   *
   * How long it actually took. Without it a card cannot tell `bash` that ran for
   * eight minutes from `bash` that ran for 200ms — the two render identically,
   * and the one worth asking about is the one that is invisible.
   *
   **/
  if (entry.startedAt !== undefined) entry.ms = Math.round(performance.now() - entry.startedAt)
  if (result.output) entry.output = result.output
  if (result.error) entry.error = result.error
  if (result.metadata) entry.metadata = result.metadata
}

/** A Hoshi tool answers with `{ title, output, metadata }`; `describeToolOutput`
 *  keeps the part the model reads. This keeps the part the CLIENT reads — the
 *  browser's screenshot, what a memory write saved — which was being dropped on
 *  the floor, so every rich tool card in the app rendered from `undefined`. */
export function toolMetadata(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object') return undefined
  const metadata = (output as { metadata?: unknown }).metadata
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined
}
