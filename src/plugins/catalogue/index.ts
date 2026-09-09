import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { definePlugin } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import { catalogueTools } from './tools.js'

/**
 * ── Skills and commands the machine writes for itself ───────────────────────────────────────
 *
 * The machine authoring its own catalogue: `skill_create` writes a new
 * SKILL.md, `command_create` self-authors a slash command. The kernel serves
 * the catalogue; this is what adds to it.
 *
 * A plugin rather than a kernel concern because it is a POLICY: a machine that
 * should not let an agent write its own skills installs this one and nothing
 * else changes (docs/STRUCTURE_REVIEW.md H-08).
 *
 **/
export default definePlugin({
  name: 'catalogue',
  description: 'Skills and commands the machine writes for itself',

  setup(host) {
    host.tools.add(
      (context): ToolSet => bindTools(catalogueTools, machineToolContext(context)),
      () => Object.keys(catalogueTools),
    )
  },
})
