/**
 *
 * With websocket upgrades on, an abruptly
 * disconnecting client (closed laptop, killed tab, dropped Wi-Fi) can surface
 * as an UNHANDLED socket error — ECONNRESET/EPIPE bubbling out of the upgraded
 * TCP stream — which would take the whole sidecar down. Those are routine
 * network weather, not bugs: swallow exactly them, keep crashing on everything
 * else (a silent catch-all here would hide real defects).
 *
 **/
const ROUTINE_SOCKET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

function isRoutineSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && ROUTINE_SOCKET_ERRORS.has(code)
}

/** Install the process-level guards. The DAEMON's job, not a route's: these are
 *  about the process staying alive, and whoever owns the process owns them. */
export function guardProcess(): void {
  process.on('uncaughtException', (error, origin) => {
    if (isRoutineSocketError(error)) {
      console.warn(`[machine-api] ignored ${(error as NodeJS.ErrnoException).code} from a dropped connection`)
      return
    }
    console.error(`[machine-api] fatal (${origin}):`, error)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    if (isRoutineSocketError(reason)) {
      console.warn(`[machine-api] ignored ${(reason as NodeJS.ErrnoException).code} from a dropped connection`)
      return
    }
    console.error('[machine-api] fatal (unhandledRejection):', reason)
    process.exit(1)
  })
}
