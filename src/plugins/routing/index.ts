import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { definePlugin } from '../define.js'
import { machineToolContext } from '../tool-context.js'
import { routerTools } from './tools.js'

/**
 * ── Sizing a task before the agent recruits for it ───────────────────────────────────────
 *
 * `task_route` sizes a request into { complexity, archetype, tier } and
 * resolves the tier to a concrete model, through a fallback chain that never
 * blocks a turn: a local router model, then the machine's small model, then a
 * rubric the agent applies itself.
 *
 * The answer is a SUGGESTION the calling agent may override, which is exactly
 * why routing is an inspectable tool call rather than invisible prompt
 * machinery — and why it is a plugin a machine can do without
 * (docs/STRUCTURE_REVIEW.md H-08).
 *
 **/
export default definePlugin({
  name: 'routing',
  description: 'Sizing a task before the agent recruits for it',
  capability: { id: 'routing.task-sizing', title: 'Task routing', description: 'Sizing a task before the agent recruits for it' },

  setup(host) {
    host.tools.add(
      (context): ToolSet => bindTools(routerTools, machineToolContext(context)),
      () => Object.keys(routerTools),
    )
  },
})
