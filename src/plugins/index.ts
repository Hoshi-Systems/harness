import type { RegisteredPlugin } from './define.js'
import catalogue from './catalogue/index.js'
import web_control from './web-control/index.js'
import workflows from './workflows/index.js'
import git from './git/index.js'
import voice from './voice/index.js'
import relay from './relay/index.js'
import routing from './routing/index.js'
import sessions from './sessions/index.js'
import mcp from './mcp/index.js'
import goals from './goals/index.js'
import images from './images/index.js'
import engagements from './engagements/index.js'
import memory from './memory/index.js'
import triggers from './triggers/index.js'
import services from './services/index.js'
import terminal from './terminal/index.js'
import files from './files/index.js'
import desktop from './desktop/index.js'
import isolation from './isolation/index.js'
import context_links from './context-links/index.js'

/**
 * ── The first-party plugins ──────────────────────────────────────────────────
 *
 * Everything the harness itself ships. "Plugin" here means a unit with a declared
 * surface and its own lifecycle, not "optional" — the value is the seam. What a
 * machine does because it belongs to an organization is not here: those plugins
 * are loaded into the daemon from outside (`daemon/load.ts`), and a harness
 * running only this list is a complete machine that answers to nobody.
 *
 * Order matters only for boot narration; nothing here may depend on another
 * plugin (docs/decisions/0002-own-harness.md). If two need to share, the shared thing
 * belongs in the kernel.
 *
 **/
export const firstParty: RegisteredPlugin[] = [
  catalogue,
  context_links,
  desktop,
  engagements,
  files,
  git,
  goals,
  images,
  isolation,
  mcp,
  memory,
  relay,
  routing,
  services,
  sessions,
  terminal,
  triggers,
  voice,
  web_control,
  workflows,
]

export { definePlugin, hostBinding, isOwnPlugin } from './define.js'
export type { CapabilityDeclaration, Plugin, PluginHost, PluginToolContext, RegisteredPlugin, SystemDependency } from './define.js'
export { bindTools, defineHoshiTool, jsonish, z } from './define-tool.js'
export type {
  HoshiToolContext,
  HoshiToolDefinition,
  HoshiToolFactories,
  HoshiToolFactory,
  HoshiToolResult,
  HoshiToolSet,
  MachineCapabilities,
} from './define-tool.js'
export { machineToolContext } from './tool-context.js'
export type { PluginStatus, PluginState } from './registry.js'
