/**
 * ── Workflow prompt templating ───────────────────────────────────────────────
 *
 * The data-flow half of a workflow: a step's prompt is a template over the
 * run's accumulated context — the trigger payload and every completed step's
 * text/output. Hand-rolled dot-path interpolation, deliberately tiny: no
 * expressions, no filters, no escaping rules to learn. A missing path renders
 * as an empty string and is reported back so the run can surface a warning
 * instead of failing the whole pipeline over a typo. (Branching lives in the
 * sibling utils/workflow-condition.ts, over this same context.)
 *
 * `{{secrets.NAME}}` is the one namespace that does NOT come from the context:
 * it is resolved out of the machine's vault by the caller and passed in
 * separately, so this pass can emit the real prompt and a redacted twin of it
 * in one go — see utils/workflow-secrets.ts for why the redacted one is what
 * gets persisted.
 *
 * Substitution is a single pass over the TEMPLATE: an inserted value that
 * happens to contain `{{secrets.X}}` is never re-processed, so a webhook body
 * can't template its way into the vault.
 *
 **/

import { resolvePath } from './workflow-path.js'

const TEMPLATE_PATH = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

const SECRET_PREFIX = 'secrets.'

/** What replaces a secret everywhere it could be stored or displayed. Lives
 *  here, with the render that produces it, so this module stays free of the
 *  vault's own dependencies. */
export const SECRET_MASK = '••••••••'

export interface RenderedTemplate {
  /** What actually goes to the agent — secrets resolved. */
  text: string
  /** The same render with every secret value masked. This is the only variant
   *  that may be stored, pushed to a client, or logged. */
  redacted: string
  /** Every `{{path}}` that resolved to nothing — surfaced as run warnings.
   *  A missing secret is reported as `secrets.<KEY>`; a KEY is a name, not a
   *  value, so naming it is safe. */
  missing: string[]
}

/** Interpolate `{{dot.path}}` references over `context`. Strings insert as-is,
 *  numbers/booleans stringify, objects/arrays insert as JSON — so
 *  `{{trigger.body}}` hands the agent the whole payload while
 *  `{{trigger.body.issue.title}}` picks one field. `secrets` maps vault key
 *  names to values for the `{{secrets.NAME}}` namespace. */
export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  secrets: Map<string, string> = new Map(),
): RenderedTemplate {
  const missing: string[] = []
  /**
   *
   * Both variants come out of ONE pass so they can never drift: every
   * replacement contributes its real text to one and its safe text to the
   * other, and the surrounding prose is identical by construction.
   *
   **/
  let text = ''
  let redacted = ''
  let cursor = 0

  for (const match of template.matchAll(TEMPLATE_PATH)) {
    const path = match[1]!
    const start = match.index
    const literal = template.slice(cursor, start)
    text += literal
    redacted += literal
    cursor = start + match[0].length

    if (path.startsWith(SECRET_PREFIX)) {
      const value = secrets.get(path.slice(SECRET_PREFIX.length))
      if (value === undefined) {
        missing.push(path)
        continue
      }
      text += value
      redacted += SECRET_MASK
      continue
    }

    const resolved = renderValue(resolvePath(context, path))
    if (resolved === null) {
      missing.push(path)
      continue
    }
    text += resolved
    redacted += resolved
  }

  const tail = template.slice(cursor)
  return { text: text + tail, redacted: redacted + tail, missing }
}

/** One resolved path as template text, or null when there is nothing to insert. */
function renderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}
