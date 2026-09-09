import type { CiWatch } from './ci-loop.js'
import type { GitDiffFileSummary } from './exec.js'

/**
 * ── propose → review → land: the vocabulary ──────────────────────────────────
 *
 * The shapes the whole flow is written in — a commit, a remote, a forge, a pull
 * request, the assembled status a client renders. Apart from the flow itself
 * because four other modules here speak them (`remote` resolves a forge,
 * `forge-cli` parses one's JSON, the routes return them) and a type file that
 * imports nothing cannot make a cycle out of that.
 *
 * The other half of the Changes surface: the routes under git.*.post.ts that turn
 * "the agent edited some files" into a branch, a commit and a pull request a
 * human can review. Everything here runs the SAME binaries a developer would
 * (`git`, `gh`, `glab`) with the SAME credentials the machine already has —
 * the account's ambient SSH identity (../../kernel/ssh-identity.ts) for pushes
 * over git@, and a forge token out of the machine vault (../../kernel/secrets.ts) for the
 * forge CLIs. There is deliberately no new credential mechanism here.
 *
 * Every failure that a user can actually do something about gets its own stable
 * `git.*` code, because "git push failed" with a wall of stderr is exactly the
 * state this job exists to replace.
 *
 **/

export interface GitCommitSummary {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** ISO-8601, author date. */
  date: string
}

export type GitForge = 'github' | 'gitlab'

export interface GitRemoteInfo {
  name: string
  /** The remote URL as configured — never rewritten, never credential-bearing. */
  url: string
  host: string
  /** `owner/repo`, as the forge CLIs address it. */
  slug: string
  forge: GitForge | null
}

export type GitPullRequestState = 'open' | 'draft' | 'merged' | 'closed'

export interface GitPullRequest {
  number: number
  url: string
  title: string
  state: GitPullRequestState
  /** Rolled-up CI verdict, or null when the forge reports none. */
  checks: 'passing' | 'failing' | 'pending' | null
}

export interface GitStatus {
  branch: string
  base: string | null
  /** Commits on `branch` that `base` doesn't have, and vice versa. */
  ahead: number
  behind: number
  dirty: { staged: number; unstaged: number; untracked: number }
  /** The branch's own commits (newest first), capped. */
  commits: GitCommitSummary[]
  remote: GitRemoteInfo | null
  /** Whether `origin` already carries this branch. */
  pushed: boolean
  /** Present only when the caller asked for it — it costs a forge round-trip. */
  pr: GitPullRequest | null
  /** The closed-loop CI state for this branch, or null when it isn't watched.
   *  Always read, unlike `pr`: it is local state in ~/.hoshi, so it costs no
   *  network at all — which is what lets the Proposed panel render the loop off
   *  the `git.changed` event it already listens to, with no new event, no
   *  second request and no timer. */
  ci: CiWatch | null
}
