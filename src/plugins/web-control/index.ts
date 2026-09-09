import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { definePlugin } from '../define.js'
import { bind } from './host.js'
import { machineToolContext } from '../tool-context.js'
import { chrome } from './chrome.js'
import { browserTools } from './tools.js'

/**
 * ── Browser control ──────────────────────────────────────────────────────────
 *
 * The plugin the system-dependency mechanism was built for. It declares the
 * browser it needs beside the code that needs it, the daemon verifies that
 * claim at every boot, and — now — it owns the eight tools that drive it.
 *
 * THAT LAST PART WAS THE WHOLE POINT AND IT WAS MISSING. The tools lived in the
 * tool registry package and were contributed by `widgets`, which declares no
 * browser and cannot be degraded by the absence of one. So a machine with no
 * Chromium reported `web-control: degraded — chromium is not installed` on
 * `machine.state` and offered the model `browser_navigate`, `browser_click`,
 * `browser_screenshot` and five more anyway — every one of them certain to
 * fail. Both facts came out of the same census run
 * (docs/STRUCTURE_REVIEW.md H-08).
 *
 * plugins/registry.ts states the rule this restores: a degraded plugin
 * contributes no tools, because "an agent that calls a tool and is told
 * 'unavailable' will try three more times and then apologise, which is worse
 * than never having seen it."
 *
 **/
export default definePlugin({
  name: 'web-control',
  description: 'Drive a real browser from a turn',
  system: [chrome],

  uses: ['display'],

  setup(host) {
    /**
     *
     * The display belongs to `desktop`, and the two are halves of one feature — read at launch
     * rather than at boot, because a browser is spawned per session.
     *
     **/
    bind(host)

    /**
     *
     * Reached only when the browser really is present: a degraded plugin's
     * setup never runs (plugins/registry.ts). Which is exactly why the tools
     * are registered HERE — the absence of a browser now withholds them
     * instead of merely being reported next to them.
     *
     **/
    host.log.info('chromium verified — browser control is available')
    host.tools.add(
      (context): ToolSet => bindTools(browserTools, machineToolContext(context)),
      () => Object.keys(browserTools),
    )
  },
})
