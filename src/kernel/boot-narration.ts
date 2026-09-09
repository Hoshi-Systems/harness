import { publishMachineEvent } from './events.js'

/**
 * ── The machine's own boot narration ─────────────────────────────────────────
 *
 * The Platform has a boot log (apps/api/utils/machine-log.ts) and it is a good
 * one, but it can only narrate what the PLATFORM does: request a container,
 * watch the orchestrator, probe the ingress. Its story ends at "Machine is
 * ready" — and that is precisely where the user's wait often *begins*, because
 * the container answering is not the agent runtime being usable. OpenCode binds
 * its port early and then spends a network-bound stretch resolving the provider
 * catalog; the client holds its boot screen through all of it
 * (machine.state.opencode), showing a Platform log whose last line says the
 * machine is ready. "The machine is not telling me exactly what it's doing" is
 * that gap, exactly.
 *
 * This module is the machine's half of the story. Same wire shape as the
 * Platform's entries (`MachineLogEntry`) so a client can render one continuous
 * feed by concatenating the two, and the same dedupe rule: a line identical to
 * the last one bumps its `count` instead of appending, so a 2s retry tick reads
 * as "×14", not fourteen lines of noise.
 *
 * In-memory and bounded, like the Platform's: this is the story of the CURRENT
 * boot, not durable history.
 *
 **/

export type BootLogLevel = 'info' | 'success' | 'error'

export interface BootLogLine {
  id: number
  ts: string
  level: BootLogLevel
  message: string
  /** How many consecutive times this exact line repeated. */
  count: number
}

const CAP = 60

let lines: BootLogLine[] = []
let seq = 0

/** Append a line to the machine's boot narration and push it to every live
 *  `/events` subscriber. Safe to call on a hot tick — an identical consecutive
 *  message bumps the existing line rather than appending a new one, and the
 *  re-emitted line carries the same `id` so clients upsert in place. */
export function narrateBoot(level: BootLogLevel, message: string): void {
  const last = lines[lines.length - 1]
  let line: BootLogLine
  if (last && last.message === message && last.level === level) {
    last.count += 1
    last.ts = new Date().toISOString()
    line = last
  } else {
    line = { id: ++seq, ts: new Date().toISOString(), level, message, count: 1 }
    lines.push(line)
    if (lines.length > CAP) lines.splice(0, lines.length - CAP)
  }
  publishMachineEvent('machine.boot.line', { line })
}

/** The narration so far — pushed to each `/events` connection on connect, so a
 *  client that arrives mid-boot (or reconnects) sees the whole story rather
 *  than only what happens to follow. */
export function bootNarration(): BootLogLine[] {
  return lines
}

/** Start a fresh narration — called when a deliberate restart begins a new
 *  runtime lifecycle, so the feed reads as THIS cycle's story rather than an
 *  accumulation across every restart of the machine's uptime. Announced so
 *  connected clients drop what they were showing too. */
export function resetBootNarration(): void {
  lines = []
  publishMachineEvent('machine.boot.reset', {})
}
