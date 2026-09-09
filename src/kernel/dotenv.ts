/**
 *
 * A deliberately small `.env` codec, shared by the machine secret vault
 * (utils/secrets.ts) and per-project `.env` materialization. `KEY=VALUE` per
 * line, values single-quoted with inner quotes escaped. We only ever write keys
 * we own, so this isn't a full dotenv grammar — just a stable round-trip and
 * tolerance of foreign lines (comments, blanks, other keys are preserved).
 *
 **/

/** Single-quote a value, escaping inner quotes — safe for a POSIX shell `.env`. */
export function quoteEnvValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Decode a single-quoted `.env` value back to its raw string. */
export function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'")
  }
  return trimmed
}

/** Which quote character, if any, `text` is still inside when it ends — given
 *  which one it started inside. Both styles are tracked: we only ever WRITE
 *  single quotes, but the file we merge into is a stranger's and doubles are
 *  just as common there.
 *
 *  Parity counting won't do. The POSIX escape for an inner single quote is
 *  `'\''` — close, escaped quote, reopen — so a perfectly balanced value like
 *  `'a'\''b'` holds an ODD number of apostrophes. Shell quoting rules also
 *  differ per style: a backslash escapes inside double quotes and outside any,
 *  but is literal inside single quotes. */
type QuoteState = "'" | '"' | null

function endsInsideQuote(text: string, quote: QuoteState): QuoteState {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null // nothing escapes inside single quotes
    } else if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
    } else if (ch === '\\') {
      i++ // escapes the next character, which therefore can't open a quote
    } else if (ch === "'" || ch === '"') {
      quote = ch
    }
  }
  return quote
}

/** Upsert `entries` into an existing `.env` body, preserving every other line
 *  (comments, blanks, keys we don't own) verbatim: a key already present has its
 *  assignment replaced in place; new keys are appended. Returns the new body
 *  with a single trailing newline (empty string when there's nothing to write).
 *  This is the merge that keeps a cloned repo's own `.env` intact.
 *
 *  "Intact" is why this walks assignments rather than lines. The values WE write
 *  are single-line (utils/secrets.ts rejects line breaks), but the file we merge
 *  into came out of a git clone and may hold a multi-line quoted value — a PEM
 *  key is the everyday case. Treating each physical line as its own assignment
 *  corrupted those two ways: replacing such a key rewrote only its first line and
 *  orphaned the rest (leaving an unbalanced quote behind), and a `KEY=…` line
 *  sitting INSIDE somebody else's quoted value was matched and rewritten — so
 *  pulling a vault key could destroy an unrelated certificate and never land the
 *  secret at all. */
export function upsertEnv(existing: string, entries: Map<string, string>): string {
  const remaining = new Map(entries)
  const lines = existing.length ? existing.split('\n') : []
  /**
   *
   * A file ending in a newline splits to a final empty element. Left in, every
   * appended key lands after it and gains a blank line above it. Interior blanks
   * are the author's formatting and stay; this one is an artifact of the split.
   *
   **/
  if (lines.at(-1) === '') lines.pop()
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const eq = line.indexOf('=')
    if (eq <= 0) {
      out.push(line)
      continue
    }

    /**
     *
     * How far this assignment actually reaches — its value may run on past the
     * end of this physical line.
     *
     **/
    let last = i
    let open = endsInsideQuote(line.slice(eq + 1), null)
    while (open && last + 1 < lines.length) {
      last++
      open = endsInsideQuote(lines[last]!, open)
    }

    const key = line.slice(0, eq).trim()
    if (remaining.has(key)) {
      /**
       *
       * Replaces the WHOLE assignment, continuation lines included.
       *
       **/
      out.push(`${key}=${quoteEnvValue(remaining.get(key)!)}`)
      remaining.delete(key)
    } else {
      for (let j = i; j <= last; j++) out.push(lines[j]!)
    }
    i = last
  }

  for (const [key, value] of remaining) out.push(`${key}=${quoteEnvValue(value)}`)
  const body = out.join('\n').replace(/\n+$/, '')
  return body ? `${body}\n` : ''
}
