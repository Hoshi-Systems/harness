/**
 * ── Capability Passport ─────────────────────────────────────────────────────
 *
 * A machine's compact, safe-to-render account of what it can do. It is a
 * projection of the runtime registry, not a second configuration store: status,
 * routes, and tool names are all read from the things that actually own them.
 */

export interface CapabilityPassport {
  schemaVersion: 1
  capabilities: Capability[]
}

export interface Capability {
  /** Stable, plugin-scoped identifier — for example `files.workspace`. */
  id: string
  title: string
  description: string
  owner: { kind: 'kernel' | 'plugin'; name: string }
  state: 'ready' | 'degraded'
  /** A human-readable reason when the capability is not ready. */
  reason: string | null
  requires: {
    system: Array<{ id: string; reason: string }>
    /** Kernel ports the owning plugin declares it reads. */
    ports: string[]
  }
  surfaces: {
    tools: string[]
    routes: Array<{ method: string; path: string }>
  }
}
