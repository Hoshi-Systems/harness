import { definePlugin } from '../define.js'
import { sessionTools, sessionToolNames } from './tools.js'

/**
 * ── The session, as something the turn inside it can act on ──────────────────
 *
 * Sessions themselves belong to the kernel — it creates them, streams them and
 * owns their routes. What is here is the other direction: the two tools that
 * let the turn RUNNING in a session name it and read it.
 *
 * A plugin rather than a kernel import for the ordinary reason (docs/
 * docs/decisions/0002-own-harness.md): the kernel runs turns, and which tools a machine
 * happens to offer is not its business. It owns no routes, and that is not a
 * gap — every one of these facts is already on the wire under `/sessions`, and
 * a second way to reach them would be a second thing to keep true.
 *
 **/
export default definePlugin({
  name: 'sessions',
  description: 'The session a turn is running in, as tools that turn can call',

  setup(host) {
    host.tools.add(sessionTools, sessionToolNames)
  },
})
