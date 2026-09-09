import os from 'node:os'
import { statfs } from 'node:fs/promises'
import { collectContainerResources } from './cgroup.js'
import { readMachinePreset, type MachinePresetState } from './profile.js'
/**
 *
 * Checkouts live under WORKSPACE_ROOT; we report its filesystem's usage as the
 * machine's disk — the same resolved root the workspace scan uses.
 *
 **/
import { WORKSPACE_ROOT } from './workspace.js'

/** A live snapshot of the machine itself. Nothing here is persisted — it's
 *  gathered on demand from this container's own cgroup and the local
 *  OpenCode server. */
export interface MachineSystem {
  /** Image version this machine reports (MACHINE_VERSION); null in dev. */
  version: string | null
  /** How long this machine's control plane has been up (the sidecar process's
   *  own uptime) — entrypoint.sh tears the whole container down the instant
   *  this process exits, so it's a faithful proxy for container uptime
   *  without needing the container's own start time. Deliberately NOT the
   *  underlying node's `os.uptime()`, which reads however long the shared
   *  host has been up. */
  uptimeSeconds: number
  os: { platform: string; release: string; arch: string }
  /** This machine's own CPU allotment (its cgroup quota, not the node's core
   *  count) and live usage against that allotment. See utils/cgroup.ts. */
  cpu: { count: number; model: string | null; usedFraction: number | null }
  /** This machine's own memory ceiling (its cgroup limit; null when uncapped
   *  — local dev, which runs as a bare process, not a container) and current
   *  usage against it. */
  memory: { limitBytes: number | null; usedBytes: number }
  /** Workspace filesystem usage; null when the root isn't present (dev/fresh). */
  disk: { totalBytes: number; freeBytes: number } | null
  /** The task router (Phase 3): configured mode, the local model it routes
   *  with, and whether the local runtime answers right now. `healthy` is null
   *  when the mode doesn't use a local runtime (cloud/off). */
  router: { mode: RouterMode; model: string; healthy: boolean | null }
  /** The preset this machine was last seeded with (straight from the
   *  seeder's own state file, not the MACHINE_PROFILE env var — see
   *  utils/profile.ts). Null when the machine hasn't been seeded yet. */
  preset: MachinePresetState | null
  /** The machine's workspace root (WORKSPACE_ROOT) — the absolute path
   *  checkouts live under. The personal space (Phase 5) is sessions rooted
   *  here directly, outside any checkout. */
  workspaceRoot: string
}

/** Mirrors the hoshi-router plugin's MACHINE_ROUTER contract: local = ollama
 *  in this machine, cloud = straight to the small_model, off = rubric only. */
export type RouterMode = 'local' | 'cloud' | 'off'

function routerMode(): RouterMode {
  const raw = process.env.MACHINE_ROUTER
  return raw === 'cloud' || raw === 'off' ? raw : 'local'
}

export async function collectSystem(): Promise<MachineSystem> {
  const cpuModel = os.cpus()[0]?.model ?? null
  const resources = await collectContainerResources()
  return {
    version: process.env.MACHINE_VERSION ?? null,
    uptimeSeconds: Math.floor(process.uptime()),
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { count: resources.cpu.limitCount, model: cpuModel, usedFraction: resources.cpu.usedFraction },
    memory: resources.memory,
    disk: await workspaceDisk(),
    router: await routerStatus(),
    preset: await readMachinePreset(),
    workspaceRoot: WORKSPACE_ROOT,
  }
}

/** The router's live status. Only the local mode has a runtime to probe —
 *  ollama's version endpoint answers cheaply without loading the model. */
async function routerStatus(): Promise<{ mode: RouterMode; model: string; healthy: boolean | null }> {
  const mode = routerMode()
  const model = process.env.HOSHI_ROUTER_MODEL ?? 'qwen3:0.6b'
  if (mode !== 'local') return { mode, model, healthy: null }
  const url = (process.env.HOSHI_ROUTER_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1500) })
    return { mode, model, healthy: res.ok }
  } catch {
    return { mode, model, healthy: false }
  }
}

/** Usage of the filesystem holding the workspace. `bavail` (blocks free to an
 *  unprivileged user) is the honest "free" figure, not `bfree`. */
async function workspaceDisk(): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const fs = await statfs(WORKSPACE_ROOT)
    return { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize }
  } catch {
    /**
     *
     * No workspace root yet (dev / fresh machine) — disk usage is unknown, not fatal.
     *
     **/
    return null
  }
}
