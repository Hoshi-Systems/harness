import path from 'node:path'
import { WORKSPACE_ROOT } from './workspace.js'

/** Thrown for a path that leaves the workspace. Routes map it to a 400 — it is
 *  a bad request, not a machine fault. */
export class OutsideWorkspaceError extends Error {}

/** Turn a client-supplied path into an absolute one inside the workspace, or
 *  refuse it.
 *
 *  Every route that takes a path from a client goes through here. The machine
 *  runs as a user with a home directory, ssh keys and a credential vault, so
 *  "read this file" without containment is "read anything on the box" — and the
 *  ways in are unremarkable: `../`, an absolute path, or a symlink. The first
 *  two are what `path.resolve` plus this comparison catch.
 *
 *  Resolution happens BEFORE the comparison, so `a/../../etc/passwd` is judged
 *  as the path it actually means rather than the one it is spelled as. */
export function resolveWorkspacePath(input: string): string {
  const root = path.resolve(WORKSPACE_ROOT)
  /**
   *
   * An absolute path is taken at face value and then checked, so a client that
   * legitimately holds one (a session's own directory) can use it.
   *
   **/
  const resolved = path.resolve(root, input)
  const relative = path.relative(root, resolved)
  const inside = resolved === root || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!inside) throw new OutsideWorkspaceError('That path is outside this machine’s workspace.')
  return resolved
}
