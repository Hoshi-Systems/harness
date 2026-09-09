import { complete, getPreferences } from '../../kernel/index.js'

/**
 * ── Goal audit call (CYB-100) ────────────────────────────────────────────────
 *
 * After every turn on a goal-armed session, the goal loop asks a model to judge
 * the agent's LATEST reply against the objective alone — never the full chat
 * history — and hands back keep_going/done/stuck.
 *
 * This used to be an apparatus. The old runtime had no way to just ask a model
 * a question, so an audit meant creating a session in a scratch directory
 * chosen to be invisible to the client's session list, prompting it, reading
 * the reply, and deleting the session again — plus a search through the
 * provider catalogue for a cheap model on the session's own provider, by name
 * hints and then by price, because the call had to name one. `complete()` is
 * that whole thing now.
 *
 **/

/** A real model call, and a generous timeout: the audit runs once per turn, and
 *  latency here never blocks the user's own session — only how quickly the NEXT
 *  automatic continuation goes out. */
const AUDIT_TIMEOUT_MS = 60_000

export interface AuditVerdict {
  verdict: 'keep_going' | 'done' | 'stuck'
  note: string
}

const AUDIT_SYSTEM_PROMPT = `You are a strict, terse progress auditor for an autonomous coding agent.
You are given the ORIGINAL OBJECTIVE the agent was asked to accomplish, and the agent's LATEST reply
(only that reply — you do not see the rest of the conversation). Decide, from the reply alone:
- "done": the objective has now been fully achieved.
- "stuck": the agent seems blocked, looping, confused, or waiting on something it can't get, and is not making progress.
- "keep_going": real progress is being made but the objective is not complete yet.

Respond with ONLY a single-line JSON object — no markdown fence, no commentary:
{"verdict":"done"|"stuck"|"keep_going","note":"<one short sentence on what's happening>"}`

/** Judge the agent's latest reply against the objective. Returns null on any
 *  failure — network, timeout, an unparsable answer — so the caller retries on
 *  the next turn instead of settling a goal off a broken call.
 *
 *  On the small model when the machine has one: an audit is a classification,
 *  not the work, and it runs once per turn for as long as the goal is armed. */
export async function runGoalAudit(params: { objective: string; reply: string }): Promise<AuditVerdict | null> {
  try {
    const { smallModel } = await getPreferences()
    const text = await complete(`OBJECTIVE:\n${params.objective}\n\nLATEST AGENT REPLY:\n${params.reply}`, {
      ...(smallModel ? { model: smallModel } : {}),
      system: AUDIT_SYSTEM_PROMPT,
      timeoutMs: AUDIT_TIMEOUT_MS,
    })
    return parseVerdict(text)
  } catch (error) {
    console.error('[goal-audit] audit call failed:', error)
    return null
  }
}

/** Tolerant JSON extraction — a small model occasionally wraps its answer in
 *  a markdown fence or adds a stray sentence despite instructions. Takes the
 *  first `{...}` substring and validates its shape before trusting it. */
function parseVerdict(text: string): AuditVerdict | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; note?: unknown }
    if (parsed.verdict !== 'keep_going' && parsed.verdict !== 'done' && parsed.verdict !== 'stuck') return null
    return {
      verdict: parsed.verdict,
      note: typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : '',
    }
  } catch {
    return null
  }
}
