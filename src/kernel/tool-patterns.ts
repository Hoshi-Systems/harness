/**
 * ── Pattern-scoped permissions ───────────────────────────────────────────────
 *
 * "Allow `git push *`, keep asking about everything else `bash` can do."
 *
 * A per-tool level alone forces a choice nobody wants to make: approve every
 * shell command this machine will ever run, or answer a card for each one. The
 * interesting decisions are in between, and they are about the ARGUMENT rather
 * than the tool — which command, which file, which host.
 *
 * Kept apart from engine/permissions.ts because it is pure: what a rule matches
 * is a question about strings, and it is the half worth testing exhaustively.
 *
 **/

import type { Level } from './permissions.js'

export interface ToolRule {
  /** A glob over the tool's subject: `git push *`, `src/**`, `https://api.*`. */
  pattern: string
  level: Level
}

/** The argument a rule matches against, per tool — the thing the person is
 *  actually deciding about.
 *
 *  Listed rather than guessed: a rule that silently matched the wrong field
 *  would read as "allow git push" and mean something else entirely, which is
 *  the one failure mode a permission system may not have. A tool that is not
 *  here has no subject, so only its tool-wide level applies. */
const SUBJECT: Record<string, string[]> = {
  bash: ['command'],
  write: ['filePath'],
  edit: ['filePath'],
  read: ['filePath'],
  delete: ['filePath'],
  list: ['dirPath', 'path'],
  grep: ['pattern'],
  webfetch: ['url'],
  web_search: ['query'],
  browser_navigate: ['url'],
  git_commit: ['message'],
  git_pr: ['title'],
  process_start: ['command'],
}

/** What a rule for this tool is written against, or null when the tool has no
 *  subject a person would scope by. */
export function subjectOf(tool: string, input: unknown): string | null {
  const fields = SUBJECT[tool]
  if (!fields) return null
  const args = (input ?? {}) as Record<string, unknown>
  for (const field of fields) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Glob → RegExp. `*` spans anything, including separators: a person writing
 *  `src/*` means "under src", not "one path segment deep", and the second
 *  reading is a trap that shows up only once a rule silently fails to match. */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function matches(pattern: string, subject: string): boolean {
  return toRegExp(pattern).test(subject)
}

/** How specific a pattern is: the literal characters it commits to. `git push *`
 *  (10) beats `git *` (4) beats `*` (0). */
function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length
}

/** The level a tool's rules decide for one call, or null when none matches.
 *
 *  The MOST SPECIFIC match wins, not the first: rules accumulate as a person
 *  answers cards over weeks, in the order the questions happened to arrive, and
 *  "the rule I wrote about `git push` beats the blanket one" is the only
 *  ordering anybody would predict. Ties go to the earlier rule, so a file that
 *  is edited by hand still reads top-to-bottom. */
export function levelFromRules(rules: ToolRule[], subject: string | null): Level | null {
  if (!subject) return null
  let best: { level: Level; score: number } | null = null
  for (const rule of rules) {
    if (!matches(rule.pattern, subject)) continue
    const score = specificity(rule.pattern)
    if (!best || score > best.score) best = { level: rule.level, score }
  }
  return best?.level ?? null
}

/** Fold a grant into a tool's rules: the new pattern wins where it applies, and
 *  anything it fully supersedes is dropped rather than left behind as a rule
 *  that can never fire again. */
export function foldRule(rules: ToolRule[], pattern: string, level: Level): ToolRule[] {
  const kept = rules.filter((rule) => rule.pattern !== pattern && !matches(pattern, rule.pattern))
  return [...kept, { pattern, level }]
}

/** What to offer as "always allow" scopes for one call, widest last:
 *  the exact subject, and a prefix glob one word/segment up from it.
 *
 *  The prefix is what makes a grant useful rather than a formality — approving
 *  the exact string `echo hoshi-ok` brings the same card back on the next
 *  command, which is how a permission system teaches people to stop reading
 *  cards. */
export function grantSuggestions(tool: string, input: unknown): { exact: string[]; prefix: string[] } {
  const subject = subjectOf(tool, input)
  if (!subject) return { exact: [], prefix: [] }

  /**
   *
   * A command's first word is what it IS; a path's directory is where it lives.
   *
   **/
  const prefix = subject.includes('/') && !subject.includes(' ') ? dirGlob(subject) : commandGlob(subject)
  return { exact: [subject], prefix: prefix && prefix !== subject ? [prefix] : [] }
}

function commandGlob(subject: string): string | null {
  const [head] = subject.split(/\s+/)
  return head ? `${head} *` : null
}

function dirGlob(subject: string): string | null {
  const cut = subject.lastIndexOf('/')
  return cut > 0 ? `${subject.slice(0, cut)}/*` : null
}
