import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineHoshiTool, z, type HoshiToolFactories, type HoshiToolResult } from '../define-tool.js'

/**
 *
 * Hoshi's propose → review → land tools: `git_branch`, `git_commit`, `git_pr`.
 *
 * The agent could already shell out to `git` and `gh` — the machine ships both.
 * That is a capability, not a workflow: the PR URL ends up buried in bash
 * output, the human's half of the loop happens outside Hoshi, and every model
 * improvises its own branch naming. These tools make "when you're done, open a
 * pull request" a first-class instruction with a first-class result: the branch
 * follows the `hoshi/<slug>` convention, the PR comes back as a card in the
 * chat (metadata.hoshi.git — see apps/app's ToolWidgetGit), and each failure
 * mode has its own honest message instead of a wall of stderr.
 *
 * CREDENTIALS: none of its own. Pushes ride the account's ambient SSH identity
 * (~/.ssh/config, written by the Platform plugin's git-identity sync; the path is kernel/ssh-identity.ts's); `gh`/
 * `glab` use their own device-code login, or a token out of the machine vault
 * — which is already in this process's environment, because the machine image's
 * entrypoint sources the vault into it before exec'ing the daemon
 * (infra/machine/entrypoint.sh). OpenCode used to do that at startup, which is
 * what this comment said until the section it cited was deleted with the rest
 * of that runtime's documentation.
 * Nothing here reads, writes or invents a credential.
 *
 * packages/harness/src/plugins/git/git.ts implements the SAME operations for the web
 * panel's own routes, and neither file imports the other (see below) — the
 * branch convention, the forge detection and the failure classification are
 * deliberately duplicated between them. Keep both tiny and in lockstep if you
 * change one — and note that the other pair this used to point at, the
 * background-process registry, is ONE implementation now
 * (docs/STRUCTURE_REVIEW.md H-08), so this is the last of them. The sidecar notices the branch move
 * on its own (plugins/state-events.ts watches `.git`), so these tools never
 * need to call it — which is what lets this file stay self-contained.
 *
 * The "no repo-internal imports — ever" rule these files carried is retired
 * with the package that justified it: they ran inside another process, and now
 * they are ordinary in-process modules contributed by the plugin that owns this
 * domain. That rule is what produced the duplication docs/STRUCTURE_REVIEW.md
 * H-08 records — a private copy of the memory store, and a second background
 * process registry — so: import what you need.
 *
 * Nor does exporting more than one thing abort anything any more; that was
 * OpenCode calling every export of a plugin file at load. Module-private is
 * still the default here, but for the ordinary reason.
 *
 **/

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
/** A push or a forge round-trip crosses the network; local git never does. */
const NETWORK_TIMEOUT_MS = 120_000
const MAX_BUFFER = 10 * 1024 * 1024
/** Enough commits to describe the proposal in the tool's own output. */
const MAX_COMMITS = 20

type Forge = 'github' | 'gitlab'

const FORGE_CLI: Record<Forge, string> = { github: 'gh', gitlab: 'glab' }

/** Branch names a change is never proposed FROM. */
const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'HEAD'])

interface Failure {
  stderr: string
  stdout: string
  missing: boolean
}

function failureOf(error: unknown): Failure {
  const e = error as { stdout?: string; stderr?: string; code?: unknown; message?: string }
  return {
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : (e.message ?? ''),
    missing: e.code === 'ENOENT',
  }
}

function tail(text: string, lines = 4): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' ')
    .slice(0, 500)
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  })
  return stdout
}

/** The repository the tool acts on: the session's worktree when it is one,
 *  else its directory. Both come from OpenCode; neither is model-supplied, so
 *  there is no path to validate. */
async function repoDir(context: { directory: string; worktree: string }): Promise<string> {
  for (const candidate of [context.worktree, context.directory]) {
    if (!candidate) continue
    try {
      await git(candidate, ['rev-parse', '--is-inside-work-tree'])
      return candidate
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    `${context.worktree || context.directory} is not a git repository — run \`git init\` (or work inside a checkout) before proposing a change.`,
  )
}

/**
 * ── Branch naming (mirrors packages/harness/src/plugins/git/git.ts) ────────────────────
 *
 **/

function sessionBranchName(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `hoshi/${slug || 'change'}`
}

function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.startsWith('-')) return false
  if (/\.\.|@\{|\/\/|[\x00-\x20~^:?*[\\\x7f]/.test(name)) return false
  return true
}

/**
 * ── Remote / forge (mirrors packages/harness/src/plugins/git/git.ts) ───────────────────
 *
 **/

interface RemoteInfo {
  name: string
  url: string
  host: string
  slug: string
  forge: Forge | null
}

function parseRemoteUrl(name: string, url: string): RemoteInfo | null {
  let host: string
  let pathname: string
  const scp = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url)
  if (scp && !url.includes('://')) {
    host = scp[1]!
    pathname = scp[2]!
  } else {
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      pathname = parsed.pathname
    } catch {
      return null
    }
  }
  const slug = pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!slug || !host) return null
  const lower = host.toLowerCase()
  const forge: Forge | null =
    lower === 'github.com' || lower.endsWith('.github.com') || lower.startsWith('github.')
      ? 'github'
      : lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.startsWith('gitlab.')
        ? 'gitlab'
        : null
  return { name, url, host, slug, forge }
}

/** The URL comes from `git config`, NOT `git remote -v` — the latter prints it
 *  after `url.<base>.insteadOf` rewriting, which would read the forge off a
 *  corporate mirror's hostname instead of the project's own. */
async function remoteInfo(dir: string): Promise<RemoteInfo | null> {
  let names: string[]
  try {
    names = (await git(dir, ['remote']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const name = names.includes('origin') ? 'origin' : names[0]
  if (!name) return null
  const read = async (key: string) => (await git(dir, ['config', '--get', key]).catch(() => '')).trim()
  const url = (await read(`remote.${name}.pushurl`)) || (await read(`remote.${name}.url`))
  return url ? parseRemoteUrl(name, url) : null
}

async function branchInfo(dir: string): Promise<{ branch: string; base: string | null }> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  let base: string | null = null
  try {
    base = (await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim().split('/').pop() || null
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

interface CommitSummary {
  sha: string
  shortSha: string
  subject: string
}

async function branchCommits(dir: string, base: string | null): Promise<CommitSummary[]> {
  if (!base) return []
  const raw = await git(dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1e', `${base}..HEAD`])
  const commits: CommitSummary[] = []
  for (const record of raw.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\x1f')
    if (fields.length < 3 || !fields[0]) continue
    commits.push({ sha: fields[0]!, shortSha: fields[1]!, subject: fields[2]! })
  }
  return commits
}

/**
 * ── Push ─────────────────────────────────────────────────────────────────────
 *
 **/

const CREDENTIAL_HELPER = '!f() { echo "username=x-access-token"; echo "password=$HOSHI_FORGE_TOKEN"; }; f'

/** The empty reset is not optional: credential helpers are a LIST consulted in
 *  config order, and system/global config wins over `-c`, so any helper the
 *  machine already has configured would answer first and the vault token would
 *  never be used. `credential.helper=` clears the list. */
const CREDENTIAL_ARGS = ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`]

/** The forge token already in this process's environment — the machine vault's
 *  `.env`, which OpenCode loads at startup. Never read from disk here. */
function forgeToken(forge: Forge): string | null {
  const keys =
    forge === 'github'
      ? ['GH_TOKEN', 'GITHUB_TOKEN', 'HOSHI_GITHUB_TOKEN']
      : ['GITLAB_TOKEN', 'GLAB_TOKEN', 'HOSHI_GITLAB_TOKEN']
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function pushErrorMessage(stderr: string): string {
  const text = stderr.toLowerCase()
  if (/protected branch|pre-receive hook declined|gh006|refusing to allow/.test(text)) {
    return `The remote refused the push: that branch is protected. Propose the change on a different branch. (${tail(stderr)})`
  }
  if (/non-fast-forward|fetch first|updates were rejected|behind its remote/.test(text)) {
    return `The remote branch has commits this one doesn't. Pull or rebase first, then push again — do NOT force-push without asking the user. (${tail(stderr)})`
  }
  if (
    /permission denied|authentication failed|could not read username|403|invalid username or password|access denied/.test(
      text,
    )
  ) {
    return `The remote rejected this machine's credentials. Tell the user to add their SSH key in Settings → Git Identity, or a forge token in Customize → Secrets — don't retry. (${tail(stderr)})`
  }
  return `git push failed: ${tail(stderr)}`
}

async function pushBranch(dir: string, branch: string, remote: RemoteInfo): Promise<void> {
  const token = remote.forge ? forgeToken(remote.forge) : null
  const https = remote.url.startsWith('http://') || remote.url.startsWith('https://')
  /**
   *
   * The token rides the child's environment and is echoed by a one-shot
   * credential helper — never the URL, never argv, never disk.
   *
   **/
  const args = [...(https && token ? CREDENTIAL_ARGS : []), 'push', '--set-upstream', remote.name, branch]
  try {
    await git(dir, args, NETWORK_TIMEOUT_MS, https && token ? { HOSHI_FORGE_TOKEN: token } : undefined)
  } catch (error) {
    const failure = failureOf(error)
    throw new Error(pushErrorMessage(failure.stderr || failure.stdout))
  }
}

/**
 * ── Forge CLI ────────────────────────────────────────────────────────────────
 *
 **/

async function runForge(
  forge: Forge,
  dir: string,
  args: string[],
): Promise<{ stdout: string; failure: Failure | null }> {
  const token = forgeToken(forge)
  const keys = forge === 'github' ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GITLAB_TOKEN', 'GLAB_TOKEN']
  try {
    const { stdout } = await execFileAsync(FORGE_CLI[forge], args, {
      cwd: dir,
      timeout: NETWORK_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        ...(token ? Object.fromEntries(keys.map((key) => [key, token])) : {}),
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
      },
    })
    return { stdout, failure: null }
  } catch (error) {
    return { stdout: '', failure: failureOf(error) }
  }
}

function forgeErrorMessage(forge: Forge, failure: Failure): string {
  const cli = FORGE_CLI[forge]
  if (failure.missing)
    return `The ${cli} CLI isn't installed on this machine, so a pull request can't be opened from here.`
  const text = `${failure.stderr}\n${failure.stdout}`.toLowerCase()
  if (/auth|token|401|credential|not logged|unauthorized|permission|403/.test(text)) {
    return `${cli} isn't authenticated for this repository. Tell the user to run \`${cli} auth login\` on this machine (its own device-code sign-in — Hoshi never sees the token), or to add a token in Customize → Secrets. Then stop and wait — do NOT retry.`
  }
  return `${cli} failed: ${tail(failure.stderr || failure.stdout)}`
}

interface PullRequest {
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'passing' | 'failing' | 'pending' | null
}

function rollupChecks(
  rollup: Array<{ state?: string; conclusion?: string; status?: string }> | undefined,
): PullRequest['checks'] {
  if (!rollup?.length) return null
  const verdicts = rollup.map((check) => (check.conclusion ?? check.state ?? check.status ?? '').toUpperCase())
  if (verdicts.some((v) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(v)))
    return 'failing'
  if (verdicts.some((v) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', ''].includes(v)))
    return 'pending'
  return 'passing'
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** The branch's existing pull/merge request, or null. Never throws: "we don't
 *  know" must not turn into a failed tool call. */
async function readPullRequest(dir: string, branch: string, forge: Forge): Promise<PullRequest | null> {
  if (forge === 'github') {
    const { stdout, failure } = await runForge(forge, dir, [
      'pr',
      'view',
      branch,
      '--json',
      'number,url,title,state,isDraft,statusCheckRollup',
    ])
    if (failure) return null
    const pr = parseJson<{
      number?: number
      url?: string
      title?: string
      state?: string
      isDraft?: boolean
      statusCheckRollup?: Array<{ state?: string; conclusion?: string; status?: string }>
    }>(stdout)
    if (!pr || typeof pr.number !== 'number' || !pr.url) return null
    const raw = (pr.state ?? 'OPEN').toUpperCase()
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title ?? '',
      state: raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open',
      checks: rollupChecks(pr.statusCheckRollup),
    }
  }
  const { stdout, failure } = await runForge(forge, dir, ['mr', 'list', '--source-branch', branch, '--output', 'json'])
  if (failure) return null
  const list = parseJson<
    Array<{
      iid?: number
      web_url?: string
      title?: string
      state?: string
      draft?: boolean
      work_in_progress?: boolean
      pipeline?: { status?: string } | null
    }>
  >(stdout)
  const mr = Array.isArray(list) ? list[0] : null
  if (!mr || typeof mr.iid !== 'number' || !mr.web_url) return null
  const raw = (mr.state ?? 'opened').toLowerCase()
  const pipeline = mr.pipeline?.status?.toLowerCase()
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title ?? '',
    state:
      raw === 'merged'
        ? 'merged'
        : raw === 'closed' || raw === 'locked'
          ? 'closed'
          : mr.draft || mr.work_in_progress
            ? 'draft'
            : 'open',
    checks: !pipeline
      ? null
      : ['failed', 'canceled'].includes(pipeline)
        ? 'failing'
        : ['success', 'manual'].includes(pipeline)
          ? 'passing'
          : 'pending',
  }
}

/**
 * ── The tools ────────────────────────────────────────────────────────────────
 *
 **/

const gitBranch = defineHoshiTool({
  description: [
    "Create (or switch to) the working branch for a change you are about to propose, named by Hoshi's `hoshi/<slug>` convention.",
    'Call this BEFORE editing files, whenever the work is meant to end in a pull request — never commit onto main/master.',
    'Idempotent: calling it twice, or for a branch that already exists, just switches to it. Uncommitted work carries over.',
  ].join(' '),
  args: {
    slug: z
      .string()
      .optional()
      .describe('What the change is about (a ticket key or short title) — becomes hoshi/<slug>'),
    name: z.string().optional().describe('An exact branch name to use instead of the hoshi/ convention'),
  },
  async execute(args, context): Promise<HoshiToolResult> {
    const dir = await repoDir(context)
    const name = args.name?.trim() || (args.slug?.trim() ? sessionBranchName(args.slug.trim()) : '')
    if (!name) throw new Error('Pass either a slug to derive the branch name from, or an exact name.')
    if (!isValidBranchName(name)) throw new Error(`"${name}" is not a valid git branch name.`)

    const current = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let created = false
    if (current !== name) {
      const exists = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
        .then((out) => out.trim() !== '')
        .catch(() => false)
      try {
        await git(dir, exists ? ['switch', name] : ['switch', '-c', name])
      } catch (error) {
        throw new Error(`Could not switch to "${name}": ${tail(failureOf(error).stderr)}`)
      }
      created = !exists
    }
    const { base } = await branchInfo(dir)
    return {
      title: name,
      output: `${created ? 'Created and switched to' : 'On'} branch ${name}${base ? ` (base: ${base})` : ''}. Make your changes, then call git_commit.`,
      metadata: { hoshi: { git: { action: 'branch', branch: name, base, created } } },
    }
  },
})

const gitCommit = defineHoshiTool({
  description: [
    "Stage and commit the current changes on the working branch, authored with the account's own git identity.",
    'Write the message yourself: a real subject line describing what changed and why, not a diff dump.',
    'Refuses to commit onto main/master — call git_branch first.',
  ].join(' '),
  args: {
    message: z.string().describe('The full commit message (subject line, optionally a blank line and body)'),
    paths: z
      .array(z.string())
      .optional()
      .describe('Only stage these paths (default: everything changed in the worktree)'),
  },
  async execute(args, context): Promise<HoshiToolResult> {
    const dir = await repoDir(context)
    const message = args.message.trim()
    if (!message) throw new Error('A commit message is required.')

    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (TRUNK_BRANCHES.has(branch)) {
      throw new Error(
        `Refusing to commit directly onto "${branch}" — call git_branch first to propose the change on its own branch.`,
      )
    }
    const [name, email] = await Promise.all([
      git(dir, ['config', '--get', 'user.name']).catch(() => ''),
      git(dir, ['config', '--get', 'user.email']).catch(() => ''),
    ])
    if (!name.trim() || !email.trim()) {
      throw new Error(
        'This machine has no git author identity yet. Tell the user to set their name and email in Settings → Git Identity, then stop — do not configure it yourself.',
      )
    }

    try {
      await git(dir, args.paths?.length ? ['add', '--', ...args.paths] : ['add', '--all'])
    } catch (error) {
      throw new Error(`Could not stage the change: ${tail(failureOf(error).stderr)}`)
    }
    if (!(await git(dir, ['diff', '--cached', '--name-only'])).trim()) {
      throw new Error('There is nothing to commit — the working tree is clean.')
    }
    try {
      await git(dir, ['commit', '--message', message])
    } catch (error) {
      throw new Error(`git commit failed: ${tail(failureOf(error).stderr)}`)
    }

    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const { base } = await branchInfo(dir)
    const commits = await branchCommits(dir, base)
    const files = (await git(dir, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n').filter(Boolean)
    return {
      title: `${sha.slice(0, 7)} ${message.split('\n')[0]}`,
      output: `Committed ${sha.slice(0, 7)} on ${branch} (${files.length} file${files.length === 1 ? '' : 's'}). The branch now has ${commits.length} commit${commits.length === 1 ? '' : 's'} over ${base ?? 'its base'}. When the change is complete, call git_pr to open a pull request.`,
      metadata: {
        hoshi: {
          git: { action: 'commit', branch, base, sha, shortSha: sha.slice(0, 7), files, commits },
        },
      },
    }
  },
})

const gitPr = defineHoshiTool({
  description: [
    'Push the working branch and open a pull request (GitHub) or merge request (GitLab) for it, then show the user a card with its link.',
    'This is how a finished change is handed back — call it once the work is committed and you would otherwise say "I\'m done".',
    'Write a title and body that explain the change and why, and link the originating ticket if one drove the work.',
    'If the branch already has an open pull request, this returns that one instead of opening a second.',
  ].join(' '),
  args: {
    title: z.string().describe('Pull request title — a clear one-line summary of the change'),
    body: z
      .string()
      .optional()
      .describe('Pull request description in markdown: what changed, why, and anything a reviewer should check'),
    base: z.string().optional().describe("Target branch (default: the repo's default branch)"),
    draft: z.boolean().optional().describe('Open it as a draft (default: false)'),
  },
  async execute(args, context): Promise<HoshiToolResult> {
    const dir = await repoDir(context)
    const { branch, base: detectedBase } = await branchInfo(dir)
    if (TRUNK_BRANCHES.has(branch)) {
      throw new Error(
        `"${branch}" is the trunk — a pull request has to come from a working branch. Call git_branch first.`,
      )
    }
    const remote = await remoteInfo(dir)
    if (!remote)
      throw new Error('This repository has no git remote, so there is nowhere to push a branch or open a pull request.')
    if (!remote.forge) {
      throw new Error(
        `Hoshi can open pull requests on GitHub and GitLab; ${remote.host} is neither. Push the branch and open it manually, or tell the user.`,
      )
    }
    const base = args.base?.trim() || detectedBase
    if (!base) throw new Error('This repository has no default branch to open a pull request against.')
    if (base === branch) throw new Error('A pull request cannot target the branch it comes from.')

    await pushBranch(dir, branch, remote)

    const existing = await readPullRequest(dir, branch, remote.forge)
    const commits = await branchCommits(dir, base)
    if (existing && existing.state !== 'closed') {
      return {
        title: `#${existing.number} ${existing.title}`,
        output: `Branch ${branch} already has an open ${remote.forge === 'github' ? 'pull' : 'merge'} request — pushed the new commits to it: ${existing.url}. A user watching this session sees it as a card, so don't repeat the link to them — but DO include it if you're reporting back to an inbound Slack/Linear/GitHub thread, where your final message is all the requester gets.`,
        metadata: {
          hoshi: {
            git: {
              action: 'pr',
              branch,
              base,
              remote: remote.slug,
              forge: remote.forge,
              commits,
              pr: existing,
              created: false,
            },
          },
        },
      }
    }

    const body = args.body ?? ''
    const createArgs =
      remote.forge === 'github'
        ? [
            'pr',
            'create',
            '--head',
            branch,
            '--base',
            base,
            '--title',
            args.title,
            '--body',
            body,
            ...(args.draft ? ['--draft'] : []),
          ]
        : [
            'mr',
            'create',
            '--source-branch',
            branch,
            '--target-branch',
            base,
            '--title',
            args.title,
            '--description',
            body,
            '--yes',
            ...(args.draft ? ['--draft'] : []),
          ]
    const { failure } = await runForge(remote.forge, dir, createArgs)
    if (failure) throw new Error(forgeErrorMessage(remote.forge, failure))

    const pr = await readPullRequest(dir, branch, remote.forge)
    if (!pr) {
      throw new Error(
        `${FORGE_CLI[remote.forge]} reported success but the ${remote.forge === 'github' ? 'pull' : 'merge'} request could not be read back.`,
      )
    }
    return {
      title: `#${pr.number} ${pr.title}`,
      output: `Opened ${remote.forge === 'github' ? 'pull request' : 'merge request'} #${pr.number} on ${remote.slug}: ${pr.url}. A user watching this session sees it as a card, so don't repeat the link or re-describe the change to them — but DO include it if you're reporting back to an inbound Slack/Linear/GitHub thread, where your final message is all the requester gets.`,
      metadata: {
        hoshi: {
          git: { action: 'pr', branch, base, remote: remote.slug, forge: remote.forge, commits, pr, created: true },
        },
      },
    }
  },
})

export const gitTools: HoshiToolFactories = {
  git_branch: gitBranch,
  git_commit: gitCommit,
  git_pr: gitPr,
}
