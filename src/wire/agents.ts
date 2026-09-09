/**
 *
 * Agent-governance wire types — the org agent policy, delegation consent, and
 * the grants that share one session with someone else.
 *
 **/

export const AGENT_POLICY_MODES = ['deny', 'unattended-deny', 'ask'] as const

/** How much of the org agent policy applies to a machine. */
export type AgentPolicyMode = (typeof AGENT_POLICY_MODES)[number]

/** What a shared-session guest may do: watch, or drive. */
/** A value with the type derived from it, so the server that CHECKS an incoming
 *  level reads the same list the share dialog offers. */
export const SESSION_GRANT_LEVELS = ['observe', 'control'] as const
export type SessionGrantLevel = (typeof SESSION_GRANT_LEVELS)[number]

/** How a colleague's agent may reach mine: ask me first, run it, or refuse. */
export type DelegationConsent = 'ask' | 'auto' | 'block'

/** What a GUEST token is allowed to touch: one session, at one level, under one
 *  grant (job 12).
 *
 *  It is a CLAIM the Platform signs and the machine verifies, so it is a wire
 *  shape with two readers on opposite sides of a boundary that shares no code —
 *  which is exactly what this package is for. It used to be written out twice,
 *  each copy carrying a comment saying the other existed
 *  (docs/STRUCTURE_REVIEW.md P-05). */
export interface MachineTokenScope {
  machineId: string
  sessionId: string
  level: SessionGrantLevel
  /** The session_grants row this token bears. The machine checks it against its
   *  cached grant mirror on every request, which is what makes revocation
   *  immediate instead of "immediate once the token expires". */
  grantId: string
}

export interface SessionGrant {
  id: string
  machineId: string
  machineName: string | null
  sessionId: string
  level: SessionGrantLevel
  granteeUserId: number
  granteeEmail: string | null
  granteeName: string | null
  grantedBy: number
  grantedByEmail: string | null
  grantedByName: string | null
  expiresAt: string
  createdAt: string
}

export interface AgentPolicyRule {
  /** Stable slug. Named verbatim in the machine's refusal so a user can always
   *  find out which rule stopped them. */
  id: string
  mode: AgentPolicyMode
  /** Tool ids this covers (`bash`, `edit`, an MCP `server:tool`); `['*']` = any. */
  tools: string[]
  /** Globs matched against the call's subject — the command line, the file
   *  path, the URL. `['*']` = the whole tool, regardless of arguments. */
  patterns: string[]
  /** Why this exists, in the admin's own words. Shown to whoever gets refused. */
  description: string
  enabled: boolean
}

export interface AgentPolicy {
  rules: AgentPolicyRule[]
  auditRetentionDays: number
  version: number
  updatedAt: string | null
}

/** The org's floor, beside the agent policy (job 07). `allowAuto: false` is the
 *  "this org requires an explicit yes from a human" switch job 13 calls for: it
 *  downgrades every member's `auto` to `ask` without editing their rows, so
 *  turning it back on restores what they had chosen. */
export interface OrgDelegationPolicy {
  defaultConsent: DelegationConsent
  allowAuto: boolean
  /** Delegations one sender may raise against one receiver per day. */
  dailyCap: number
}
