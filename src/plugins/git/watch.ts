import { stat } from 'node:fs/promises'
import { machineEventSubscriberCount, publishMachineEvent, scanWorkspace, workspaceRoot } from '../../kernel/index.js'
import { gitHeadKey, publishGitChanged } from './events.js'

/**
 * ── Watching the repositories ────────────────────────────────────────────────
 *
 * The routes here publish `git.changed` at their own mutation points, but they
 * are not the only writer: the agent shells out to raw `git` constantly. So the
 * repos themselves are watched, and the review panel is correct no matter WHO
 * moved the branch.
 *
 * The key is three stats inside `.git` — no `git` subprocess per repo per tick
 * — over the workspace root plus each checkout, and only while somebody is
 * actually connected to the event stream.
 *
 **/
const GIT_TICK_MS = 3_000

/**
 * ── Git (branch / commit / push) ───────────────────────────────────────────
 *
 * routes/git/* publish `git.changed` at their own mutation points, but they
 * are not the only writer: the agent shells out to raw `git` constantly, and
 * the hoshi-git plugin runs in OpenCode's process, not this one. Watching the
 * repos means the review panel is correct no matter WHO moved the branch.
 * The key is three stats inside `.git` (utils/git.ts's gitHeadKey) — no `git`
 * subprocess per repo per tick — over the workspace root plus each checkout.
 *
 **/
const gitKeys = new Map<string, string>()
let gitBusy = false

async function tickGit() {
  if (gitBusy) return
  if (machineEventSubscriberCount() === 0) {
    gitKeys.clear()
    return
  }
  gitBusy = true
  try {
    const projects = await scanWorkspace()
    const dirs = [workspaceRoot(), ...projects.filter((p) => p.git).map((p) => p.directory)]
    const seen = new Set<string>()
    for (const dir of dirs) {
      const key = await gitHeadKey(dir)
      if (key === null) continue
      seen.add(dir)
      const previous = gitKeys.get(dir)
      gitKeys.set(dir, key)
      if (previous !== undefined && key !== previous) publishGitChanged(dir)
    }
    for (const dir of gitKeys.keys()) if (!seen.has(dir)) gitKeys.delete(dir)
  } catch (error) {
    console.error('[state-events] git tick failed:', error)
  } finally {
    gitBusy = false
  }
}

export function watchGit(every: (ms: number, run: () => void | Promise<void>) => void): void {
  every(GIT_TICK_MS, tickGit)
}
