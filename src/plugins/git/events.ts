import { stat } from 'node:fs/promises'
import path from 'node:path'
import { publishMachineEvent } from '../../kernel/index.js'

/**
 * ── Telling clients the repo moved ───────────────────────────────────────────
 *
 * Two halves of one job: publishing the change, and the cheap key the watcher
 * polls to notice one nothing here caused.
 *
 **/

/** Branch/commit/PR state is machine-owned state a client watches, so every
 *  mutation path here publishes — the panel never polls for it. The directory
 *  rides along so a client showing one checkout ignores another's churn.
 *  ./watch.ts publishes the same event for changes made OUTSIDE these routes
 *  (the agent's own `git` shell commands, and its git tools). */
export function publishGitChanged(dir: string): void {
  publishMachineEvent('git.changed', { directory: dir })
}

/** A cheap change key for the state watcher: three stats inside `.git`, no
 *  subprocess at all. `logs/HEAD` is git's own reflog — it gains a line on every
 *  commit, checkout, branch switch, reset and merge; `HEAD` moves on a switch
 *  even in a repo with reflogs disabled; `config` moves when a push sets an
 *  upstream or a remote is added. Between them they cover every transition this
 *  surface renders, without the watcher running `git` once per repo per tick.
 *  Null when the directory isn't a repo (or `.git` is a worktree pointer file,
 *  which the workspace never produces). */
export async function gitHeadKey(dir: string): Promise<string | null> {
  const gitDir = path.join(dir, '.git')
  try {
    if (!(await stat(gitDir)).isDirectory()) return null
  } catch {
    return null
  }
  const mtime = async (file: string) =>
    stat(path.join(gitDir, file))
      .then((s) => `${s.mtimeMs}:${s.size}`)
      .catch(() => '-')
  const parts = await Promise.all([mtime('logs/HEAD'), mtime('HEAD'), mtime('config')])
  return parts.join('|')
}
