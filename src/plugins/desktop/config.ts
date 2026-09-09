/**
 *
 * What this plugin can be configured with, and what it defaults to.
 *
 * It read `process.env.HOSHI_DESKTOP_PORT` through `Number(...)`, which answers
 * `NaN` for a typo — and a machine that binds websockify to NaN reports nothing
 * at all, on a plugin whose whole failure story is "say what is missing". The
 * env var is still what a machine image sets; what changed is that a bad value
 * is now a boot-time refusal with the value in it, rather than a port nobody
 * can connect to.
 *
 **/
export interface DesktopConfig {
  /** Where websockify offers the RFB stream as a WebSocket. Reserved in
   *  `listening-ports.ts` so it never surfaces as a user's dev server. */
  port: number
}

const DEFAULT_PORT = 4097

export function parseDesktopConfig(input: unknown): DesktopConfig {
  const raw = (input as { port?: unknown } | undefined)?.port ?? process.env.HOSHI_DESKTOP_PORT

  if (raw === undefined || raw === '') return { port: DEFAULT_PORT }

  const port = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return { port }
}

/** Bound at setup, read wherever the port is needed — the same reason
 *  `hostBinding` exists: most of a plugin is not its setup function. */
let current: DesktopConfig = { port: DEFAULT_PORT }

export function bindDesktopConfig(config: DesktopConfig): void {
  current = config
}

export function desktopConfig(): DesktopConfig {
  return current
}
