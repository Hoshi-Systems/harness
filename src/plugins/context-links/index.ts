import { definePlugin } from '../define.js'
import { subscribeMachineEvents } from '../../kernel/index.js'
import { contextTools, contextToolNames } from './tools.js'
import { expandLinks, forgetSession } from './links.js'
import route_links_index_post from './context.links.post.js'
import route_links_index_get from './context.links.get.js'
import route_links_id_delete from './context.links.id.delete.js'

/**
 *
 * Moving a passage of one conversation into another without copying it.
 *
 * A chat exists so a question can be asked without spending a task's context on
 * it; this is what makes that worth having in both directions. The link
 * ADDRESSES a session, a turn and a range, so the edge can be read from either
 * end — the receiver asks where this came from, the source asks what came of
 * it — and the receiving agent can reach past what it was handed.
 *
 * A plugin rather than kernel code because it owns a domain: a store, a tool,
 * three routes and two events. The kernel's only involvement is one port, which
 * exists because the message route is the kernel's and a message is where a link
 * is actually spent.
 *
 **/
export default definePlugin({
  name: 'context-links',
  description: 'Passing a passage of one conversation into another as a link, not a copy',
  capability: { id: 'context-links.passage', title: 'Context links', description: 'Passing a passage of one conversation into another as a link, not a copy' },

  setup(host) {
    host.provide((current) => ({
      ...current,
      /**
       *
       * `POST /sessions/:id/messages` is a kernel route, so the kernel asks
       * rather than imports. A machine without this plugin answers null and a
       * message carrying links is refused there — which is the honest outcome:
       * silently dropping them would send a question stripped of the thing it
       * was about.
       *
       **/
      contextLinks: () => ({
        expand: expandLinks,
      }),
    }))

    /**
     *
     * A deleted session must not leave links pointing into it. The excerpt is
     * what survives a deleted SOURCE — that is deliberate, and `readLink` says
     * so — but a link whose destination is gone can never be spent by anybody
     * and is only an edge to nothing.
     *
     **/
    subscribeMachineEvents((event) => {
      if (event.type !== 'session.deleted') return
      const sessionId = (event.properties as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string') void forgetSession(sessionId)
    })

    host.tools.add(contextTools, contextToolNames)

    host.routes.post('/context/links', route_links_index_post)
    host.routes.get('/context/links', route_links_index_get)
    host.routes.delete('/context/links/:id', route_links_id_delete)
  },
})
