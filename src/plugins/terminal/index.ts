import { definePlugin } from '../define.js'
import { mirrorAgentCall } from './agent-shell.js'
import { listTerminals, terminalsAvailable } from './terminals.js'
import route_terminals_index_get from './terminals.index.get.js'
import route_terminals_index_post from './terminals.index.post.js'
import route_terminals_id_delete from './terminals.id.delete.js'
import route_terminals_id_socket from './terminals.id.socket.all.js'

/**
 *
 * Shells on the machine, and the socket a person drives one through.
 *
 * Its own plugin rather than a corner of `services`, which owns processes the
 * AGENT started and can only watch and stop. A terminal is the opposite
 * relationship — a person typing into the machine directly — and the two share
 * nothing but the word "process".
 *
 **/
export default definePlugin({
  name: 'terminal',
  description: 'Shells on the machine, and the sockets that drive them',

  setup(host) {
    /**
     *
     * The agent's own `bash` calls, shown in a shell a person can take over
     * (./agent-shell.ts). Answered here rather than in the kernel because a
     * machine that cannot host a PTY must still run every command it always
     * ran — this plugin simply has nothing to offer, and the port stays unset.
     *
     **/
    host.provide({ agentShell: mirrorAgentCall })

    host.routes.get('/terminals', route_terminals_index_get)
    host.routes.post('/terminals', route_terminals_index_post)
    host.routes.delete('/terminals/:id', route_terminals_id_delete)
    host.routes.all('/terminals/:id/socket', route_terminals_id_socket)

    /**
     *
     * A client that has just connected learns what is already running, on the
     * stream rather than by asking — same opening frame every other plugin
     * with live state sends.
     *
     **/
    host.events.onConnect((push) => {
      if (!terminalsAvailable()) return
      push({ type: 'terminals.changed', properties: { terminals: listTerminals() } })
    })
  },
})
