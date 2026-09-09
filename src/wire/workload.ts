/**
 *
 * Workload wire types — checkout provisioning progress, notification quiet
 * hours, and an integration pack's linked external identity.
 *
 **/

/** One stage of the provisioning pipeline, as the machine reports it. */
export type StageStatus = 'queued' | 'running' | 'skipped' | 'passed' | 'failed'

/**
 * ── Agent inbox wire mappers ─────────────────────────────────────────────────
 *
 * Row → DTO for the two things a pack install accumulates once it starts
 * receiving work: the external identities linked to it, and the tasks it
 * dispatched. The install's OWN shape — credentials, config, webhook URLs —
 * belongs to utils/packs/store.ts, because that half is now keyed by what a
 * pack declares rather than by a fixed set of fields.
 *
 **/
export interface PackIdentity {
  id: string
  externalUserId: string
  externalUserLabel: string | null
  userId: number
  email: string
  name: string | null
  machineId: string | null
  machineName: string | null
  createdAt: string
}

export interface ProvisionStage {
  name: string
  status: StageStatus
  /** Truncated tail of the stage's combined stdout+stderr; null until it runs. */
  log: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface QuietHours {
  enabled: boolean
  /** 'HH:MM' in the account timezone. `start` after `end` wraps midnight. */
  start: string
  end: string
}
