import { bindTools } from '../define-tool.js'
import type { PluginToolContext } from '../define.js'
import type { ToolSet } from 'ai'
import { machineToolContext } from '../tool-context.js'
import { uiTools } from './ui-tools.js'

/**
 * ── The generative UI a turn can emit ────────────────────────────────────────
 *
 * `ui_render`, `ui_ask` and `ui_html` — the three tools behind the session's
 * interactive cards, contributed to the kernel through its tool ports rather
 * than imported by it: the kernel runs turns, and which tools a machine happens
 * to offer is not its business.
 *
 * This used to bind the WHOLE registry — browser, git, process, image, router,
 * user and ui, every tool the machine had, all contributed by this one plugin.
 * That is what let a degraded `web-control` still offer eight browser tools
 * (docs/STRUCTURE_REVIEW.md H-08). Each group sits with the plugin that owns
 * its domain now, and this one owns the widgets.
 *
 * The capabilities a tool body needs from the machine come from
 * ../tool-context.ts, which every other plugin's tools use too.
 *
 **/

export function widgetTools(context: PluginToolContext): ToolSet {
  return bindTools(uiTools, machineToolContext(context))
}

export function widgetToolNames(): string[] {
  return Object.keys(uiTools)
}
