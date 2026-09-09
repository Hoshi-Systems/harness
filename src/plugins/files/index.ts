import { definePlugin } from '../define.js'
import list from './files.list.get.js'
import read from './files.read.get.js'
import render from './files.render.get.js'
import search from './files.search.get.js'

/**
 * ── The workspace, as a person browses it ────────────────────────────────────
 *
 * The file tree, the viewer, and search. Read-only by design: writing is the
 * agent's job through its tools, where permissions apply. A client that could
 * write here would be a way around the approver.
 *
 **/
export default definePlugin({
  name: 'files',
  description: 'The file tree, viewer and search',

  setup(host) {
    host.routes.get('/files/list', list)
    host.routes.get('/files/read', read)
    host.routes.get('/files/render', render)
    host.routes.get('/files/search', search)
  },
})
