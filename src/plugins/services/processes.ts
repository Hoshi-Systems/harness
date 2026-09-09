import type { TrackedProcess } from '../../wire/index.js'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile, readHoshiJson, writeHoshiJson } from '../../kernel/index.js'

/**
 * ── Background process registry (CYB-99) ────────────────────────────────────
 *
 * The `bash` tool is synchronous — it blocks the agent's turn until the command
 * exits, with no "start and don't wait" primitive. ./tools.ts gives the agent
 * `process_start`/`process_list`/`process_logs`/`process_stop`, which spawn a
 * real DETACHED child process instead. Nothing about a detached child can be
 * held in memory and still be true after a restart, so the registry is a file:
 * ~/.hoshi/processes.json, the same atomic-write JSON convention as
 * schedules.json (plugins/triggers/) and tasks.json.
 *
 * ONE implementation, and there used to be two. ./tools.ts carried a complete
 * private copy of everything below — the store shape, the liveness probe, the
 * trim, the stop sequence, the log tail — because the tools lived in a separate
 * package under a "no repo-internal imports — ever" rule, the same rule that
 * gave the memory tools their own copy of the memory store
 * (docs/STRUCTURE_REVIEW.md H-08). The two halves had already drifted where it
 * mattered: this one persists only when a call actually changed something,
 * while the copy rewrote the whole file on every `process_list`. The tools call
 * this file now, so there is one writer and nothing left to keep in lockstep.
 *
 * SPAWNING, and the boundary that moved. CYB-99 deliberately made this module
 * read/stop-only: the agent started processes, the human only observed them,
 * and there was to be no "start from the web UI" surface. `startProcess()`
 * below revises that, on purpose and narrowly. What changed is that a service
 * (utils/services.ts) is a NAMED, DECLARED thing — its command comes from a
 * record the user or the project's own manifest wrote, and the panel's Run
 * button re-runs that record. That is a different act from handing the web an
 * arbitrary exec: the sidecar still never accepts a command to run, only a
 * service id to start. The rest of the original scope stands — this is still
 * not a general OS process monitor, and nothing here enumerates or signals a
 * process it didn't start.
 *
 **/

/**
 *
 * Cap the settled entries so a machine that has started thousands of processes
 * does not grow an unbounded file. A `running` entry is never dropped, however
 * many there are.
 *
 **/
const MAX_PROCESSES = 200
/**
 *
 * Every call below re-reads the file from disk rather than caching it. That
 * used to be a requirement — `process_start` ran in a second process with its
 * own writer, and a long-lived cache here went stale the moment the agent
 * started anything (live-verified: silently, every time). With one writer it is
 * no longer load-bearing, and it is kept because the store is capped and tiny,
 * so a read per call buys that guarantee for nothing.
 *
 **/

const processesFile = () => hoshiFile('processes.json')
const processesLogDir = () => hoshiFile('processes')

/** The wire shape — declared in @hoshi/shared (machine-events.ts), where the
 *  exitCode caveat now lives too. */
export type { TrackedProcess }

interface ProcessStore {
  processes: TrackedProcess[]
}

async function readStore(): Promise<ProcessStore> {
  const stored = await readHoshiJson<ProcessStore>(processesFile())
  return stored && Array.isArray(stored.processes) ? stored : { processes: [] }
}

/**
 *
 * Chained so two overlapping read-modify-writes — a stop racing another stop,
 * a tool call racing the Processes panel — land as separate atomic steps rather
 * than one clobbering the other's read. Everything that writes this file goes
 * through here now, so the chain is the whole story rather than a best effort
 * against a writer it could not see.
 *
 **/
let mutateQueue: Promise<unknown> = Promise.resolve()

/** Read, let `fn` inspect/mutate in place, and persist ONLY when `fn` reports
 *  a real change (via its boolean return) — a plain list/get that reconciled
 *  nothing writes nothing back. Worth the extra boolean: `process_list` is the
 *  most-called path here, and rewriting the file to answer a read is exactly
 *  what the copy this replaced did. */
function withStore<T>(fn: (store: ProcessStore) => Promise<[T, boolean]> | [T, boolean]): Promise<T> {
  const run = mutateQueue.then(async () => {
    const store = await readStore()
    const [result, changed] = await fn(store)
    if (changed) await writeHoshiJson(processesFile(), store)
    return result
  })
  mutateQueue = run.catch(() => {})
  return run
}

/** Absolute log file path for one tracked process — derived from its id rather
 *  than stored on the record, so an entry written by any build resolves to its
 *  own output. */
export function processLogFile(id: string): string {
  return path.join(processesLogDir(), `${id}.log`)
}

/** True when `pid` is (still) a live process this user owns. Signal 0 sends no
 *  actual signal — it only probes whether the pid exists and is reachable.
 *  ESRCH ("no such process") means dead; anything else (e.g. EPERM) means the
 *  pid exists but we couldn't fully confirm it, so we assume it's still alive
 *  rather than falsely reaping a live process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Reconcile every `running` entry against the OS right now — a machine reboot
 *  or an unwatched crash can leave a stale "running" row that nothing ever
 *  flips. The FIRST liveness check that fails marks it `exited` (exitCode
 *  stays null: a signal-0 probe can't recover what the exit code was). Returns
 *  whether anything changed, so callers only persist when needed. */
function reconcile(store: ProcessStore): boolean {
  let changed = false
  for (const proc of store.processes) {
    if (proc.status === 'running' && !isAlive(proc.pid)) {
      proc.status = 'exited'
      proc.endedAt = new Date().toISOString()
      changed = true
    }
  }
  return changed
}

/** Most-recent-first, live status reconciled against the OS first — the
 *  Processes panel's list and `process_list`'s tool result share this. */
export async function listProcesses(): Promise<TrackedProcess[]> {
  return withStore((store) => {
    const changed = reconcile(store)
    return [[...store.processes].reverse(), changed]
  })
}

export async function getProcess(id: string): Promise<TrackedProcess | undefined> {
  return withStore((store) => {
    const changed = reconcile(store)
    return [store.processes.find((p) => p.id === id), changed]
  })
}

/** Drop the oldest settled entries past {@link MAX_PROCESSES}; `running` rows
 *  are kept regardless of age, so a long-lived dev server is never trimmed out
 *  from under the panel. */
function trimStore(store: ProcessStore): void {
  if (store.processes.length <= MAX_PROCESSES) return
  const settled = store.processes.filter((p) => p.status !== 'running')
  const excess = store.processes.length - MAX_PROCESSES
  const doomed = new Set(settled.slice(0, excess))
  store.processes = store.processes.filter((p) => !doomed.has(p))
}

/** How long to watch a fresh child before calling the start a success. A typo'd
 *  command ("pnpm dve") exits within milliseconds; without this window it would
 *  register as `running` and only reveal itself as dead on the next reconcile —
 *  i.e. the Run button would flash green and then quietly go grey. */
const START_PROBE_MS = 300

/** Spawn a detached child and track it. Rejects (rather than registering a
 *  corpse) when the command dies inside
 *  {@link START_PROBE_MS} — the caller turns that into a real API error, so
 *  "command not found" reaches the user as a message instead of a row that
 *  silently reads `exited`.
 *
 *  `detached` puts the child in its own process group, which is what lets
 *  {@link stopProcess} later signal the whole tree: a dev server's own children
 *  (esbuild, a watcher, a forked worker) must die with it. */
export async function startProcess(input: {
  name: string
  command: string
  cwd: string
  env?: Record<string, string> | null
}): Promise<TrackedProcess> {
  await mkdir(processesLogDir(), { recursive: true })
  const id = crypto.randomUUID()
  /**
   *
   * spawn() dup()s the fd into the child; our own copy must still be closed
   * afterward (success or failure) so this process doesn't leak it. Output goes
   * straight to the file descriptor rather than through this process, so the
   * log survives the sidecar restarting.
   *
   **/
  const fd = openSync(processLogFile(id), 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(input.command, {
      shell: true,
      cwd: input.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: input.env ? { ...process.env, ...input.env } : process.env,
    })
  } finally {
    closeSync(fd)
  }

  const outcome = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: true })
    }, START_PROBE_MS)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, message: error.message })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, message: `exited immediately (code ${code ?? 'null'}, signal ${signal ?? 'none'})` })
    })
  })
  if (!outcome.ok) throw new Error(outcome.message)
  if (!child.pid) throw new Error('no pid was assigned')

  const entry: TrackedProcess = {
    id,
    name: input.name,
    command: input.command,
    cwd: input.cwd,
    pid: child.pid,
    status: 'running',
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  }
  await withStore((store) => {
    store.processes.push(entry)
    trimStore(store)
    return [undefined, true]
  })

  /**
   *
   * Opportunistic: if this daemon is still alive when the child exits, record
   * the real exit code rather than leaving the eventual liveness probe to guess
   * "exited, unknown code".
   *
   **/
  child.once('exit', (code, signal) => {
    void withStore((store) => {
      const proc = store.processes.find((p) => p.id === id)
      if (!proc || proc.status !== 'running') return [undefined, false]
      proc.status = code === 0 && !signal ? 'exited' : 'failed'
      proc.exitCode = code
      proc.endedAt = new Date().toISOString()
      return [undefined, true]
    })
  })
  child.unref()

  return entry
}

const GRACE_MS = 5_000
const KILL_CONFIRM_MS = 2_000
const POLL_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** SIGTERM/SIGKILL the process GROUP (negative pid) so a dev server's own
 *  children die with it, falling back to just the pid if group-kill fails
 *  (e.g. it was never its own group leader). Swallows "already dead" errors —
 *  the caller's own liveness polling is what decides whether this worked. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

/** Stop a tracked process: SIGTERM, wait up to {@link GRACE_MS} for a clean
 *  exit, then SIGKILL if it's still alive. A no-op (not an error) when the
 *  process isn't currently `running` — `alreadyStopped` tells the caller which
 *  happened. Returns undefined only when the id itself is unknown.
 *
 *  The actual SIGTERM/grace-period/SIGKILL sequence happens OUTSIDE
 *  `withStore` — it takes up to several seconds, and holding the mutation
 *  queue open that whole time would block every other list/get/stop call on
 *  this one. Two short store transactions bookend it instead: one to look up
 *  the pid (and bail out if it's not `running`), one to record the outcome. */
export async function stopProcess(
  id: string,
): Promise<{ process: TrackedProcess; alreadyStopped: boolean } | undefined> {
  const before = await withStore((store) => {
    const changed = reconcile(store)
    const proc = store.processes.find((p) => p.id === id)
    return [proc ? { ...proc } : undefined, changed]
  })
  if (!before) return undefined
  if (before.status !== 'running') return { process: before, alreadyStopped: true }

  killTree(before.pid, 'SIGTERM')
  const gracefulDeadline = Date.now() + GRACE_MS
  while (Date.now() < gracefulDeadline && isAlive(before.pid)) await sleep(POLL_MS)

  if (isAlive(before.pid)) {
    killTree(before.pid, 'SIGKILL')
    const killDeadline = Date.now() + KILL_CONFIRM_MS
    while (Date.now() < killDeadline && isAlive(before.pid)) await sleep(POLL_MS)
  }

  return withStore((store) => {
    const proc = store.processes.find((p) => p.id === id)
    if (!proc) return [{ process: before, alreadyStopped: false }, false]
    proc.status = 'stopped'
    proc.endedAt = new Date().toISOString()
    return [{ process: proc, alreadyStopped: false }, true]
  })
}

/** Tail cap: read at most this many trailing bytes off disk rather than
 *  loading a long-lived process's entire log into memory. */
const MAX_TAIL_BYTES = 200_000
export const DEFAULT_TAIL_LINES = 200
export const MAX_TAIL_LINES = 2000

/** The last `lines` lines of a tracked process's combined stdout+stderr log.
 *  Empty string (not an error) for a process with no output yet, or whose log
 *  file has gone missing. */
export async function readProcessLogTail(id: string, lines = DEFAULT_TAIL_LINES): Promise<string> {
  const file = processLogFile(id)
  let handle
  try {
    const info = await stat(file)
    const start = Math.max(0, info.size - MAX_TAIL_BYTES)
    const length = info.size - start
    if (length === 0) return ''
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const allLines = text.split('\n')
    /**
     *
     * Started mid-file: the first "line" is a partial line, drop it.
     *
     **/
    const usable = start > 0 ? allLines.slice(1) : allLines
    return usable.slice(-lines).join('\n')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}
