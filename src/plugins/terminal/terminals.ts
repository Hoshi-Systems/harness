import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { TerminalInfo } from '../../wire/index.js'
import type { IPty } from 'node-pty'
import { promptSetup } from './prompt.js'
import { publishMachineEvent } from '../../kernel/index.js'

/**
 * ── The machine's shells ─────────────────────────────────────────────────────
 *
 * Real pseudo-terminals, owned by the MACHINE rather than by a browser tab.
 *
 * That ownership is the whole point. A shell tied to a socket dies when a laptop
 * lid closes, which makes it useless for the thing people open a terminal for —
 * starting something long and coming back to it. Every other promise this
 * product makes is that work continues while you are gone; a terminal that broke
 * that would be the one surface that did.
 *
 * IN MEMORY, and unlike `processes.json` deliberately so. A PTY is a live file
 * descriptor: a registry of them restored from disk after a restart would list
 * shells that no longer exist, which is worse than listing none. A terminal
 * outlives its CLIENT, not the machine — and the machine restarting is a thing a
 * person can see, unlike a socket dropping.
 *
 **/

/** How much scrollback a terminal keeps for a client that reconnects. Bytes
 *  rather than lines, because a line is not a bounded quantity — one `cat` of a
 *  minified bundle is a single line that would otherwise be held forever. */
const BUFFER_BYTES = 256 * 1024

/** What a client is told about a shell. The PTY itself never crosses the wire.
 *  Declared in `@hoshi/shared` and aliased here, like every other shape both
 *  sides of the machine wire read. */
export type { TerminalInfo } from '../../wire/index.js'

interface Terminal extends TerminalInfo {
  pty: IPty
  /** Recent output, capped at BUFFER_BYTES — what a reconnecting client is sent
   *  before any new bytes, so it sees what it missed rather than a blank screen. */
  buffer: Buffer
  /** Everyone currently watching. A terminal with no listeners keeps running and
   *  keeps buffering; that is the difference between this and a socket. */
  listeners: Set<(chunk: string) => void>
  /** Told once, when the shell ends. Separate from `listeners` because a client
   *  needs to distinguish "the shell printed nothing for a while" from "the
   *  shell is over" — and the SSE bus, which also carries the news, may arrive
   *  after the socket has already gone quiet. */
  enders: Set<(exitCode: number) => void>
  /** Somebody has typed a line here and not pressed enter yet.
   *
   *  The one thing the agent's mirror has to know (./agent-shell.ts): after
   *  echoing, it nudges the shell to reprint its prompt BELOW what it wrote, so
   *  a later repaint cannot clear it. That nudge is a newline, and a newline
   *  sent while a person is half-way through typing would submit their line for
   *  them. So the mirror skips the nudge while this is true, and the person's
   *  own enter moves the prompt on instead. */
  typing: boolean
  /** Set once the process exits, so the row can say so before it is cleared. */
  exitCode: number | null
}

const terminals = new Map<string, Terminal>()

/**
 *
 * `node-pty` is a NATIVE module, and the harness must start on a machine where
 * it failed to build rather than take the whole daemon down with it — the same
 * degrade-don't-die rule every other optional capability follows (the browser
 * plugin without Chromium, voice without its model). Imported on first use so
 * the cost is paid by the first person to open a shell, not by every boot.
 *
 **/
let ptyModule: typeof import('node-pty') | null = null
let ptyError: string | null = null

async function pty(): Promise<typeof import('node-pty')> {
  if (ptyModule) return ptyModule
  if (ptyError) throw new Error(ptyError)
  try {
    ptyModule = await import('node-pty')
    return ptyModule
  } catch (error) {
    ptyError = `Terminals are unavailable on this machine: ${(error as Error).message}`
    throw new Error(ptyError)
  }
}

/** Whether this machine can host a shell at all — so a client can say why the
 *  aside is empty instead of offering a button that always fails. */
export function terminalsAvailable(): boolean {
  return ptyError === null
}

function toInfo(terminal: Terminal): TerminalInfo {
  const { id, shell, directory, createdAt } = terminal
  return terminal.agent ? { id, shell, directory, createdAt, agent: true } : { id, shell, directory, createdAt }
}

export function listTerminals(): TerminalInfo[] {
  return [...terminals.values()].map(toInfo)
}

function announce(): void {
  publishMachineEvent('terminals.changed', { terminals: listTerminals() })
}

/** The user's own shell, which is the only correct default: a person opening a
 *  terminal on their machine expects the prompt they configured, not ours. */
function defaultShell(): string {
  return process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash')
}

/**
 *
 * What a shell is started with, and why any of it is here.
 *
 * `TERM` is the one a PTY cannot do without — a program reads it to decide
 * whether it may move the cursor at all. The rest is the difference between a
 * terminal that CAN show colour and one that does: nearly every modern CLI
 * checks for a truecolor terminal or an explicit force flag before it emits a
 * single escape, and a machine's shell answers none of those questions by
 * default. So `git`, `ls`, `npm`, `eslint` and every test runner came out grey,
 * in a terminal whose whole point is watching them work.
 *
 * `LS_COLORS` is set only when nothing else did: `dircolors` is a per-user
 * choice and a machine that has one keeps it. The value here is the GNU
 * default's shape with the palette's own hues — directories blue, executables
 * green, archives red, links cyan — so it agrees with the sixteen the client
 * renders (`packages/ui/app/lib/terminal.ts`).
 *
 **/
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    /** BSD tools (`ls` on macOS, where a developer's own machine runs). */
    CLICOLOR: '1',
    /** The node ecosystem's own flag — chalk, picocolors, and everything on
     *  them. Without it a piped-looking stdout stays plain. */
    FORCE_COLOR: '1',
  }
  env.LS_COLORS ||=
    'di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=1;31:sg=1;31:tw=1;34:ow=1;34:' +
    '*.tar=1;31:*.tgz=1;31:*.zip=1;31:*.gz=1;31:*.bz2=1;31:*.xz=1;31:*.7z=1;31:' +
    '*.jpg=1;35:*.png=1;35:*.gif=1;35:*.svg=1;35:*.webp=1;35:*.mp4=1;35:*.pdf=1;35'
  return env
}

export async function openTerminal(options: {
  directory: string
  shell?: string
  cols?: number
  rows?: number
  agent?: boolean
}): Promise<TerminalInfo> {
  const { spawn } = await pty()
  const shell = options.shell || defaultShell()
  /** The person's own configuration is sourced first and only the prompt is
   *  ours — see ./prompt.ts, which also says how to turn that off. */
  const prompt = await promptSetup(shell)
  const child = spawn(shell, prompt.args, {
    name: 'xterm-256color',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.directory,
    env: { ...shellEnv(), ...prompt.env },
  })

  const terminal: Terminal = {
    id: randomUUID(),
    shell,
    directory: options.directory,
    ...(options.agent ? { agent: true } : {}),
    createdAt: new Date().toISOString(),
    pty: child,
    buffer: Buffer.alloc(0),
    listeners: new Set(),
    enders: new Set(),
    typing: false,
    exitCode: null,
  }
  terminals.set(terminal.id, terminal)

  child.onData((data) => {
    /**
     *
     * Buffer first, then fan out. A listener that throws must not cost the
     * scrollback the bytes it was about to receive.
     *
     **/
    terminal.buffer = Buffer.concat([terminal.buffer, Buffer.from(data, 'utf8')])
    if (terminal.buffer.length > BUFFER_BYTES) {
      terminal.buffer = terminal.buffer.subarray(terminal.buffer.length - BUFFER_BYTES)
    }
    for (const listener of terminal.listeners) {
      try {
        listener(data)
      } catch {
        /** A dead socket is not this terminal's problem. */
      }
    }
  })

  child.onExit(({ exitCode }) => {
    terminal.exitCode = exitCode
    terminals.delete(terminal.id)
    for (const ender of terminal.enders) {
      try {
        ender(exitCode)
      } catch {
        /** A dead socket is not this terminal's problem. */
      }
    }
    announce()
  })

  announce()
  return toInfo(terminal)
}

export function writeTerminal(id: string, data: string): boolean {
  const terminal = terminals.get(id)
  if (!terminal) return false
  /** Enter ends a line; anything else starts one. Approximate on purpose — its
   *  only consumer is a cosmetic nudge, and being wrong costs a prompt in the
   *  wrong place, never a command nobody typed. */
  if (data) terminal.typing = !/[\r\n]$/.test(data)
  terminal.pty.write(data)
  return true
}

/** Whether a person has a half-typed line in this shell right now. */
export function terminalIsBeingTyped(id: string): boolean {
  return terminals.get(id)?.typing ?? false
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const terminal = terminals.get(id)
  if (!terminal || cols < 1 || rows < 1) return false
  try {
    terminal.pty.resize(cols, rows)
  } catch {
    /** The process exited between the lookup and the resize. */
    return false
  }
  return true
}

/** Attach a listener, and hand back everything the terminal has said so far —
 *  in that order, so nothing printed between the two is lost. */
export function attachTerminal(
  id: string,
  onData: (chunk: string) => void,
  onEnd?: (exitCode: number) => void,
): { replay: string; detach: () => void } | null {
  const terminal = terminals.get(id)
  if (!terminal) return null
  terminal.listeners.add(onData)
  if (onEnd) terminal.enders.add(onEnd)
  return {
    replay: terminal.buffer.toString('utf8'),
    detach: () => {
      terminal.listeners.delete(onData)
      if (onEnd) terminal.enders.delete(onEnd)
    },
  }
}

/**
 *
 * Write into a terminal's transcript without writing to its PROCESS.
 *
 * The one thing a PTY has no way to express: text that appears on the screen
 * and in the scrollback, but that the shell never read. That is exactly what
 * the agent's mirror is — the agent ran the command elsewhere, and this is the
 * shell being told about it — and sending it to the process instead would
 * execute it a second time.
 *
 **/
export function echoTerminal(id: string, text: string): boolean {
  const terminal = terminals.get(id)
  if (!terminal) return false
  terminal.buffer = Buffer.concat([terminal.buffer, Buffer.from(text, 'utf8')])
  if (terminal.buffer.length > BUFFER_BYTES) {
    terminal.buffer = terminal.buffer.subarray(terminal.buffer.length - BUFFER_BYTES)
  }
  for (const listener of terminal.listeners) {
    try {
      listener(text)
    } catch {
      /** A dead socket is not this terminal's problem. */
    }
  }
  return true
}

/** The shell the agent's work is shown in for one directory, opened the first
 *  time the agent runs a command there. One per project the agent has actually
 *  worked in, alive for as long as the machine is — the same lifetime the
 *  process registry has, and bounded by the same small number. */
export function agentTerminalFor(directory: string): TerminalInfo | undefined {
  return [...terminals.values()].find((terminal) => terminal.agent && terminal.directory === directory)
}

export function killTerminal(id: string): boolean {
  const terminal = terminals.get(id)
  if (!terminal) return false
  try {
    terminal.pty.kill()
  } catch {
    /** Already gone; `onExit` has done, or will do, the bookkeeping. */
  }
  terminals.delete(id)
  announce()
  return true
}

/** Every shell this machine is running, killed — for a shutdown that should not
 *  leave orphaned processes behind it. */
export function killAllTerminals(): void {
  for (const id of [...terminals.keys()]) killTerminal(id)
}
