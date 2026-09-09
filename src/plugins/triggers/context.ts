import type { UnattendedContext } from '../../kernel/host-ports.js'

/**
 * ── What this plugin was handed at setup ─────────────────────────────────────
 *
 * A route is a plain handler with no host in scope, and two of them need what
 * only the host has: firing a schedule by hand is the same act as firing it on
 * time, so it has to go through the same door (dispatch, startWorkflow).
 *
 * Captured once at setup rather than read from the kernel directly: a plugin
 * reaching into the kernel's own port registry would be reaching around its
 * own host API, and the next plugin would copy it.
 *
 **/
let captured: UnattendedContext = {}

export function rememberContext(unattended: UnattendedContext): void {
  captured = unattended
}

export function unattended(): UnattendedContext {
  return captured
}
