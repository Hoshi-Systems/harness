import { definePlugin } from '../define.js'
import { recoverEngagements, sweepEngagements } from './engagements.js'
import route_engagements_id_get from './engagements.id.get.js'
import route_engagements_index_get from './engagements.index.get.js'
import { engagementToolNames, engagementTools } from './tools.js'

/** How often the backstop runs. Everything real is event-driven — a step
 *  settles when its own turn ends — so this only catches the two cases nothing
 *  can report: a step that overran its ceiling, and a turn that finished while
 *  the daemon was restarting and had nobody listening for it. */
const SWEEP_MS = 30_000

export default definePlugin({
  name: 'engagements',
  description: 'A declared process: specialists, what each owes, and who hands their result to whom',
  capability: { id: 'engagements.process', title: 'Engagement processes', description: 'A declared process: specialists, what each owes, and who hands their result to whom' },

  setup(host) {
    host.tools.add(engagementTools, engagementToolNames)
    host.routes.get('/engagements', route_engagements_index_get)
    host.routes.get('/engagements/:id', route_engagements_id_get)

    /**
     *
     * Boot recovery first, then a slow backstop. Deliberately NOT the shape the
     * previous runtime needed: there, every step had to be polled because the
     * runtime never volunteered anything. Here a step is a turn on this machine
     * and the turn says when it is done, so the timer is for the cases where
     * that message could not arrive at all.
     *
     **/
    host.jobs.once(() => recoverEngagements())
    host.jobs.every(SWEEP_MS, () => sweepEngagements())
  },
})
