/**
 * ── What a tool actually did ─────────────────────────────────────────────────
 *
 * A tool call's result, turned into the text a person reads in the transcript.
 *
 * The harness hands back whatever the tool returned — a shell's
 * `{stdout, stderr, exitCode}`, a read's `{content, totalLines, …}`, a write's
 * `{bytesWritten}`. None of that is renderable as-is: JSON-stringifying a shell
 * result puts `\n` escapes on screen where the command's own output belongs,
 * which is the one thing anybody opens a bash card to see.
 *
 * The transcript is also read whole, forever, by every client and by the model
 * after a fold. A read of a large file must not paste that file into history a
 * second time, so everything here is capped.
 *
 **/

/** How much of a result is kept. Enough for a stack trace or a directory
 *  listing; small enough that reading a big file does not duplicate it into the
 *  session's history. */
export const MAX_TOOL_OUTPUT = 4_000

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  const dropped = text.length - MAX_TOOL_OUTPUT
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… truncated, ${dropped} more characters`
}

/**
 *
 * The shapes below are recognized STRUCTURALLY, not by tool name: a result that
 * looks like a shell run is rendered like one whoever produced it, so an MCP
 * connector returning `{stdout, stderr, exitCode}` reads as a terminal without
 * anybody registering it here. Each turns the tool's own return value into the
 * form that result is normally read in — a command's output as its output, a
 * file as numbered lines, a grep as `file:line: match`. Everything else falls
 * through to indented JSON, which is honest but is not what anybody opens a
 * bash card to see.
 *
 **/

/** A shell run: `{stdout, stderr, exitCode}`. */
function shellText(value: Record<string, unknown>): string | null {
  const { stdout, stderr, exitCode } = value
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || typeof exitCode !== 'number') return null
  const body = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  /**
   *
   * A failing command with no output at all would otherwise read as success.
   *
   **/
  if (exitCode !== 0) return body ? `${body}\nexit code ${exitCode}` : `exit code ${exitCode}`
  return body
}

/** A file read: `{content, fromLine}`. Numbered from the line the read actually
 *  started at, so a windowed read of a large file reports the file's own line
 *  numbers rather than counting from one. */
function fileText(value: Record<string, unknown>): string | null {
  const { content, fromLine } = value
  if (typeof content !== 'string') return null
  const start = typeof fromLine === 'number' && fromLine > 0 ? fromLine : 1
  return content
    .split('\n')
    .map((line, index) => `${start + index}: ${line}`)
    .join('\n')
}

/** A directory listing: `{entries: [{name, type}]}`, directories marked. */
function entriesText(value: Record<string, unknown>): string | null {
  const { entries } = value
  if (!Array.isArray(entries)) return null
  const names = entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => (typeof entry.name === 'string' ? `${entry.name}${entry.type === 'directory' ? '/' : ''}` : null))
    .filter((name): name is string => name !== null)
  return names.length === entries.length ? names.join('\n') : null
}

/** A search: `{matches: [{file, line, content}]}` as grep prints it. */
function matchesText(value: Record<string, unknown>): string | null {
  const { matches } = value
  if (!Array.isArray(matches)) return null
  const lines = matches
    .filter((match): match is Record<string, unknown> => !!match && typeof match === 'object')
    .map((match) =>
      typeof match.file === 'string' && typeof match.content === 'string'
        ? `${match.file}:${match.line ?? '?'}: ${match.content}`
        : null,
    )
    .filter((line): line is string => line !== null)
  if (lines.length !== matches.length) return null
  return lines.length ? lines.join('\n') : 'no matches'
}

/** Render a tool's return value for the transcript. `undefined` when there is
 *  nothing worth showing — a tool that returned nothing, or returned only an
 *  empty string, gets no body rather than an empty box. */
export function describeToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output.trim() ? truncate(output) : undefined
  if (typeof output === 'number' || typeof output === 'boolean') return String(output)
  if (typeof output === 'object') {
    const value = output as Record<string, unknown>
    for (const render of [shellText, fileText, entriesText, matchesText]) {
      const text = render(value)
      if (text !== null) return text ? truncate(text) : undefined
    }
    try {
      return truncate(JSON.stringify(output, null, 2))
    } catch {
      /**
       *
       * A cyclic or otherwise unserializable result: say so rather than
       * throwing inside the turn loop, which would fail a call that succeeded.
       *
       **/
      return '[result could not be serialized]'
    }
  }
  return undefined
}
