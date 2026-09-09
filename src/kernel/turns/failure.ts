/**
 * ── What went wrong, in words ────────────────────────────────────────────────
 *
 * Turning a provider's error into something a person can act on. It sat between
 * the turn loop and the flush machinery as one of seven concerns in a 978-line
 * module, and the tests already treated it as its own subject —
 * failure-detail.test.ts imported exactly this and nothing around it. Nothing
 * here touches turn state (docs/STRUCTURE_REVIEW.md H-02).
 *
 **/

/** What actually went wrong, in words a person can act on.
 *
 *  Worth its own function because the obvious version is wrong in the case that
 *  matters most. A provider rejecting a request throws an AI SDK error whose
 *  `message` is often an object, and `String(error)` on it yields the useless
 *  `[object Object]` — precisely when the user most needs to know that their
 *  endpoint said "model not found" or "context too long". So this walks the
 *  places a cause actually hides: the response body, `cause`, `data`. */
export function describeFailure(error: unknown): { name: string; message: string } {
  const source = (error ?? {}) as Record<string, unknown>
  const name = typeof source.name === 'string' ? source.name : 'Error'
  const status = typeof source.statusCode === 'number' ? source.statusCode : null

  const candidates = [
    source.message,
    source.responseBody,
    (source.data as Record<string, unknown> | undefined)?.error,
    source.data,
    source.cause,
    error,
  ]
  for (const candidate of candidates) {
    const text = readable(candidate)
    if (text) return { name, message: withStatus(status, text) }
  }
  return {
    name,
    message: withStatus(status, 'The turn failed and the provider said nothing useful about why.'),
  }
}

/** The status code in front of the provider's own words.
 *
 *  Because the two answer different questions and only together say what to do:
 *  "model not found" from a 404 is a name to fix, the same words from a 500 are
 *  an endpoint to restart. Left off when the message already carries it, which
 *  some providers do. */
function withStatus(status: number | null, message: string): string {
  if (status === null || new RegExp(`\\b${status}\\b`).test(message)) return message
  return `HTTP ${status} · ${message}`
}

/**
 *
 * Text that would tell a person nothing. `[object Object]` is the one that
 * matters: a provider error arrives with its body already stringified into the
 * message that way, and since a non-empty string looked like an answer, the
 * search for a real cause stopped at it and the turn card showed those exact
 * fifteen characters as the reason. Rejecting them here is what lets the walk
 * continue to the response body, where the actual words are.
 *
 **/
const USELESS = new Set(['[object object]', 'undefined', 'null', '{}', '[]', 'error', 'unknown error'])

/** A value rendered as something worth showing a person, or null when it says
 *  nothing — in which case the caller keeps looking.
 *
 *  Recursive because causes nest: an SDK error wrapping a fetch failure wrapping
 *  a provider body, each level holding the useless summary of the one below it. */
function readable(value: unknown, depth = 0): string | null {
  if (depth > 4) return null
  if (typeof value === 'string') {
    const text = value.trim()
    return text && !USELESS.has(text.toLowerCase()) ? text : null
  }
  if (value instanceof Error) {
    return readable(value.message, depth + 1) ?? readable(value.cause, depth + 1)
  }
  if (value && typeof value === 'object') {
    const record = value as { message?: unknown; error?: unknown }
    const nested = readable(record.message, depth + 1) ?? readable(record.error, depth + 1)
    if (nested) return nested
    /**
     *
     * Last resort: dump whatever is left. Left, specifically — the fields this
     * walk has already read and rejected are dropped first, because a dump that
     * consists of the useless message plus the name already printed beside it
     * reads as detail while carrying none. What survives is the part nobody has
     * looked at yet: a status, a url, a provider's own error code.
     *
     **/
    try {
      const rest = Object.fromEntries(
        Object.entries(value).filter(([key]) => !['name', 'message', 'error', 'stack', 'cause'].includes(key)),
      )
      const json = JSON.stringify(rest)
      return json && !USELESS.has(json.toLowerCase()) ? json.slice(0, 500) : null
    } catch {
      return null
    }
  }
  return null
}

/** The file a settled tool call changed, when it is one that changes files.
 *  The names are the ones engine/tools.ts registers — an earlier pass checked a
 *  different vocabulary than the registry used and the event simply never
 *  fired, which read as a file panel that had stopped caring. */
