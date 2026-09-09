import { definePlugin } from '../define.js'
import pending from './widgets.pending.get.js'
import respond from './widgets.id.respond.post.js'
import { widgetTools, widgetToolNames } from './tools.js'

/**
 * ── Hoshi's own tools ────────────────────────────────────────────────────────
 *
 * The generative UI a turn can emit: a card or a form the agent puts on screen,
 * and the reply that comes back from it.
 *
 * It contributes TOOLS the same way the MCP connectors do, which is the point —
 * the kernel cannot tell Hoshi's own tools from a plugin's or a connector's,
 * and that is why none of them had to be built into it.
 *
 **/
export default definePlugin({
  name: 'widgets',
  description: 'The generative UI a turn can emit, and the replies it gets back',

  setup(host) {
    host.tools.add(widgetTools, widgetToolNames)
    host.routes.get('/widgets/pending', pending)
    host.routes.post('/widgets/:id/respond', respond)
  },
})
