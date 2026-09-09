import { defineEventHandler } from 'h3'
import { anyTurnRunning } from '../kernel/index.js'
/**
 *
 * Liveness + version probe. The Platform's reconcile loop and status check hit
 * this to confirm the sidecar is up and to learn which machine image is running
 * (MACHINE_VERSION is baked into the image), so it can flag stale machines.
 *
 * `busy` is here for one reason: some Platform actions recreate the container,
 * and doing that mid-turn throws away work the person is watching happen. The
 * Platform cannot know — a turn is a live property of the machine — so it asks
 * on the probe it already makes. Unauthenticated like the rest of this route,
 * which is why it is a bare boolean: whether a machine is working right now is
 * not a secret, and anything more would be.
 *
 **/
export default defineEventHandler(() => ({
  ok: true,
  version: process.env.MACHINE_VERSION ?? null,
  busy: anyTurnRunning(),
}))
