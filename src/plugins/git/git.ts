import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { apiError, publishMachineEvent, readSecretValue, isCheckoutDir, workspaceRoot } from '../../kernel/index.js'
import {
  CI_LOG_TAIL_CHARS,
  CI_LOG_TAIL_LINES,
  ciWatchFor,
  recordAgentCommit,
  registerCiWatch,
  type CiForgeAccess,
  type CiWatch,
} from './ci-loop.js'
import { ports } from './host.js'
import { execFailure, FORGE_CLI, FORGE_TOKEN_KEYS, rollupChecks } from './forge-shapes.js'
import type { ExecFailure, GhPullRequest, GlabMergeRequest } from './forge-shapes.js'
import { ghToPullRequest, glabProjectPath, glabToPullRequest, logTail, parseJson, runForgeCli } from './forge-cli.js'
import {
  git,
  gitBranchInfo,
  gitDiffSummary,
  MAX_COMMITS,
  resolveGitDir,
  TRUNK_BRANCHES,
  tail,
  execFileAsync,
  GIT_MAX_BUFFER,
  NETWORK_TIMEOUT_MS,
} from './exec.js'
import { publishGitChanged } from './events.js'
import { gitRemote, isValidBranchName, requireForge, requireRemote } from './remote.js'
import type {
  GitCommitSummary,
  GitForge,
  GitPullRequest,
  GitPullRequestState,
  GitRemoteInfo,
  GitStatus,
} from './types.js'

/**
 * ── Status ───────────────────────────────────────────────────────────────────
 *
 **/

/** `git status --porcelain` counted, not listed: the review surface already has
 *  the file list from the diff route; what it needs here is "is there anything
 *  uncommitted", broken down enough to say so precisely. */
async function gitDirtyCounts(dir: string): Promise<GitStatus['dirty']> {
  const raw = await git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of raw.split('\n')) {
    if (line.length < 3) continue
    if (line.startsWith('??')) untracked++
    else {
      if (line[0] !== ' ') staged++
      if (line[1] !== ' ') unstaged++
    }
  }
  return { staged, unstaged, untracked }
}

/** The branch's own commits, newest first. `%x1f`/`%x1e` (unit/record
 *  separators) delimit the fields so a subject containing any printable
 *  character can never split a row. */
async function gitCommits(dir: string, range: string): Promise<GitCommitSummary[]> {
  const raw = await git(dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e', range])
  const commits: GitCommitSummary[] = []
  for (const record of raw.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\x1f')
    if (fields.length < 5 || !fields[0]) continue
    commits.push({ sha: fields[0]!, shortSha: fields[1]!, subject: fields[2]!, author: fields[3]!, date: fields[4]! })
  }
  return commits
}

async function gitAheadBehind(dir: string, base: string, branch: string): Promise<{ ahead: number; behind: number }> {
  try {
    const raw = await git(dir, ['rev-list', '--left-right', '--count', `${base}...${branch}`])
    const [behind, ahead] = raw.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    /**
     *
     * An unborn HEAD (a fresh `git init` with no commit) has no revision range.
     *
     **/
    return { ahead: 0, behind: 0 }
  }
}

async function branchIsPushed(dir: string, remote: GitRemoteInfo | null, branch: string): Promise<boolean> {
  if (!remote) return false
  try {
    return (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote.name}/${branch}`])).trim() !== ''
  } catch {
    return false
  }
}

/** Everything the review surface needs about the working branch in one read.
 *  `withPr` is opt-in because it costs a forge round-trip — the panel asks for
 *  it, the event-driven refreshes don't. */
export async function gitStatus(dir: string, options: { withPr?: boolean } = {}): Promise<GitStatus> {
  const { branch, base } = await gitBranchInfo(dir)
  const remote = await gitRemote(dir)
  const [dirty, commits, aheadBehind, pushed] = await Promise.all([
    gitDirtyCounts(dir),
    base ? gitCommits(dir, `${base}..HEAD`) : Promise.resolve([]),
    base ? gitAheadBehind(dir, base, 'HEAD') : Promise.resolve({ ahead: 0, behind: 0 }),
    branchIsPushed(dir, remote, branch),
  ])
  const pr = options.withPr && remote?.forge ? await readPullRequest(dir, branch, remote) : null
  return { branch, base, ...aheadBehind, dirty, commits, remote, pushed, pr, ci: await ciWatchFor(dir, branch) }
}

/**
 * ── Branch ───────────────────────────────────────────────────────────────────
 *
 **/

/** Create (or switch to) the working branch for a proposed change. Idempotent
 *  on purpose: an agent that calls this twice in a turn should land on the same
 *  branch, not fail. Branching happens off the CURRENT head, so uncommitted
 *  work carries over exactly as `git switch -c` would. */
export async function gitCreateBranch(dir: string, name: string): Promise<{ branch: string; created: boolean }> {
  if (!isValidBranchName(name)) {
    apiError(400, 'git.branchInvalid', `"${name}" is not a valid git branch name.`, { branch: name })
  }
  const current = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (current === name) return { branch: name, created: false }

  const exists = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    .then((out) => out.trim() !== '')
    .catch(() => false)
  try {
    await git(dir, exists ? ['switch', name] : ['switch', '-c', name])
  } catch (error) {
    const failure = execFailure(error)
    apiError(409, 'git.branchFailed', `Could not switch to "${name}": ${tail(failure.stderr)}`, { branch: name })
  }
  publishGitChanged(dir)
  return { branch: name, created: !exists }
}

/**
 * ── Commit ───────────────────────────────────────────────────────────────────
 *
 **/

/** The identity a commit will be attributed to. Resolved from git's own config
 *  — which utils/git-identity.ts populates machine-wide from the account's Git
 *  Identity — so there is exactly one identity source on the machine. */
async function gitIdentity(dir: string): Promise<{ name: string; email: string } | null> {
  const read = async (key: string) => (await git(dir, ['config', '--get', key]).catch(() => '')).trim()
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return name && email ? { name, email } : null
}

/** Stage and commit. The MESSAGE IS THE CALLER'S — this never invents one; an
 *  agent that has just made the change is the only thing here that knows what
 *  it did. `paths` narrows what gets staged; omitted, everything tracked and
 *  untracked in the worktree goes in, which is what "commit my work" means. */
export async function gitCommit(
  dir: string,
  message: string,
  paths?: string[],
): Promise<{ sha: string; shortSha: string; branch: string }> {
  const identity = await gitIdentity(dir)
  if (!identity) {
    apiError(
      409,
      'git.identityMissing',
      'This machine has no git author identity yet — set your name and email in Settings → Git Identity.',
    )
  }
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (TRUNK_BRANCHES.has(branch)) {
    apiError(409, 'git.trunkBranch', `Refusing to commit directly onto "${branch}" — create a branch first.`, {
      branch,
    })
  }

  try {
    await git(dir, paths?.length ? ['add', '--', ...paths] : ['add', '--all'])
  } catch (error) {
    apiError(409, 'git.stageFailed', `Could not stage the change: ${tail(execFailure(error).stderr)}`)
  }

  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) {
    apiError(409, 'git.nothingToCommit', 'There is nothing to commit — the working tree is clean.')
  }

  try {
    await git(dir, ['commit', '--message', message])
  } catch (error) {
    apiError(409, 'git.commitFailed', `git commit failed: ${tail(execFailure(error).stderr)}`)
  }
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  /**
   *
   * The closed loop's provenance record. Every commit that goes through this
   * function is one the AGENT made — the `git_commit` tool and the Changes
   * panel both land here — so this is the one place the fact is certain. A
   * commit made by shelling out to raw `git` is deliberately NOT recorded: it
   * reads later as a human push and stops the loop, which is the safe way to be
   * wrong (utils/ci-loop.ts, guard 2).
   *
   **/
  await recordAgentCommit(dir, branch, sha)
  publishGitChanged(dir)
  return { sha, shortSha: sha.slice(0, 7), branch }
}

/**
 * ── Push ─────────────────────────────────────────────────────────────────────
 *
 **/

/** Feed git a credential without it ever touching disk, the URL, or argv: a
 *  one-shot credential helper that echoes the token straight out of the child
 *  process's own environment. `ps` sees the helper script, never the secret.
 *  Only used for https remotes — a git@ remote rides the machine's ambient SSH
 *  identity, exactly as a clone does.
 *
 *  Exported for the test that drives it through `git credential fill`: this is
 *  the one line standing between a vault token and a plaintext leak, and a typo
 *  in it would fail open (git prompts, the push hangs or 401s) rather than
 *  loudly. */
export const GIT_CREDENTIAL_HELPER = '!f() { echo "username=x-access-token"; echo "password=$HOSHI_FORGE_TOKEN"; }; f'

/** The full `-c` pair, and the empty reset is not optional. Credential helpers
 *  are a LIST consulted in config order, and the system/global config wins over
 *  `-c` — so on any machine that already has one configured (a keychain helper,
 *  a `store` file some tool wrote), that helper answers first and OUR vault
 *  token is never used. Found live: on a developer's macOS box the system
 *  gitconfig's osxkeychain helper answered with a completely different
 *  account's token. `credential.helper=` with an empty value resets the list,
 *  so what follows is the only helper git will ask. */
export const gitCredentialArgs = (): string[] => [
  '-c',
  'credential.helper=',
  '-c',
  `credential.helper=${GIT_CREDENTIAL_HELPER}`,
]

function classifyPushFailure(stderr: string): never {
  const text = stderr.toLowerCase()
  if (/protected branch|pre-receive hook declined|gh006|refusing to allow/.test(text)) {
    apiError(409, 'git.protectedBranch', `The remote refused the push: the branch is protected. ${tail(stderr)}`)
  }
  if (/non-fast-forward|fetch first|updates were rejected|behind its remote/.test(text)) {
    apiError(
      409,
      'git.notFastForward',
      `The remote branch has commits this one doesn't — pull or rebase before pushing again. ${tail(stderr)}`,
    )
  }
  if (
    /permission denied|authentication failed|could not read username|403|invalid username or password|access denied/.test(
      text,
    )
  ) {
    apiError(
      401,
      'git.noCredential',
      `The remote rejected this machine's credentials. Add your SSH key in Settings → Git Identity, or a forge token in Customize → Secrets. ${tail(stderr)}`,
    )
  }
  apiError(502, 'git.pushFailed', `git push failed: ${tail(stderr)}`)
}

/** Push the branch and set its upstream. Returns the remote it went to. */
export async function gitPush(dir: string, branch: string, remote: GitRemoteInfo): Promise<void> {
  const token = remote.forge ? await forgeToken(remote.forge) : null
  const https = remote.url.startsWith('http://') || remote.url.startsWith('https://')
  const args = [...(https && token ? gitCredentialArgs() : []), 'push', '--set-upstream', remote.name, branch]
  try {
    await execFileAsync('git', args, {
      cwd: dir,
      timeout: NETWORK_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, ...(https && token ? { HOSHI_FORGE_TOKEN: token } : {}), GIT_TERMINAL_PROMPT: '0' },
    })
  } catch (error) {
    const failure = execFailure(error)
    classifyPushFailure(failure.stderr || failure.stdout)
  }
  publishGitChanged(dir)
}

/**
 * ── Forge (gh / glab) ────────────────────────────────────────────────────────
 *
 **/

/** The forge token this machine already holds, out of the vault. Returns null
 *  when the user hasn't set one — which is fine when the CLI carries its own
 *  device-code login (`gh auth login`), and fatal only when neither exists. */
async function forgeToken(forge: GitForge): Promise<string | null> {
  for (const key of FORGE_TOKEN_KEYS[forge]) {
    const value = (await readSecretValue(key))?.trim()
    if (value) return value
    const fromEnv = process.env[key]?.trim()
    if (fromEnv) return fromEnv
  }
  return null
}

function forgeFailure(forge: GitForge, failure: ExecFailure): never {
  const cli = FORGE_CLI[forge]
  if (failure.missing) {
    apiError(501, 'git.cliMissing', `The ${cli} CLI isn't installed on this machine.`, { cli })
  }
  const text = `${failure.stderr}\n${failure.stdout}`.toLowerCase()
  if (/auth|token|401|credential|not logged|unauthorized|permission|403/.test(text)) {
    /**
     *
     * Distinct from `git.noCredential` (the PUSH rejecting this machine's SSH
     * identity) on purpose: the fix is a different one — the forge CLI's own
     * device-code login, or a vault token — and a shared code would have to
     * name both remedies vaguely enough to help with neither.
     *
     **/
    apiError(
      401,
      'git.forgeNotAuthenticated',
      `${cli} isn't authenticated for this repository. Run \`${cli} auth login\` on this machine, or add a token in Customize → Secrets.`,
      { cli },
    )
  }
  apiError(502, 'git.prFailed', `${cli} failed: ${tail(failure.stderr || failure.stdout)}`, { cli })
}

/** The pull/merge request for a branch, if one exists. ON DEMAND ONLY — PR
 *  state lives on the forge, not on this machine, so it is fetched when the
 *  panel is open and never polled. A CLI that can't answer (not installed, not
 *  authenticated, no PR) resolves to null rather than failing the whole status
 *  read: "we don't know" must not break the branch view. */
async function readPullRequest(dir: string, branch: string, remote: GitRemoteInfo): Promise<GitPullRequest | null> {
  const forge = remote.forge
  if (!forge) return null
  const token = await forgeToken(forge)
  if (forge === 'github') {
    const { stdout, failure } = await runForgeCli(
      forge,
      dir,
      ['pr', 'view', branch, '--json', 'number,url,title,state,isDraft,statusCheckRollup'],
      token,
    )
    if (failure) return null
    const parsed = parseJson<GhPullRequest>(stdout)
    return parsed ? ghToPullRequest(parsed) : null
  }
  const { stdout, failure } = await runForgeCli(
    forge,
    dir,
    ['mr', 'list', '--source-branch', branch, '--output', 'json'],
    token,
  )
  if (failure) return null
  const list = parseJson<GlabMergeRequest[]>(stdout)
  const first = Array.isArray(list) ? list[0] : null
  return first ? glabToPullRequest(first) : null
}

export interface OpenPullRequestInput {
  title: string
  body: string
  /** Target branch; defaults to the repo's detected base. */
  base?: string
  draft?: boolean
}

/** Push the branch and open a pull/merge request for it. The one call that
 *  crosses from "a proposal on this machine" to "a thing a team can review".
 *  Returns the existing PR untouched when the branch already has one — opening
 *  a second PR for the same branch is never what the caller meant. */
export async function openPullRequest(
  dir: string,
  input: OpenPullRequestInput,
): Promise<{ pr: GitPullRequest; branch: string; created: boolean }> {
  const { branch, base: detectedBase } = await gitBranchInfo(dir)
  if (TRUNK_BRANCHES.has(branch)) {
    apiError(409, 'git.trunkBranch', `"${branch}" is the trunk — open a pull request from a working branch.`, {
      branch,
    })
  }
  const remote = requireRemote(await gitRemote(dir))
  const forge = requireForge(remote)
  const base = input.base ?? detectedBase
  if (!base) {
    apiError(409, 'git.noBase', 'This repository has no default branch to open a pull request against.')
  }
  if (base === branch) {
    apiError(409, 'git.baseIsBranch', `A pull request cannot target "${branch}", the branch it comes from.`, { branch })
  }

  await gitPush(dir, branch, remote)

  const existing = await readPullRequest(dir, branch, remote)
  if (existing && existing.state !== 'closed') {
    await watchCi(dir, branch, remote, existing)
    publishGitChanged(dir)
    return { pr: existing, branch, created: false }
  }

  const token = await forgeToken(forge)
  const args =
    forge === 'github'
      ? [
          'pr',
          'create',
          '--head',
          branch,
          '--base',
          base,
          '--title',
          input.title,
          '--body',
          input.body,
          ...(input.draft ? ['--draft'] : []),
        ]
      : [
          'mr',
          'create',
          '--source-branch',
          branch,
          '--target-branch',
          base,
          '--title',
          input.title,
          '--description',
          input.body,
          '--yes',
          ...(input.draft ? ['--draft'] : []),
        ]
  const { failure } = await runForgeCli(forge, dir, args, token)
  if (failure) forgeFailure(forge, failure)

  const pr = await readPullRequest(dir, branch, remote)
  if (!pr) {
    apiError(502, 'git.prFailed', `${FORGE_CLI[forge]} reported success but no pull request could be read back.`, {
      cli: FORGE_CLI[forge],
    })
  }
  await watchCi(dir, branch, remote, pr)
  publishGitChanged(dir)
  return { pr, branch, created: true }
}

/**
 * ── Closed-loop CI: registration ─────────────────────────────────────────────
 *
 * Opening a pull request is the moment "this machine owns this branch" becomes
 * true, so it is the moment both ledgers are written: the local one (the loop's
 * own state) and the Platform's routing table, which is the only thing that can
 * turn an inbound `workflow_run` webhook into a call on THIS machine.
 *
 * Both are best-effort. A machine with no Platform behind it (local dev, a
 * `static` machine) simply never receives CI verdicts, and a Platform hiccup
 * must never fail the pull request the user just asked for — the next
 * `git_pr` call registers again.
 *
 **/

const CI_REGISTER_TIMEOUT_MS = 8_000

async function watchCi(dir: string, branch: string, remote: GitRemoteInfo, pr: GitPullRequest): Promise<void> {
  const forge = remote.forge
  if (!forge) return
  const headSha = await git(dir, ['rev-parse', 'HEAD'])
    .then((out) => out.trim())
    .catch(() => null)

  try {
    await registerCiWatch({
      forge,
      repo: remote.slug,
      branch,
      directory: dir,
      prNumber: pr.number,
      prUrl: pr.url,
      headSha,
    })
  } catch (error) {
    console.error(`[git] could not record the CI watch for ${remote.slug}#${pr.number}:`, error)
    return
  }

  const env = ports().platform?.()
  if (!env?.machineId) return
  try {
    const res = await fetch(`${env.platformUrl}/machines/${encodeURIComponent(env.machineId)}/ci-watches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
      /**
       *
       * `forge` and the pack id coincide by construction — 'github' and
       * 'gitlab' are both. The Platform re-checks it against its own registry.
       *
       **/
      body: JSON.stringify({ provider: forge, repo: remote.slug, branch, prNumber: pr.number, prUrl: pr.url }),
      signal: AbortSignal.timeout(CI_REGISTER_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Platform answered ${res.status}.`)
  } catch (error) {
    console.error(`[git] registering ${remote.slug}#${pr.number} for CI verdicts failed:`, error)
  }
}

/**
 * ── Closed-loop CI: reading and rerunning a forge run ────────────────────────
 *
 * The two forge operations the loop needs, kept here rather than in ci-loop.ts
 * because this file owns every `gh`/`glab` invocation on the machine — and
 * injected into the loop rather than imported by it, so the loop's guards stay
 * testable without a forge (utils/ci-loop.ts CiForgeAccess).
 *
 **/

interface GlabJob {
  id?: number
  name?: string
  status?: string
}

export const forgeCiAccess: CiForgeAccess = {
  async failingLog(watch: CiWatch, runId: string | null): Promise<string | null> {
    if (!runId) return null
    const token = await forgeToken(watch.forge)
    if (watch.forge === 'github') {
      const { stdout, failure } = await runForgeCli(
        'github',
        watch.directory,
        ['run', 'view', runId, '--repo', watch.repo, '--log-failed'],
        token,
      )
      return failure ? null : logTail(stdout)
    }

    /**
     *
     * GitLab has no "just give me the failing log" verb, so it takes two calls:
     * find the failed job in the pipeline, then read its trace.
     *
     **/
    const project = glabProjectPath(watch.repo)
    const jobs = await runForgeCli(
      'gitlab',
      watch.directory,
      ['api', `projects/${project}/pipelines/${runId}/jobs?per_page=100`],
      token,
    )
    if (jobs.failure) return null
    const failed = (parseJson<GlabJob[]>(jobs.stdout) ?? []).find((job) => job.status === 'failed')
    if (!failed?.id) return null
    const trace = await runForgeCli(
      'gitlab',
      watch.directory,
      ['api', `projects/${project}/jobs/${failed.id}/trace`],
      token,
    )
    return trace.failure ? null : logTail(trace.stdout)
  },

  async rerun(watch: CiWatch, runId: string | null): Promise<boolean> {
    if (!runId) return false
    const token = await forgeToken(watch.forge)
    const args =
      watch.forge === 'github'
        ? ['run', 'rerun', runId, '--repo', watch.repo, '--failed']
        : ['api', '--method', 'POST', `projects/${glabProjectPath(watch.repo)}/pipelines/${runId}/retry`]
    const { failure } = await runForgeCli(watch.forge, watch.directory, args, token)
    return !failure
  },
}
