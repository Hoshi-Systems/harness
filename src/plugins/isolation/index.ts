import { definePlugin } from '../define.js'
import route_isolation_get from './isolation.get.js'

/**
 * ── The isolation reading ────────────────────────────────────────────────────
 *
 * One route, and it exists because a decision was blocked on a fact nobody
 * could reach: whether the hosts Hoshi actually runs on could give each machine
 * its own kernel.
 *
 * A plugin rather than a kernel concern for the usual reason — a machine that
 * should not tell its owner anything about the host it runs on installs
 * everything except this one, and nothing else changes.
 *
 **/
export default definePlugin({
  name: 'isolation',
  description: 'What this machine’s host can sandbox',

  setup(host) {
    host.routes.get('/isolation', route_isolation_get)
  },
})
