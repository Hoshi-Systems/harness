import { defineHoshiTool, z, type HoshiToolFactories } from '../define-tool.js'
import {
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  getProcess,
  listProcesses,
  readProcessLogTail,
  startProcess,
  stopProcess,
  type TrackedProcess,
} from './processes.js'

/**
 * ── The agent's background-process tools (CYB-99) ────────────────────────────
 *
 * The `bash` tool is synchronous, with no "start this and keep working"
 * primitive — a dead end for anything that never exits (`npm run dev`).
 * `process_start` spawns a DETACHED child and returns an id;
 * `process_list`/`process_logs`/`process_stop` observe and control it
 * afterward.
 *
 * ONE registry, and until this change there were two. This file carried its own
 * complete copy of the store — the same processes.json, the same log paths, its
 * own `withStore`, `reconcile`, `trimStore`, `killTree` and log tail — because
 * every file in the old tool package lived under a "no repo-internal imports —
 * ever" rule, justified by an OpenCode runtime that loaded them off disk and
 * has not existed for some time. That rule is what produced the duplicated
 * memory store (docs/STRUCTURE_REVIEW.md H-08); this was the same defect one
 * directory over, and the two halves had already drifted where it counts:
 * ./processes.ts persists only when a call actually CHANGED something, to
 * narrow the window in which one writer clobbers the other's read, while the
 * copy here wrote the whole file back on every `process_list`.
 *
 * There is no second writer to race any more. The tools and the Processes
 * panel's routes are the same process calling the same functions in
 * ./processes.ts, so the store shape, the liveness probe and the stop sequence
 * exist once and cannot drift.
 *
 * Deliberately NOT built: pushing a crashed process's logs into an idle session
 * — pull-based `process_logs` covers "start a server and keep working", and
 * nothing here enumerates or signals a process it did not start.
 *
 **/

function summarize(proc: TrackedProcess) {
  return {
    id: proc.id,
    name: proc.name,
    command: proc.command,
    cwd: proc.cwd,
    pid: proc.pid,
    status: proc.status,
    exitCode: proc.exitCode,
    startedAt: proc.startedAt,
    endedAt: proc.endedAt,
  }
}

const processStart = defineHoshiTool({
  description: [
    "Start a command as a DETACHED background process and return immediately — use this instead of bash for anything that doesn't exit on its own (a dev server, `npm run dev`, a watcher, a long batch job, anything you'd otherwise have to wait on and block your own turn for).",
    'The process keeps running after this tool call returns, independent of this conversation — check on it later with process_list/process_logs, or stop it with process_stop.',
    "Fails fast with a clear error if the command errors or exits within the first moment (e.g. 'command not found') rather than silently tracking a dead process.",
    "'cwd' defaults to the current session's working directory.",
  ].join(' '),
  args: {
    command: z.string().describe("The shell command to run, e.g. 'npm run dev'"),
    cwd: z.string().optional().describe("Working directory — defaults to the session's current directory"),
    name: z.string().optional().describe('A short human-readable label (defaults to the command itself)'),
  },
  async execute(args, context) {
    const command = args.command.trim()
    if (!command) throw new Error('A command is required.')
    const cwd = args.cwd?.trim() || context.directory

    let entry: TrackedProcess
    try {
      entry = await startProcess({ name: args.name?.trim() || command.slice(0, 80), command, cwd })
    } catch (error) {
      throw new Error(`Failed to start "${command}": ${(error as Error).message}`)
    }

    return {
      title: `Started: ${entry.name}`,
      output: `Started "${command}" (id: ${entry.id}, pid: ${entry.pid}) in ${cwd}. It runs in the background — use process_logs with id "${entry.id}" to check its output, or process_stop to stop it.`,
      metadata: {
        hoshi: { process: { action: 'start', id: entry.id, pid: entry.pid, name: entry.name, status: entry.status } },
      },
    }
  },
})

const processList = defineHoshiTool({
  description:
    'List every process started via process_start on this machine, with live status (running/exited/failed/stopped) — reconciled against the OS right now, not just replayed from what was last recorded. Only processes started through process_start are tracked; this is not a general system process list.',
  args: {},
  async execute() {
    const processes = await listProcesses()
    return {
      title: `Processes (${processes.length})`,
      output: JSON.stringify(processes.map(summarize), null, 2),
      metadata: { hoshi: { process: { action: 'list', count: processes.length } } },
    }
  },
})

const processLogs = defineHoshiTool({
  description:
    'Read recent stdout/stderr output from a process started via process_start — use this to check whether a background server is healthy, still starting up, or crashed.',
  args: {
    id: z.string().describe('The process id from process_start/process_list'),
    tail: z
      .number()
      .optional()
      .describe(`Number of most recent lines to return (default ${DEFAULT_TAIL_LINES}, max ${MAX_TAIL_LINES})`),
  },
  async execute(args) {
    const proc = await getProcess(args.id)
    if (!proc) throw new Error(`No tracked process with id "${args.id}" — call process_list to see what's tracked.`)

    const lines = Math.min(Math.max(1, Math.floor(args.tail ?? DEFAULT_TAIL_LINES)), MAX_TAIL_LINES)
    const logs = await readProcessLogTail(proc.id, lines)
    return {
      title: `Logs: ${proc.name}`,
      output: logs || '(no output yet)',
      metadata: { hoshi: { process: { action: 'logs', id: proc.id, status: proc.status } } },
    }
  },
})

const processStop = defineHoshiTool({
  description:
    "Stop a process started via process_start. Sends SIGTERM to the whole process tree first and waits briefly for a clean shutdown, then SIGKILL if it's still running. A no-op if it isn't currently running.",
  args: {
    id: z.string().describe('The process id from process_start/process_list'),
  },
  async execute(args) {
    const result = await stopProcess(args.id)
    if (!result) throw new Error(`No tracked process with id "${args.id}" — call process_list to see what's tracked.`)
    const { process: proc, alreadyStopped } = result
    return {
      title: alreadyStopped ? `Already ${proc.status}: ${proc.name}` : `Stopped: ${proc.name}`,
      output: alreadyStopped
        ? `"${proc.name}" was already ${proc.status}, not running — nothing to stop.`
        : `Stopped "${proc.name}" (pid ${proc.pid}).`,
      metadata: { hoshi: { process: { action: 'stop', id: proc.id, status: proc.status, alreadyStopped } } },
    }
  },
})

export const processTools: HoshiToolFactories = {
  process_start: processStart,
  process_list: processList,
  process_logs: processLogs,
  process_stop: processStop,
}
