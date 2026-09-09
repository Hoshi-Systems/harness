import type { GitForge, GitPullRequest } from './types.js'

/**
 * ── What a forge answers with ────────────────────────────────────────────────
 *
 * The vendors' JSON shapes, the CLI names, the token keys, and the two mappers
 * that turn either vendor's response into Hoshi's one shape.
 *
 * Its own module because BOTH sides need it: forge-cli.ts runs the CLI and maps
 * the reply, git.ts names the CLI in an error and reads its token. While these
 * lived in git.ts, extracting the adapter made the two import each other —
 * check-cycles.mjs caught that, on the second attempt: the gate's own import
 * pattern was single-line, so it had been blind to every prettier-wrapped
 * import until this cycle exposed it.
 *
 **/

export function execFailure(error: unknown): ExecFailure {
  const e = error as { stdout?: string; stderr?: string; code?: unknown; message?: string }
  return {
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : (e.message ?? ''),
    code: typeof e.code === 'number' ? e.code : null,
    missing: e.code === 'ENOENT',
  }
}

export function rollupChecks(rollup: GhPullRequest['statusCheckRollup']): GitPullRequest['checks'] {
  if (!rollup?.length) return null
  const verdicts = rollup.map((check) => (check.conclusion ?? check.state ?? check.status ?? '').toUpperCase())
  if (verdicts.some((v) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(v))) {
    return 'failing'
  }
  if (verdicts.some((v) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', ''].includes(v)))
    return 'pending'
  return 'passing'
}

/** The vault keys each forge's CLI already reads from its own environment, in
 *  the order the CLI itself prefers them. Setting one in Customize → Secrets is
 *  the whole wiring — the sidecar just forwards it into the child process. */
export const FORGE_TOKEN_KEYS: Record<GitForge, string[]> = {
  github: ['GH_TOKEN', 'GITHUB_TOKEN', 'HOSHI_GITHUB_TOKEN'],
  gitlab: ['GITLAB_TOKEN', 'GLAB_TOKEN', 'HOSHI_GITLAB_TOKEN'],
}

export const FORGE_CLI: Record<GitForge, string> = { github: 'gh', gitlab: 'glab' }

export interface ExecFailure {
  stdout: string
  stderr: string
  code: number | null
  /** True when the binary itself isn't on PATH. */
  missing: boolean
}

export interface GhPullRequest {
  number?: number
  url?: string
  title?: string
  state?: string
  isDraft?: boolean
  statusCheckRollup?: Array<{ state?: string; conclusion?: string; status?: string }>
}

export interface GlabMergeRequest {
  iid?: number
  web_url?: string
  title?: string
  state?: string
  draft?: boolean
  work_in_progress?: boolean
  pipeline?: { status?: string } | null
}
