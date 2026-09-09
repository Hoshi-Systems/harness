import { readFile } from 'node:fs/promises'
import os from 'node:os'

/**
 *
 * Container-scoped CPU/memory, read straight from this container's own
 * cgroup. `os.cpus()/totalmem()/loadavg()` all read `/proc`, which inside a
 * container (without LXCFS) reports the HOST's figures, not this container's
 * Swarm/Kubernetes resource limit (orchestrator/docker-swarm.ts's
 * `Resources.Limits`) — verified live: `nproc` inside a plain `docker run
 * --cpus=1.5` container reports the host's full core count, not 1.5. Falls
 * back to host figures when the cgroup files aren't there at all, which is
 * the honest answer for local `pnpm dev:machine` (a bare process, not a
 * container) — "uncapped, matches the host".
 *
 **/

const CGROUP_ROOT = '/sys/fs/cgroup'

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

/** cgroup v2 (the unified hierarchy) is the default on every kernel this ships
 *  to (≥ 5.8 — Ubuntu 22.04+/Debian 11+); v1 is kept as a fallback for older
 *  Swarm nodes rather than assumed away. Cached — the filesystem layout can't
 *  change for the life of the process. */
let unified: boolean | null = null
async function isCgroupV2(): Promise<boolean> {
  if (unified === null) unified = (await readText(`${CGROUP_ROOT}/cgroup.controllers`)) !== null
  return unified
}

interface CpuSample {
  /** Effective core count from the CPU quota, or the host's count when
   *  uncapped. */
  limitCount: number
  /** Cumulative CPU time this cgroup has consumed, in microseconds. */
  usageUsec: number
}

async function readCpu(): Promise<CpuSample | null> {
  const hostCount = os.cpus().length
  if (await isCgroupV2()) {
    const max = await readText(`${CGROUP_ROOT}/cpu.max`)
    const usage = (await readText(`${CGROUP_ROOT}/cpu.stat`))?.match(/^usage_usec (\d+)/m)?.[1]
    if (max === null || usage === undefined) return null
    const [quota, period] = max.split(/\s+/)
    const limitCount = quota === 'max' ? hostCount : Number(quota) / Number(period)
    return { limitCount: limitCount > 0 ? limitCount : hostCount, usageUsec: Number(usage) }
  }
  const [quota, period, usage] = await Promise.all([
    readText(`${CGROUP_ROOT}/cpu/cpu.cfs_quota_us`),
    readText(`${CGROUP_ROOT}/cpu/cpu.cfs_period_us`),
    readText(`${CGROUP_ROOT}/cpuacct/cpuacct.usage`),
  ])
  if (quota === null || period === null || usage === null) return null
  const q = Number(quota)
  const limitCount = q > 0 ? q / Number(period) : hostCount
  /**
   *
   * cpuacct.usage is nanoseconds on v1, vs. cpu.stat's usage_usec microseconds
   * on v2 — normalize to microseconds so callers never need to know which
   * hierarchy answered.
   *
   **/
  return { limitCount, usageUsec: Number(usage) / 1000 }
}

interface MemorySample {
  /** Byte ceiling, or null when uncapped. */
  limitBytes: number | null
  /** Bytes in active use — the cgroup's usage counter minus reclaimable page
   *  cache (the same subtraction `docker stats` does), so a machine that's
   *  simply read a lot of files doesn't read as "nearly out of memory". */
  usedBytes: number
}

async function readMemory(): Promise<MemorySample | null> {
  if (await isCgroupV2()) {
    const [max, current, stat] = await Promise.all([
      readText(`${CGROUP_ROOT}/memory.max`),
      readText(`${CGROUP_ROOT}/memory.current`),
      readText(`${CGROUP_ROOT}/memory.stat`),
    ])
    if (max === null || current === null) return null
    const inactiveFile = Number(stat?.match(/^inactive_file (\d+)/m)?.[1] ?? 0)
    return { limitBytes: max === 'max' ? null : Number(max), usedBytes: Math.max(0, Number(current) - inactiveFile) }
  }
  const [limit, usage, stat] = await Promise.all([
    readText(`${CGROUP_ROOT}/memory/memory.limit_in_bytes`),
    readText(`${CGROUP_ROOT}/memory/memory.usage_in_bytes`),
    readText(`${CGROUP_ROOT}/memory/memory.stat`),
  ])
  if (limit === null || usage === null) return null
  /**
   *
   * v1 has no "unlimited" sentinel string like v2's "max" — an uncapped
   * cgroup instead reports a page-aligned value near the signed 64-bit max,
   * well above any real host's RAM.
   *
   **/
  const limitNum = Number(limit)
  const inactiveFile = Number(stat?.match(/^total_inactive_file (\d+)/m)?.[1] ?? 0)
  return {
    limitBytes: limitNum > os.totalmem() * 2 ? null : limitNum,
    usedBytes: Math.max(0, Number(usage) - inactiveFile),
  }
}

/** A short in-request second sample so CPU usage can be expressed as a rate —
 *  cgroup counters are cumulative, unlike the kernel's pre-averaged host
 *  loadavg. Mirrors how `docker stats` derives its own CPU%. */
const CPU_SAMPLE_WINDOW_MS = 200

export interface ContainerResources {
  cpu: { limitCount: number; usedFraction: number | null }
  memory: { limitBytes: number | null; usedBytes: number }
}

/** This container's own CPU/memory limit and live usage against it — see the
 *  module doc above for why this isn't just `os.*()`. */
export async function collectContainerResources(): Promise<ContainerResources> {
  const memory = await readMemory()
  const cpuStart = await readCpu()
  if (!cpuStart) {
    return {
      cpu: { limitCount: os.cpus().length, usedFraction: null },
      memory: memory ?? { limitBytes: null, usedBytes: os.totalmem() - os.freemem() },
    }
  }
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_WINDOW_MS))
  const cpuEnd = await readCpu()
  const usedFraction = cpuEnd
    ? Math.max(
        0,
        Math.min(1, (cpuEnd.usageUsec - cpuStart.usageUsec) / (CPU_SAMPLE_WINDOW_MS * 1000) / cpuStart.limitCount),
      )
    : null
  return {
    cpu: { limitCount: cpuStart.limitCount, usedFraction },
    memory: memory ?? { limitBytes: null, usedBytes: os.totalmem() - os.freemem() },
  }
}
