import { apiError } from '../../kernel/index.js'
import { git } from './exec.js'
import type { GitForge, GitRemoteInfo } from './types.js'

/**
 * ── Where a change goes: the branch, the remote, the forge ───────────────────
 *
 * Naming a branch and reading `origin` are the same question asked twice —
 * "where does this land" — and both are pure enough to test without a network
 * or a repo, which is why they sit apart from the flow that uses them.
 *
 **/

/**
 * ── Branch naming ────────────────────────────────────────────────────────────
 *
 **/

/** `hoshi/<slug>` — the convention that makes an agent's branch recognizable at
 *  a glance in `git branch` and in the forge's branch list, the same way
 *  background agents elsewhere prefix theirs. Exported for the tests and for
 *  callers that want to show the name before creating it. */
export function sessionBranchName(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `hoshi/${slug || 'change'}`
}

/** git's own refname rules, minus the ones a slug can't hit anyway. A name that
 *  fails here would make `git branch` fail with a far less readable message. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.startsWith('-')) return false
  if (/\.\.|@\{|\/\/|[\x00-\x20~^:?*[\\\x7f]/.test(name)) return false
  return true
}

/**
 * ── Remote / forge ───────────────────────────────────────────────────────────
 *
 **/

/** Parse a git remote URL (`git@host:owner/repo.git`, `ssh://…`, `https://…`)
 *  into the host + `owner/repo` slug the forge CLIs address, and which forge it
 *  is. A self-hosted GitLab is recognized by hostname convention only — an
 *  unrecognized host resolves `forge: null`, which is an honest "we don't know
 *  how to open a PR here" rather than a wrong guess. */
export function parseRemoteUrl(name: string, url: string): GitRemoteInfo | null {
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
  const forge: GitForge | null =
    lower === 'github.com' || lower.endsWith('.github.com') || lower.startsWith('github.')
      ? 'github'
      : lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.startsWith('gitlab.')
        ? 'gitlab'
        : null
  return { name, url, host, slug, forge }
}

/** This repo's push target. `origin` wins; otherwise the first remote there is,
 *  because a checkout cloned by something other than provisioning may well name
 *  it differently. Null when the repo has no remote at all.
 *
 *  The URL comes from `git config`, NOT `git remote -v`: the latter prints URLs
 *  *after* applying `url.<base>.insteadOf` rewrites, so on a machine that
 *  mirrors github.com through a corporate proxy the forge would be read off the
 *  mirror's hostname and resolve to "we don't know this host". The configured
 *  value is what identifies the project; `git push` applies the rewrite itself.
 *  `pushurl` wins over `url` when set, for the same reason git prefers it. */
export async function gitRemote(dir: string): Promise<GitRemoteInfo | null> {
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

export function requireRemote(remote: GitRemoteInfo | null): GitRemoteInfo {
  if (!remote) {
    apiError(400, 'git.noRemote', 'This repository has no git remote, so there is nowhere to push a branch.')
  }
  return remote
}

export function requireForge(remote: GitRemoteInfo): GitForge {
  if (!remote.forge) {
    apiError(
      400,
      'git.unsupportedForge',
      `Hoshi can open pull requests on GitHub and GitLab; ${remote.host} is neither.`,
      { host: remote.host },
    )
  }
  return remote.forge
}
