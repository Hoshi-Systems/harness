import type { ShellResult } from '@openharness/core'
import {
  agentTerminalFor,
  echoTerminal,
  openTerminal,
  terminalIsBeingTyped,
  terminalsAvailable,
  writeTerminal,
} from './terminals.js'

/**
 * ── The agent's shell ────────────────────────────────────────────────────────
 *
 * Every `bash` call the agent makes, shown in a real shell on the same folder
 * that a person can attach to and take over.
 *
 * The call itself runs where it always ran (kernel/tools.ts) — this only writes
 * what happened into the terminal's transcript, with `echoTerminal` rather than
 * `writeTerminal` because sending it to the shell's PROCESS would run the
 * command a second time.
 *
 * What that buys is the thing the terminal exists for: you open the Computer,
 * see the command the agent is running right now and everything it has run
 * before it, and when the agent pauses you type into the same prompt. Nothing
 * carries between the agent's own calls — a `bash` call gets a fresh shell —
 * so nothing is being pretended about here either.
 *
 **/

/** ANSI SGR: dim for the echoed command line, red for a non-zero exit. Written
 *  as escapes rather than through a palette because they ARE the protocol —
 *  this text goes into a terminal, and a terminal's colours are bytes. */
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

/** Line endings for a PTY: a bare `\n` moves down without returning, so every
 *  line after the first would start under the end of the last one. */
function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 *
 * Move the shell's prompt down past what was just echoed.
 *
 * Without this the mirror's text sits on the prompt's own line, and a shell
 * reprints that line whenever anything disturbs it — a window resize, a new
 * client attaching — clearing from the prompt down and taking the transcript
 * with it. An empty line submitted to the shell costs nothing and moves the
 * prompt below the text, which makes it ordinary scrollback that no repaint
 * touches.
 *
 * Skipped while somebody is half-way through typing: their enter will move the
 * prompt on by itself, and sending one for them would run whatever they had
 * started to write.
 *
 **/
function settle(id: string): void {
  if (terminalIsBeingTyped(id)) return
  writeTerminal(id, '\r')
}

/** Opening a shell is async and a tool call is not going to wait for one, so a
 *  directory's first command starts the shell and mirrors from the second. The
 *  alternative — holding the agent's command until a PTY spawns — would put a
 *  cosmetic feature in front of the machine's most-used tool. */
const opening = new Set<string>()

function ensure(directory: string): string | null {
  const existing = agentTerminalFor(directory)
  if (existing) return existing.id
  if (opening.has(directory) || !terminalsAvailable()) return null
  opening.add(directory)
  void openTerminal({ directory, agent: true })
    .catch(() => {
      /** No shell to show the work in; the work still runs. */
    })
    .finally(() => opening.delete(directory))
  return null
}

/**
 *
 * Echo one call. The command line goes in BEFORE it runs — a two-minute build
 * that showed nothing until it finished would be a worse view of the agent's
 * work than none — and the output follows when it lands.
 *
 **/
export function mirrorAgentCall(directory: string, command: string): { done(result: ShellResult | null): void } | null {
  const id = ensure(directory)
  if (!id) return null

  echoTerminal(id, `${DIM}$ ${crlf(command)}${RESET}\r\n`)
  return {
    done(result) {
      if (!result) {
        echoTerminal(id, `${RED}the call failed${RESET}\r\n`)
        settle(id)
        return
      }
      const body = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (body) echoTerminal(id, `${crlf(body.replace(/\n+$/, ''))}\r\n`)
      if (result.exitCode !== 0) echoTerminal(id, `${RED}exit ${result.exitCode}${RESET}\r\n`)
      settle(id)
    },
  }
}
