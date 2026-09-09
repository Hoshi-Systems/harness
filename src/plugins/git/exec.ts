import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { apiError, isCheckoutDir, workspaceRoot } from '../../kernel/index.js'

/**
 * ── Running git, and reading a repo ──────────────────────────────────────────
 *
 * The one place this plugin shells out to `git`, and the read-only questions it
 * asks: which worktree a caller may address at all, what branch it is on, what
 * changed. Everything above it — branch, commit, push, the forge CLIs — goes
 * through `git()` here, which is what makes the timeout and the buffer ceiling
 * one decision rather than eleven.
 *
 **/

export const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
/** A push or a forge API round-trip crosses the network; the local-only
 *  commands above it never should. */
export const NETWORK_TIMEOUT_MS = 120_000
/** Summaries are tiny; a single-file diff of a big change can be megabytes. */
export const GIT_MAX_BUFFER = 10 * 1024 * 1024

export interface GitDiffFileSummary {
  path: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
  return stdout
}

/** Resolve a caller-supplied directory to a git worktree this machine is willing
 *  to diff: a checkout (`<root>/<org>/<project>`) or the workspace root itself
 *  (the personal scope). Anything else — traversal, /etc, an org folder — is a
 *  400 before touching the filesystem. */
export async function resolveGitDir(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  if (!isCheckoutDir(resolved) && resolved !== workspaceRoot()) {
    apiError(400, 'git_dir_outside_workspace', 'Directory is outside the machine workspace.')
  }
  try {
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
  } catch {
    apiError(404, 'git_dir_not_found', 'Directory not found on this machine.')
  }
  try {
    await git(resolved, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    apiError(409, 'not_a_git_repo', 'This directory is not a git repository.')
  }
  return resolved
}

/** The checked-out branch plus the base to diff a feature branch against: the
 *  remote's default branch when known, else a local `main`/`master`, else null
 *  (a repo with no recognizable base — branch scope degrades to empty). */
export async function gitBranchInfo(dir: string): Promise<{ branch: string; base: string | null }> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  let base: string | null = null
  try {
    const ref = (await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    base = ref.split('/').pop() || null
  } catch {
    for (const candidate of ['main', 'master']) {
      try {
        await git(dir, ['rev-parse', '--verify', '--quiet', candidate])
        base = candidate
        break
      } catch {
        /* try the next candidate */
      }
    }
  }
  return { branch, base }
}

/** Changed files with add/remove counts for a range (`base...HEAD`) or, without
 *  a range, the working tree vs HEAD. Renames are left as delete+add on purpose
 *  (no `-M`) so the two invocations below always agree on paths. */
export async function gitDiffSummary(dir: string, range?: string): Promise<GitDiffFileSummary[]> {
  const rangeArgs = range ? [range] : ['HEAD']
  const [numstat, nameStatus] = await Promise.all([
    git(dir, ['diff', '--numstat', ...rangeArgs]),
    git(dir, ['diff', '--name-status', ...rangeArgs]),
  ])

  const statusByPath = new Map<string, GitDiffFileSummary['status']>()
  for (const line of nameStatus.split('\n')) {
    const match = /^([AMD])\t(.+)$/.exec(line)
    if (match) statusByPath.set(match[2]!, match[1] === 'A' ? 'added' : match[1] === 'D' ? 'deleted' : 'modified')
  }

  const files: GitDiffFileSummary[] = []
  for (const line of numstat.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!match) continue
    files.push({
      path: match[3]!,
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      status: statusByPath.get(match[3]!) ?? 'modified',
    })
  }
  return files
}

/** The unified diff of one file for a range, or the working tree vs HEAD. The
 *  path rides after `--`, so it can never be read as an option. */
export async function gitDiffFile(dir: string, file: string, range?: string): Promise<string> {
  const rangeArgs = range ? [range] : ['HEAD']
  return git(dir, ['diff', ...rangeArgs, '--', file])
}

/** Enough to review; a branch with more commits than this is past the point
 *  where a list is the useful view. */
export const MAX_COMMITS = 100

/** Branch names Hoshi will never commit onto or open a PR from — proposing a
 *  change means proposing it from somewhere that isn't the trunk. */
export const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'HEAD'])

/** The last few lines of a command's own output — enough to be diagnostic in a
 *  toast without pasting a screenful of git into the UI. */
export function tail(text: string, lines = 4): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' ')
    .slice(0, 500)
}
