import { defineEventHandler } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { listProcesses } from './processes.js'

/** Every process this machine has spawned via the agent's `process_start` tool
 *  (./tools.ts) — running, exited, failed, or explicitly stopped. Status
 *  is reconciled against the OS on every call, not just replayed from disk —
 *  the Processes panel (CYB-99). Deliberately scoped to processes started
 *  through that one mechanism, never a general OS process monitor. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return { processes: await listProcesses() }
})
