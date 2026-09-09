import { machineEventSubscriberCount, publishMachineEvent } from '../../kernel/index.js'
import { listListeningPorts } from './listening-ports.js'
import { listProcesses, processLogFile } from './processes.js'
import { servicesSnapshot } from './services.js'
import { stat } from 'node:fs/promises'

/**
 * ── Watching what happens outside our own routes ─────────────────────────────
 *
 * A dev server binding a port, the agent's detached process exiting, a log file
 * growing: state this plugin owns that changes without any request touching it.
 * Published as diffs so clients get pushes instead of running these scans
 * themselves over HTTP — which N clients used to do, each on its own interval.
 *
 * Both scans are machine-local and cheap, and they only run while at least one
 * `/events` connection is live: an idle machine with nobody watching does no
 * work at all.
 *
 **/
const PORTS_TICK_MS = 2_500
const PROCESSES_TICK_MS = 5_000

/**
 * ── Ports ──────────────────────────────────────────────────────────────────
 *
 * Baselines reset whenever the audience drops to zero: the next listener
 * gets a fresh connect-time snapshot from the route, so re-arming quietly
 * (no diff against a stale baseline) is both correct and spam-free.
 *
 **/
let lastPorts: string | null = null
let portsBusy = false

async function tickPorts() {
  if (portsBusy) return
  if (machineEventSubscriberCount() === 0) {
    lastPorts = null
    return
  }
  portsBusy = true
  try {
    const ports = await listListeningPorts()
    const key = ports.join(',')
    if (lastPorts !== null && key !== lastPorts) publishMachineEvent('ports.changed', { ports })
    lastPorts = key
  } finally {
    portsBusy = false
  }
}

/**
 * ── Processes + their logs ─────────────────────────────────────────────────
 *
 * listProcesses() reconciles liveness against the OS on every read, so this
 * tick is also what flips an orphaned "running" row to `exited` and gets
 * that change pushed. Log growth is a signal, not a payload: the event says
 * WHICH process wrote, and only a client actually showing that log fetches
 * the new tail — nothing streams log content to everyone.
 *
 **/
let lastProcesses: string | null = null
let lastServices: string | null = null
const logSizes = new Map<string, number>()
let processesBusy = false

async function tickProcesses() {
  if (processesBusy) return
  if (machineEventSubscriberCount() === 0) {
    lastProcesses = null
    lastServices = null
    logSizes.clear()
    return
  }
  processesBusy = true
  try {
    const processes = await listProcesses()
    const key = JSON.stringify(processes)
    if (lastProcesses !== null && key !== lastProcesses) publishMachineEvent('processes.changed', { processes })
    lastProcesses = key

    const seen = new Set<string>()
    for (const proc of processes) {
      seen.add(proc.id)
      const size = await stat(processLogFile(proc.id))
        .then((s) => s.size)
        .catch(() => 0)
      const previous = logSizes.get(proc.id)
      logSizes.set(proc.id, size)
      if (previous !== undefined && size !== previous) publishMachineEvent('process.log.changed', { id: proc.id })
    }
    for (const id of logSizes.keys()) if (!seen.has(id)) logSizes.delete(id)

    /**
     * ── Services ─────────────────────────────────────────────────────────
     *
     * A service's status is DERIVED from its backing process, so the cases
     * that matter most to the panel — it crashed, it was killed from a
     * shell, the machine rebooted — happen with no mutation path to publish
     * from. This diff is the only thing that catches them. Computed here
     * rather than on its own timer because it reads the same process
     * registry we just reconciled, and a service can never change without
     * that read changing first (its declaration changes go out from
     * utils/services.ts at the mutation itself).
     *
     **/
    const services = await servicesSnapshot()
    const servicesKey = JSON.stringify(services)
    if (lastServices !== null && servicesKey !== lastServices) publishMachineEvent('services.changed', services)
    lastServices = servicesKey
  } catch (error) {
    console.error('[state-events] processes tick failed:', error)
  } finally {
    processesBusy = false
  }
}

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

export function watchServices(every: (ms: number, run: () => void | Promise<void>) => void): void {
  every(PORTS_TICK_MS, tickPorts)
  every(PROCESSES_TICK_MS, tickProcesses)
}
