import type { MachineState } from '../wire/index.js'
import { listProviderStatuses } from './providers.js'
import { publishMachineEvent } from './events.js'
import { ports } from './host-ports.js'
import { readSetupCompleted } from './setup.js'

/**
 * ── The machine's connect-time state snapshot ────────────────────────────────
 *
 * The FIRST event every `/events` subscriber receives (`machine.state`), and
 * re-published whenever a field changes. It is what lets a client route purely
 * off the stream: connect → read the snapshot → enter the panel, offer to
 * connect a provider, or open first-boot onboarding. No probe polling, ever.
 *
 * This used to carry `opencode`, `opencodeDegraded`, `opencodeRestarting` and
 * `restartPending` — four fields describing whether a SECOND PROCESS was up,
 * warm, deliberately cycling, or about to be. All four are gone with it. The
 * engine is a module inside this server (docs/HARNESS_MIGRATION.md), so if the
 * sidecar can answer this request at all, the runtime behind it exists; there
 * is nothing left to wait for and nothing that can restart underneath the user.
 *
 * What replaces them is the question a client actually still has to ask: is
 * this machine set up enough to be useful?
 *
 * The shape itself is `@hoshi/shared`'s, the wire contract both sides import,
 * so a field added here is a compile error in every client rather than a
 * snapshot they silently never read.
 *
 **/

export type { MachineState } from '../wire/index.js'

export async function collectMachineState(): Promise<MachineState> {
  const [providers, setupComplete] = await Promise.all([listProviderStatuses(), readSetupCompleted()])
  const usable = providers.some((provider) => provider.connected && provider.models.length > 0)
  return {
    ready: usable,
    needsProvider: !usable,
    setupComplete,
    version: process.env.MACHINE_VERSION ?? null,
    plugins: ports().pluginStatuses?.() ?? [],
  }
}

/** Collect and broadcast the current snapshot to every live `/events`
 *  subscriber. Mutation paths that change a snapshot field call this in the
 *  same change that mutates (the machine-events rule). */
export async function publishMachineState(): Promise<MachineState> {
  const state = await collectMachineState()
  publishMachineEvent('machine.state', { state })
  return state
}

/** The provider list changed — announce it the way the provider routes do:
 *  `provider.updated` so the Providers surface refetches, then the state
 *  snapshot, whose `ready` is computed from that list. Here rather than in
 *  providers.ts (which cannot import this module back) so the one plugin whose
 *  providers come and go with a socket — the local-models relay — triggers the
 *  kernel-owned announcements instead of publishing kernel event types itself,
 *  which the prefixed plugin bus rightly forbids. */
export async function publishProvidersChanged(providerId: string | null): Promise<void> {
  publishMachineEvent('provider.updated', { providerId })
  await publishMachineState()
}
