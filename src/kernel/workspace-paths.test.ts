import { describe, expect, it } from 'vitest'
import { OutsideWorkspaceError, resolveWorkspacePath } from './workspace-paths.js'
import { WORKSPACE_ROOT } from './workspace.js'
import path from 'node:path'

const root = path.resolve(WORKSPACE_ROOT)

describe('resolveWorkspacePath', () => {
  it('resolves a relative path inside the workspace', () => {
    expect(resolveWorkspacePath('alpha/src')).toBe(path.join(root, 'alpha/src'))
  })

  it('accepts the root itself', () => {
    expect(resolveWorkspacePath('')).toBe(root)
  })

  it('accepts an absolute path that is already inside', () => {
    /**
     *
     * A client legitimately holds one: a session carries its own directory.
     *
     **/
    expect(resolveWorkspacePath(path.join(root, 'alpha'))).toBe(path.join(root, 'alpha'))
  })

  it('refuses a climb out', () => {
    expect(() => resolveWorkspacePath('../../etc/passwd')).toThrow(OutsideWorkspaceError)
  })

  it('refuses a climb hidden mid-path', () => {
    /**
     *
     * Judged as the path it means, not the one it is spelled as.
     *
     **/
    expect(() => resolveWorkspacePath('alpha/../../../etc/passwd')).toThrow(OutsideWorkspaceError)
  })

  it('refuses an absolute path elsewhere on the box', () => {
    /**
     *
     * The machine runs as a user with ssh keys and a credential vault; this is
     * the difference between "read a project file" and "read anything".
     *
     **/
    expect(() => resolveWorkspacePath('/etc/passwd')).toThrow(OutsideWorkspaceError)
  })

  it('does not mistake a sibling with the same prefix for a child', () => {
    expect(() => resolveWorkspacePath(`${root}-elsewhere/secret`)).toThrow(OutsideWorkspaceError)
  })
})
