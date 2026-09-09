import { describe, expect, it } from 'vitest'
import { isValidBranchName, parseRemoteUrl, sessionBranchName } from './remote.js'

/**
 *
 * The propose → review → land path decides two things before it ever touches
 * the network: what the branch is called, and which forge (if any) the remote
 * belongs to. Both are pure, and both are silent when wrong — a bad branch name
 * surfaces as git's own refname error, and a misread remote sends `gh` at a
 * GitLab host.
 *
 **/

describe('sessionBranchName', () => {
  it('applies the hoshi/ convention', () => {
    expect(sessionBranchName('Add rate limiting')).toBe('hoshi/add-rate-limiting')
    expect(sessionBranchName('CYB-123')).toBe('hoshi/cyb-123')
  })

  it('collapses anything that is not a branch-safe character', () => {
    expect(sessionBranchName('Fix: the "login" bug!! (again)')).toBe('hoshi/fix-the-login-bug-again')
    expect(sessionBranchName('  spaces  everywhere  ')).toBe('hoshi/spaces-everywhere')
    expect(sessionBranchName('a//b..c')).toBe('hoshi/a-b-c')
  })

  it('never emits a trailing separator, even after truncation', () => {
    const long = sessionBranchName('x'.repeat(40) + ' ' + 'y'.repeat(40))
    expect(long.startsWith('hoshi/')).toBe(true)
    expect(long.endsWith('-')).toBe(false)
    expect(isValidBranchName(long)).toBe(true)
  })

  it('falls back rather than producing an empty ref', () => {
    expect(sessionBranchName('')).toBe('hoshi/change')
    expect(sessionBranchName('!!!')).toBe('hoshi/change')
  })

  it('always produces a name git will accept', () => {
    for (const seed of ['normal', '../../etc/passwd', 'a@{b}', 'ends.lock', '-leading-dash', '日本語']) {
      expect(isValidBranchName(sessionBranchName(seed)), `for ${seed}`).toBe(true)
    }
  })
})

describe('isValidBranchName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['main', 'hoshi/thing', 'feature/CYB-1_v2', 'a.b.c']) {
      expect(isValidBranchName(name), name).toBe(true)
    }
  })

  it('rejects what git itself rejects', () => {
    for (const name of ['', '/leading', 'trailing/', 'ends.', 'ends.lock', '-dash', 'a..b', 'a@{b}', 'a//b']) {
      expect(isValidBranchName(name), name).toBe(false)
    }
  })

  it('rejects the characters that would let a name be read as an option or a path', () => {
    for (const name of ['a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\nb']) {
      expect(isValidBranchName(name), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('parseRemoteUrl', () => {
  it('reads the scp-like git@ form', () => {
    expect(parseRemoteUrl('origin', 'git@github.com:mikield/hoshi.git')).toMatchObject({
      host: 'github.com',
      slug: 'mikield/hoshi',
      forge: 'github',
    })
  })

  it('reads ssh:// and https:// forms to the same slug', () => {
    for (const url of ['ssh://git@github.com/mikield/hoshi.git', 'https://github.com/mikield/hoshi.git']) {
      expect(parseRemoteUrl('origin', url), url).toMatchObject({ slug: 'mikield/hoshi', forge: 'github' })
    }
  })

  it('keeps a nested GitLab group path intact', () => {
    expect(parseRemoteUrl('origin', 'git@gitlab.com:group/sub/project.git')).toMatchObject({
      slug: 'group/sub/project',
      forge: 'gitlab',
    })
  })

  it('recognizes self-hosted hosts by convention', () => {
    expect(parseRemoteUrl('origin', 'git@gitlab.acme.io:team/app.git')?.forge).toBe('gitlab')
    expect(parseRemoteUrl('origin', 'https://github.acme.io/team/app')?.forge).toBe('github')
  })

  it('says it does not know rather than guessing', () => {
    /**
     *
     * A wrong guess here would run `gh` against a Bitbucket host and report an
     * auth failure for a repo Hoshi simply can't open a PR on.
     *
     **/
    expect(parseRemoteUrl('origin', 'git@bitbucket.org:team/app.git')).toMatchObject({ forge: null })
    expect(parseRemoteUrl('origin', 'git@codeberg.org:team/app.git')?.forge).toBeNull()
  })

  it('returns null for anything that is not a remote URL', () => {
    for (const url of ['', 'not a url', 'https://github.com', 'git@github.com:']) {
      expect(parseRemoteUrl('origin', url), JSON.stringify(url)).toBeNull()
    }
  })

  it('never rewrites the URL it was given', () => {
    const url = 'git@github.com:mikield/hoshi.git'
    expect(parseRemoteUrl('origin', url)?.url).toBe(url)
  })
})
