import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 *
 * The propose → review → land path, driven end to end against REAL git: a bare
 * repo standing in for the forge, a clone standing in for a checkout, and a
 * stub `gh` on PATH speaking the exact JSON contract the real one does. Every
 * assertion below is about behaviour no unit test can reach — that a branch is
 * really created, a commit really lands with the resolved identity, a push
 * really updates the remote, and that each way this can fail comes back as its
 * own stable `git.*` code rather than a wall of stderr.
 *
 * The remote URL reads as `https://github.com/acme/widgets.git` (so forge
 * detection, the repo slug and `gh` selection are the real code paths), while a
 * git `insteadOf` rewrite in the scratch global config sends the actual bytes
 * to the bare repo next door. Nothing here touches the network or the
 * developer's own git config: GIT_CONFIG_GLOBAL/SYSTEM are redirected, so the
 * identity assertions can't be masked by whatever is in ~/.gitconfig. HOME is
 * redirected for the same reason — `openPullRequest` and `gitCommit` now write
 * the closed-loop CI ledger into ~/.hoshi (job 14), and a suite that wrote test
 * watches into a developer's real one could quietly stop a live fix loop.
 *
 **/

const execFileAsync = promisify(execFile)

const REMOTE_URL = 'https://github.com/acme/widgets.git'

let scratch: string
let bare: string
let repo: string
let ghState: string
const originalHome = process.env.HOME

/** Loaded after the environment is redirected — ./git.ts reaches
 *  kernel/secrets.ts, which resolves the machine's config dir at module load.
 *
 *  Four handles because the plugin is four modules: the git runner and the
 *  read-only queries (`exec`), remote/forge resolution and branch naming
 *  (`remote`), the change key the watcher reads (`events`), and the
 *  propose→review→land flow itself (`git`). */
let git: typeof import('./git.js')
let exec: typeof import('./exec.js')
let remotes: typeof import('./remote.js')
let events: typeof import('./events.js')
let ciLoop: typeof import('./ci-loop.js')

async function run(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd })
  return stdout
}

async function commitFile(name: string, content: string): Promise<void> {
  await writeFile(path.join(repo, name), content)
  await run(repo, 'git', ['add', '--all'])
  await run(repo, 'git', ['commit', '--message', `add ${name}`])
}

/** A `gh` that answers the two subcommands the PR path actually uses, backed by
 *  a JSON file so `pr create` is visible to the `pr view` that follows it. */
const GH_STUB = `#!/bin/sh
state="$HOSHI_TEST_GH_STATE"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  shift 2
  title=""
  while [ $# -gt 0 ]; do
    case "$1" in --title) title="$2"; shift 2 ;; *) shift ;;
  esac
  done
  printf '{"number":42,"url":"https://github.com/acme/widgets/pull/42","title":"%s","state":"OPEN","isDraft":false,"statusCheckRollup":[{"conclusion":"SUCCESS"}]}' "$title" > "$state"
  echo "https://github.com/acme/widgets/pull/42"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ -s "$state" ] || { echo "no pull requests found" >&2; exit 1; }
  cat "$state"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'hoshi-git-flow-'))
  bare = path.join(scratch, 'remote.git')
  repo = path.join(scratch, 'checkout')
  ghState = path.join(scratch, 'gh-pr.json')

  /**
   *
   * Hermetic git: no ~/.gitconfig, no system config, and the URL rewrite that
   * makes a GitHub-shaped remote push into the bare repo beside it.
   *
   **/
  const globalConfig = path.join(scratch, 'gitconfig')
  await writeFile(
    globalConfig,
    ['[url "' + bare + '"]', `\tinsteadOf = ${REMOTE_URL}`, '[init]', '\tdefaultBranch = main', ''].join('\n'),
  )
  process.env.HOME = path.join(scratch, 'home')
  await mkdir(process.env.HOME, { recursive: true })
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_TERMINAL_PROMPT = '0'

  const bin = path.join(scratch, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(path.join(bin, 'gh'), GH_STUB)
  await chmod(path.join(bin, 'gh'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.HOSHI_TEST_GH_STATE = ghState
  /**
   *
   * Keep the vault out of it: utils/secrets.ts would otherwise read the
   * developer's own ~/.config/opencode/.env looking for a forge token.
   *
   **/
  process.env.OPENCODE_CONFIG_DIR = path.join(scratch, 'opencode-config')

  git = await import('./git.js')
  exec = await import('./exec.js')
  remotes = await import('./remote.js')
  events = await import('./events.js')
  ciLoop = await import('./ci-loop.js')

  await run(scratch, 'git', ['init', '--bare', '--initial-branch=main', bare])
  await run(scratch, 'git', ['clone', bare, repo])
  await run(repo, 'git', ['config', 'user.name', 'Hoshi Test'])
  await run(repo, 'git', ['config', 'user.email', 'test@hoshi.invalid'])
  await commitFile('README.md', '# widgets\n')
  await run(repo, 'git', ['push', '--set-upstream', 'origin', 'main'])
  await run(repo, 'git', ['remote', 'set-url', 'origin', REMOTE_URL])
})

afterAll(async () => {
  /**
   *
   * The CI ledger persists fire-and-forget (utils/json-store.ts), so let the
   * last write land before its scratch HOME disappears underneath it.
   *
   * Optional because `ciLoop` is imported IN the setup hook: when that hook
   * fails, this one runs anyway against a half-built fixture and threw
   * `Cannot read properties of undefined (reading 'flushCiLedger')` on top of
   * the real error — which is what a reader saw first, and is about this file
   * rather than about what broke.
   *
   **/
  await ciLoop?.flushCiLedger()
  process.env.HOME = originalHome
  await rm(scratch, { recursive: true, force: true })
})

/** The stable `git.*` code out of a thrown apiError. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return '<no error>'
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? `<uncoded: ${(error as Error).message}>`
  }
}

describe('the proposed-change lifecycle', () => {
  it('reads a clean trunk as having nothing proposed', async () => {
    const status = await git.gitStatus(repo)
    expect(status.branch).toBe('main')
    expect(status.commits).toEqual([])
    expect(status.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 })
    expect(status.remote).toMatchObject({ slug: 'acme/widgets', forge: 'github', url: REMOTE_URL })
  })

  it('refuses to commit onto the trunk', async () => {
    await writeFile(path.join(repo, 'feature.txt'), 'work\n')
    expect(await codeOf(git.gitCommit(repo, 'sneak onto main'))).toBe('git.trunkBranch')
  })

  it('branches, commits, and reports the proposal', async () => {
    const created = await git.gitCreateBranch(repo, remotes.sessionBranchName('Add a widget'))
    expect(created).toEqual({ branch: 'hoshi/add-a-widget', created: true })

    const commit = await git.gitCommit(repo, 'feat: add a widget')
    expect(commit.branch).toBe('hoshi/add-a-widget')
    expect(commit.shortSha).toHaveLength(7)

    const status = await git.gitStatus(repo)
    expect(status.branch).toBe('hoshi/add-a-widget')
    expect(status.base).toBe('main')
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(0)
    expect(status.pushed).toBe(false)
    expect(status.commits.map((c) => c.subject)).toEqual(['feat: add a widget'])
    expect(status.commits[0]!.author).toBe('Hoshi Test')
    /**
     *
     * The working tree is clean again — the commit really took the change.
     *
     **/
    expect(status.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 })
  })

  it('switching to an existing branch is idempotent, not a conflict', async () => {
    expect(await git.gitCreateBranch(repo, 'hoshi/add-a-widget')).toEqual({
      branch: 'hoshi/add-a-widget',
      created: false,
    })
  })

  it('says so plainly when there is nothing to commit', async () => {
    expect(await codeOf(git.gitCommit(repo, 'nothing here'))).toBe('git.nothingToCommit')
  })

  it('pushes the branch and opens a real pull request', async () => {
    const opened = await git.openPullRequest(repo, { title: 'Add a widget', body: 'Because widgets.' })
    expect(opened.created).toBe(true)
    expect(opened.branch).toBe('hoshi/add-a-widget')
    expect(opened.pr).toEqual({
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      title: 'Add a widget',
      state: 'open',
      checks: 'passing',
    })

    /**
     *
     * The push really happened: the bare repo now carries the branch.
     *
     **/
    const refs = await run(scratch, 'git', ['--git-dir', bare, 'branch', '--list'])
    expect(refs).toContain('hoshi/add-a-widget')

    const status = await git.gitStatus(repo, { withPr: true })
    expect(status.pushed).toBe(true)
    expect(status.pr?.number).toBe(42)
  })

  it('returns the existing pull request instead of opening a second', async () => {
    const again = await git.openPullRequest(repo, { title: 'Add a widget (again)', body: '' })
    expect(again.created).toBe(false)
    expect(again.pr.number).toBe(42)
  })

  it('starts watching the branch for CI verdicts, with the commits it made', async () => {
    /**
     *
     * Job 14's routing key. Registration happens at the one moment "this
     * machine owns this branch" becomes true, and the head sha it seeds is what
     * later tells an agent commit apart from a human's.
     *
     **/
    const watch = await ciLoop.ciWatchFor(repo, 'hoshi/add-a-widget')
    expect(watch).toMatchObject({ forge: 'github', repo: 'acme/widgets', prNumber: 42, status: 'watching' })
    const head = (await run(repo, 'git', ['rev-parse', 'HEAD'])).trim()
    expect(watch?.agentShas).toContain(head)
  })

  it('records every further agent commit on the branch as its own', async () => {
    await writeFile(path.join(repo, 'more.txt'), 'more\n')
    const sha = (await git.gitCommit(repo, 'feat: more widget')).sha
    const watch = await ciLoop.ciWatchFor(repo, 'hoshi/add-a-widget')
    expect(watch?.agentShas).toContain(sha)
  })

  it('refuses to open a pull request from the trunk', async () => {
    await run(repo, 'git', ['switch', 'main'])
    expect(await codeOf(git.openPullRequest(repo, { title: 'nope', body: '' }))).toBe('git.trunkBranch')
    await run(repo, 'git', ['switch', 'hoshi/add-a-widget'])
  })
})

describe('failure modes are distinct and honest', () => {
  it('reports a non-fast-forward push for what it is', async () => {
    /**
     *
     * Someone else moved the branch on the remote first.
     *
     **/
    const other = path.join(scratch, 'other')
    await run(scratch, 'git', ['clone', '--branch', 'hoshi/add-a-widget', bare, other])
    await run(other, 'git', ['config', 'user.name', 'Someone Else'])
    await run(other, 'git', ['config', 'user.email', 'other@hoshi.invalid'])
    await writeFile(path.join(other, 'theirs.txt'), 'theirs\n')
    await run(other, 'git', ['add', '--all'])
    await run(other, 'git', ['commit', '--message', 'theirs'])
    await run(other, 'git', ['push'])

    await writeFile(path.join(repo, 'mine.txt'), 'mine\n')
    await git.gitCommit(repo, 'mine')
    const remote = await remotes.gitRemote(repo)
    expect(await codeOf(git.gitPush(repo, 'hoshi/add-a-widget', remote!))).toBe('git.notFastForward')
  })

  it('reports a protected branch for what it is', async () => {
    const hook = path.join(bare, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho "protected branch hook declined" >&2\nexit 1\n')
    await chmod(hook, 0o755)
    try {
      await run(repo, 'git', ['switch', '-c', 'hoshi/protected-probe'])
      await writeFile(path.join(repo, 'probe.txt'), 'probe\n')
      await git.gitCommit(repo, 'probe')
      const remote = await remotes.gitRemote(repo)
      expect(await codeOf(git.gitPush(repo, 'hoshi/protected-probe', remote!))).toBe('git.protectedBranch')
    } finally {
      await rm(hook, { force: true })
    }
  })

  it('reports a repository with no remote for what it is', async () => {
    const orphan = path.join(scratch, 'orphan')
    await mkdir(orphan, { recursive: true })
    await run(orphan, 'git', ['init', '--initial-branch=main'])
    await run(orphan, 'git', ['config', 'user.name', 'Hoshi Test'])
    await run(orphan, 'git', ['config', 'user.email', 'test@hoshi.invalid'])
    await writeFile(path.join(orphan, 'a.txt'), 'a\n')
    await run(orphan, 'git', ['add', '--all'])
    await run(orphan, 'git', ['commit', '--message', 'first'])
    await run(orphan, 'git', ['switch', '-c', 'hoshi/orphan'])

    expect(await codeOf(git.openPullRequest(orphan, { title: 'nope', body: '' }))).toBe('git.noRemote')
    expect(await remotes.gitRemote(orphan)).toBeNull()
  })

  it('says it cannot open a pull request on a host it does not speak', async () => {
    const elsewhere = path.join(scratch, 'elsewhere')
    await run(scratch, 'git', ['clone', bare, elsewhere])
    await run(elsewhere, 'git', ['config', 'user.name', 'Hoshi Test'])
    await run(elsewhere, 'git', ['config', 'user.email', 'test@hoshi.invalid'])
    await run(elsewhere, 'git', ['remote', 'set-url', 'origin', 'git@bitbucket.org:acme/widgets.git'])
    await run(elsewhere, 'git', ['switch', '-c', 'hoshi/elsewhere'])
    await writeFile(path.join(elsewhere, 'b.txt'), 'b\n')
    await git.gitCommit(elsewhere, 'b')

    expect(await codeOf(git.openPullRequest(elsewhere, { title: 'nope', body: '' }))).toBe('git.unsupportedForge')
  })

  it('says the machine has no git identity rather than committing anonymously', async () => {
    const anon = path.join(scratch, 'anon')
    await mkdir(anon, { recursive: true })
    await run(anon, 'git', ['init', '--initial-branch=main'])
    await run(anon, 'git', ['switch', '-c', 'hoshi/anon'])
    await writeFile(path.join(anon, 'a.txt'), 'a\n')
    /**
     *
     * No user.name/user.email anywhere: the scratch global config has none and
     * the system config is redirected to /dev/null.
     *
     **/
    expect(await codeOf(git.gitCommit(anon, 'anonymous'))).toBe('git.identityMissing')
  })

  it('rejects a branch name git itself would reject, before running git', async () => {
    expect(await codeOf(git.gitCreateBranch(repo, 'bad..name'))).toBe('git.branchInvalid')
  })
})

describe('the vault credential reaches git without leaking', () => {
  /**
   *
   * What a private repo over https actually depends on: `git push` asking the
   * helper for a credential and getting the VAULT's token back. Driven here
   * through `git credential fill` — the same code path git takes on a 401 from
   * the remote — so no server is needed to prove the handshake.
   *
   * This test earns its keep on the reset: written without the empty
   * `credential.helper=`, it FAILED on a developer's macOS box, where the
   * system gitconfig's osxkeychain helper answered first and handed back an
   * entirely different account's GitHub token. Helpers are a list in config
   * order, and `-c` appends rather than replaces.
   *
   **/
  it('answers a credential request with the token from the environment', () => {
    const stdout = execFileSync('git', [...git.gitCredentialArgs(), 'credential', 'fill'], {
      cwd: repo,
      env: { ...process.env, HOSHI_FORGE_TOKEN: 'not-a-real-token-vault-value' },
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    expect(stdout).toContain('username=x-access-token')
    expect(stdout).toContain('password=not-a-real-token-vault-value')
  })

  it('lets no ambient helper answer ahead of the vault', () => {
    /**
     *
     * A machine that already has a helper configured (a keychain, a `store`
     * file some tool wrote) must not shadow the vault token.
     *
     **/
    const stdout = execFileSync(
      'git',
      [
        '-c',
        'credential.helper=!f() { echo "username=ambient"; echo "password=ambient-secret"; }; f',
        ...git.gitCredentialArgs(),
        'credential',
        'fill',
      ],
      {
        cwd: repo,
        env: { ...process.env, HOSHI_FORGE_TOKEN: 'not-a-real-token-vault-value' },
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
      },
    )
    expect(stdout).toContain('password=not-a-real-token-vault-value')
    expect(stdout).not.toContain('ambient-secret')
  })

  it('never puts the token in argv, where any process on the machine could read it', () => {
    /**
     *
     * The helper reads $HOSHI_FORGE_TOKEN inside the shell it spawns; the value
     * only ever travels in the child's environment.
     *
     **/
    expect(git.GIT_CREDENTIAL_HELPER).toContain('$HOSHI_FORGE_TOKEN')
    expect(git.gitCredentialArgs().join(' ')).not.toMatch(/ghp_|gho_|glpat-/)
  })
})

describe('gitHeadKey', () => {
  it('changes when the branch moves, so the state watcher notices', async () => {
    await run(repo, 'git', ['switch', 'hoshi/add-a-widget'])
    const before = await events.gitHeadKey(repo)
    expect(before).not.toBeNull()

    await writeFile(path.join(repo, 'watched.txt'), 'watched\n')
    await git.gitCommit(repo, 'watched')
    expect(await events.gitHeadKey(repo)).not.toBe(before)
  })

  it('is null for a directory that is not a repository', async () => {
    const plain = path.join(scratch, 'plain')
    await mkdir(plain, { recursive: true })
    expect(await events.gitHeadKey(plain)).toBeNull()
  })
})
