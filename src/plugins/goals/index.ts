import { definePlugin } from '../define.js'
import { getCurrentGoalForSession, isGoalActive } from './goals.js'
import { watchGoals } from './loop.js'
import route_goals_id_delete from './goals.id.delete.js'
import route_goals_id_pause_post from './goals.id.pause.post.js'
import route_goals_id_resume_post from './goals.id.resume.post.js'
import route_goals_index_get from './goals.index.get.js'
import route_goals_index_post from './goals.index.post.js'

export default definePlugin({
  name: 'goals',
  description: 'A standing objective the machine works toward on its own',

  setup(host) {
    /**
     *
     * A goal advances when a TURN finishes, not on a timer: the machine already
     * says so on its own bus, and polling every goal every few seconds was what
     * the previous runtime had to do because it never volunteered anything.
     * The boot sweep inside is the catch-up — a turn that settled while the
     * sidecar was restarting published into a process that no longer existed,
     * and the goal behind it would sit armed and idle forever.
     * An armed goal continues on its own, so its steps are not news — the
     * settle is the one moment worth telling anybody about.
     *
     **/
    host.provide((current) => ({
      ...current,
      claimsCompletion: async (sessionId) => {
        if (await current.claimsCompletion?.(sessionId)) return true
        const goal = await getCurrentGoalForSession(sessionId)
        return !!goal && isGoalActive(goal.status)
      },
    }))
    watchGoals()
    host.routes.delete('/goals/:id', route_goals_id_delete)
    host.routes.post('/goals/:id/pause', route_goals_id_pause_post)
    host.routes.post('/goals/:id/resume', route_goals_id_resume_post)
    host.routes.get('/goals', route_goals_index_get)
    host.routes.post('/goals', route_goals_index_post)
  },
})
