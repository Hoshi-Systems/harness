import { definePlugin } from '../define.js'
import { mcpTools } from './servers.js'
import listServers from './mcp.index.get.js'
import addServer from './mcp.index.post.js'
import updateServer from './mcp.name.patch.js'
import reconnectServer from './mcp.name.reconnect.post.js'
import removeServer from './mcp.name.delete.js'
import registry from './mcp.registry.get.js'
import oauthCallback from './mcp.oauth.callback.get.js'
import startOauth from './mcp.name.oauth.post.js'
import disconnectOauth from './mcp.name.oauth.delete.js'
import { refreshExpiringTokens } from './oauth-connect.js'
import { connectorStatus, installRemoteServer } from './servers.js'
import { beginDcrAuthorization } from './mcp.name.oauth.post.js'

/**
 * ── MCP connectors ───────────────────────────────────────────────────────────
 *
 * Third-party tool servers, offered to a turn alongside the built-ins.
 *
 * The first area to become a plugin, and it was chosen because it exercises the
 * whole contract at once: it contributes TOOLS, it owns ROUTES, and it used to
 * be something the kernel imported directly — `buildTools` reached into an MCP
 * module, which meant a harness could not ship without connector support it
 * might never use.
 *
 * Nothing about a turn changes when this is absent. That is the test of the
 * seam: an unreachable connector already had to cost its own tools and never
 * the whole conversation, and a connector plugin that is not installed is the
 * same fact one level up.
 *
 **/
export default definePlugin({
  name: 'mcp',
  description: 'Third-party MCP servers as tools',
  capability: { id: 'mcp.connectors', title: 'MCP connectors', description: 'Third-party MCP servers as tools' },

  setup(host) {
    /** The product-facing connector service. It is a port, not routes called
     * back through localhost, so an external plugin stays independent of this
     * plugin's storage and keeps its request context for OAuth redirects. */
    host.provide((current) => ({
      ...current,
      mcpConnectors: {
        install: installRemoteServer,
        beginDcrAuthorization,
        status: connectorStatus,
      },
    }))
    /**
     *
     * Built per turn rather than cached: a connector added a moment ago has to
     * be usable on the next message, with no restart. Connecting is why the
     * contribution is asynchronous.
     *
     **/
    host.tools.add(
      () => mcpTools(),
      /**
       *
       * Empty on purpose: a connector's tool names are only known once it has
       * been connected to, so the settings screen that lists what a machine can
       * do has never included them. Reporting guesses would be worse.
       *
       **/
      () => [],
    )

    host.routes.get('/mcp', listServers)
    host.routes.post('/mcp', addServer)
    host.routes.patch('/mcp/:name', updateServer)
    host.routes.post('/mcp/:name/reconnect', reconnectServer)
    host.routes.delete('/mcp/:name', removeServer)
    host.routes.get('/mcp/registry', registry)
    /**
     *
     * OAuth for remote connectors. The callback is registered BEFORE `/mcp/:name`
     * would ever see it — `/mcp/oauth/callback` has a literal second segment, and
     * a router that matched the parameter first would send a returning browser to
     * a connector named "oauth".
     *
     **/
    host.routes.get('/mcp/oauth/callback', oauthCallback)
    host.routes.post('/mcp/:name/oauth', startOauth)
    host.routes.delete('/mcp/:name/oauth', disconnectOauth)
    /** Renew what is close to expiring. On the machine's own timer: the
     *  no-polling rule is about the client↔machine wire. */
    host.jobs.every(5 * 60_000, refreshExpiringTokens)
  },
})
