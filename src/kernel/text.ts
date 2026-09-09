/** First non-blank line of a blob — the one-line summary of a longer log or
 *  error output, for user-facing messages. Falls back to the input verbatim
 *  when every line is blank. */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim()) ?? text
}
