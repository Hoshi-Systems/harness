import { definePlugin } from '../define.js'
import { bind } from './host.js'
import { memoryMirror } from './mirror.js'
import { memoryTools, memoryToolNames } from './tools.js'

import route_memory_id_delete from './memory.id.delete.js'
import route_memory_id_get from './memory.id.get.js'
import route_memory_id_patch from './memory.id.patch.js'
import route_memory_id_document_get from './memory.id.document.get.js'
import route_memory_index_get from './memory.index.get.js'
import route_memory_index_post from './memory.index.post.js'

export default definePlugin({
  name: 'memory',
  description: "The machine's own notes, and the knowledge somebody else curates for it",

  uses: ['orgKnowledge'],

  setup(host) {
    bind(host)
    /**
     *
     * The agent's `memory_*` tools and the app's `/memory` routes are two
     * surfaces onto ONE store, and this is now the only place that is true:
     * the tools used to live in a separate package with a second copy of the
     * store behind them (docs/STRUCTURE_REVIEW.md H-08).
     *
     **/
    host.tools.add(memoryTools, memoryToolNames)

    host.routes.delete('/memory/:id', route_memory_id_delete)
    host.routes.get('/memory/:id', route_memory_id_get)
    host.routes.patch('/memory/:id', route_memory_id_patch)
    host.routes.get('/memory/:id/document', route_memory_id_document_get)
    host.routes.get('/memory', route_memory_index_get)
    host.routes.post('/memory', route_memory_index_post)

    /**
     *
     * The `org` scope is a shelf this plugin keeps but does not fill. Whoever
     * fetches curated knowledge — an organization's, through its Platform
     * plugin — hands it over on this port, and this plugin answers the
     * reverse question, `orgKnowledge`, when the agent wants to propose an
     * entry back. Neither side imports the other; a machine with nobody behind
     * it has an empty shelf and a `memory_save` to org scope that says so.
     *
     **/
    host.provide({ memoryMirror })
  },
})
