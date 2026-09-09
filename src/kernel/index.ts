/**
 * ── The kernel's public surface ──────────────────────────────────────────────
 *
 * Everything a host — the daemon's own routes and its plugins — is allowed to
 * reach for. One barrel rather than deep paths into the package, so what the
 * kernel promises is a list somebody can read, and moving a file inside it is
 * not a breaking change.
 *
 **/

export * from './activity.js'
export * from './api-error.js'
export * from './archetypes.js'
export * from './attachments.js'
export * from './auth.js'
export * from './body.js'
export * from './boot-narration.js'
export * from './catalogue.js'
export * from './cgroup.js'
export * from './checkouts.js'
export * from './compaction.js'
export * from './config-key.js'
export * from './dotenv.js'
export * from './events.js'
export * from './github-copilot.js'
export * from './history.js'
export * from './install-policy.js'
export * from './json-store.js'
export * from './loopback-token.js'
export * from './machine-state.js'
export * from './setup.js'
export * from './messages.js'
export * from './model.js'
export * from './permissions.js'
export * from './asset-scope.js'
export * from './project-assets.js'
export * from './reasoning.js'
export * from './skill-sources.js'
export * from './preferences.js'
export * from './profile.js'
export * from './provider-discovery.js'
export * from './provider-login.js'
export * from './provider-params.js'
export * from './providers.js'
export * from './rate-limit.js'
export * from './replies.js'
export * from './secrets.js'
export * from './serialize.js'
export * from './client-session.js'
export * from './session-actors.js'
export * from './session-secret.js'
export * from './session-titles.js'
export * from './ssh-identity.js'
export * from './sessions.js'
export * from './spend.js'
export * from './instructions.js'
export * from './store.js'
export * from './subagents.js'
export * from './system.js'
export * from './text.js'
export * from './timeline.js'
export * from './tool-output.js'
export * from './tool-patterns.js'
export * from './tools.js'
export * from './starters.js'
export * from './suggested-integrations.js'
export * from './turns.js'
export * from './upgrade-auth.js'
export * from './usage.js'
export * from './workspace.js'
export * from './workspace-paths.js'
export * from './ws-bridge.js'

/**
 *
 * The host's side of the seam (kernel/ports.ts). `ports()` itself is NOT
 * exported: reading the installed ports from outside would be a way around
 * whatever installed them.
 *
 **/
export { configureKernel, type KernelPorts, type OrgProvider, type UnattendedContext } from './host-ports.js'

/** The two narrow readers a plugin needs off that seam — see
 *  kernel/platform-access.ts for why they are here and not in nine plugins. */
export { platform, readPlatformErrorMessage } from './platform-access.js'
