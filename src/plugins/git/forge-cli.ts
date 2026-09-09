import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CI_LOG_TAIL_CHARS, CI_LOG_TAIL_LINES } from './ci-loop.js'
import type { GitForge, GitPullRequest, GitPullRequestState } from './types.js'
import type { ExecFailure, GhPullRequest, GlabMergeRequest } from './forge-shapes.js'
import { execFailure, FORGE_CLI, FORGE_TOKEN_KEYS, rollupChecks } from './forge-shapes.js'

const execFileAsync = promisify(execFile)

/** A forge call crosses the network, so it gets the long budget rather than the
 *  ten seconds a local git command gets. */
const NETWORK_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 10 * 1024 * 1024

/**
 * ── Talking to gh and glab ───────────────────────────────────────────────────
 *
 * The wire layer under the pull-request surface: run the forge's CLI, parse
 * what it prints, and map two different vendors' JSON onto one shape.
 *
 * This is the part of git.ts that was a separate program wearing the same file
 * — 1,059 lines holding git primitives, branch naming, remote parsing, a full
 * gh/glab adapter and the CI watch (docs/STRUCTURE_REVIEW.md H-02). Only the
 * wire layer came out: `openPullRequest` and `forgeCiAccess` coordinate git AND
 * the forge, and moving those would have meant two modules importing each other.
 *
 **/

export function ghToPullRequest(pr: GhPullRequest): GitPullRequest | null {
  if (typeof pr.number !== 'number' || !pr.url) return null
  const raw = (pr.state ?? 'OPEN').toUpperCase()
  const state: GitPullRequestState =
    raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open'
  return { number: pr.number, url: pr.url, title: pr.title ?? '', state, checks: rollupChecks(pr.statusCheckRollup) }
}

export function glabToPullRequest(mr: GlabMergeRequest): GitPullRequest | null {
  if (typeof mr.iid !== 'number' || !mr.web_url) return null
  const raw = (mr.state ?? 'opened').toLowerCase()
  const state: GitPullRequestState =
    raw === 'merged'
      ? 'merged'
      : raw === 'closed' || raw === 'locked'
        ? 'closed'
        : mr.draft || mr.work_in_progress
          ? 'draft'
          : 'open'
  const pipeline = mr.pipeline?.status?.toLowerCase()
  const checks: GitPullRequest['checks'] = !pipeline
    ? null
    : ['failed', 'canceled'].includes(pipeline)
      ? 'failing'
      : ['success', 'manual'].includes(pipeline)
        ? 'passing'
        : 'pending'
  return { number: mr.iid, url: mr.web_url, title: mr.title ?? '', state, checks }
}

export function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** The tail of a failing job's log. The failing assertion is nearly always at
 *  the end, and a full CI log is tens of thousands of lines — sending all of it
 *  would blow the fix run's context for nothing. */
export function logTail(raw: string): string | null {
  const text = raw
    /**
     *
     * GitLab's job trace is a raw terminal stream: without this, ANSI colour
     * codes and its own collapsible-section markers would be most of the tail
     * the fix run spends its context on.
     *
     **/
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/section_(start|end):\d+:[^\r\n]*/g, '')
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-CI_LOG_TAIL_LINES)
    .join('\n')
  return text ? text.slice(-CI_LOG_TAIL_CHARS) : null
}

/** `owner/repo` as GitLab's REST API wants it in a path segment. */
export function glabProjectPath(repo: string): string {
  return encodeURIComponent(repo)
}

export async function runForgeCli(
  forge: GitForge,
  dir: string,
  args: string[],
  token: string | null,
): Promise<{ stdout: string; failure: ExecFailure | null }> {
  const cli = FORGE_CLI[forge]
  /**
   *
   * gh and glab each read their own token env var natively — forwarding the
   * vault value is the whole integration, and it is also what makes a machine
   * with no interactive `gh auth login` work at all.
   *
   **/
  const tokenEnv = token ? Object.fromEntries(FORGE_TOKEN_KEYS[forge].map((key) => [key, token])) : {}
  try {
    const { stdout } = await execFileAsync(cli, args, {
      cwd: dir,
      timeout: NETWORK_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, ...tokenEnv, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
    })
    return { stdout, failure: null }
  } catch (error) {
    return { stdout: '', failure: execFailure(error) }
  }
}
