import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { machineToolContext } from '../tool-context.js'
import { processTools } from './tools.js'
import { definePlugin } from '../define.js'
import rootPreview from './preview.all.js'
import editorIndex from './editor.all.js'
import editorPath from './editor.path.all.js'
import editorStatus from './editor.status.get.js'
import proxyIndex from './proxy.port.all.js'
import proxyPath from './proxy.port.path.all.js'
import { listListeningPorts } from './listening-ports.js'
import { listProcesses } from './processes.js'
import { servicesSnapshot } from './services.js'
import { watchServices } from './watch.js'
import route_services_id_delete from './services.id.delete.js'
import route_services_id_patch from './services.id.patch.js'
import route_services_id_logs_get from './services.id.logs.get.js'
import route_services_id_restart_post from './services.id.restart.post.js'
import route_services_id_start_post from './services.id.start.post.js'
import route_services_id_stop_post from './services.id.stop.post.js'
import route_services_adopt_post from './services.adopt.post.js'
import route_services_index_get from './services.index.get.js'
import route_services_index_post from './services.index.post.js'
import route_processes_id_logs_get from './processes.id.logs.get.js'
import route_processes_id_stop_post from './processes.id.stop.post.js'
import route_processes_index_get from './processes.index.get.js'
import route_ports_get from './ports.get.js'

export default definePlugin({
  name: 'services',
  description: 'Processes, listening ports and preview servers',

  setup(host) {
    /**
     *
     * The agent's `process_*` tools, beside the routes and the watcher that
     * report the same processes to a client. Contributed by `widgets` until
     * now, which owns none of this (docs/STRUCTURE_REVIEW.md H-08).
     *
     **/
    host.tools.add(
      (context): ToolSet => bindTools(processTools, machineToolContext(context)),
      () => Object.keys(processTools),
    )
    /**
     *
     * The editor bridge and the preview proxy: both are websocket upgrades as
     * much as they are HTTP, which is why they are the last routes that could
     * move — the daemon had to be able to perform an upgrade first.
     * The absolute-path fallback: a preview page asking for /assets/app.css has
     * no idea it is behind a proxy, so an unmatched path belongs to whichever
     * preview the browser last opened.
     *
     **/
    host.routes.all('/**:path', rootPreview)
    host.routes.all('/editor', editorIndex)
    host.routes.all('/editor/**:path', editorPath)
    host.routes.get('/editor/status', editorStatus)
    host.routes.all('/proxy/:port', proxyIndex)
    host.routes.all('/proxy/:port/**:path', proxyPath)
    /**
     *
     * A listening port is somebody's preview URL, and a running process is work
     * they started and expect to still be there. Neither shows up as "busy" —
     * nothing is generating and nobody may be watching — so without this a
     * machine gets suspended out from under a dev server whose link somebody
     * else is about to open.
     *
     **/
    host.provide((current) => ({
      ...current,
      keepAwake: async () => {
        const reasons = [...((await current.keepAwake?.()) ?? [])]
        const [ports, processes] = await Promise.all([listListeningPorts(), listProcesses()])
        if (ports.length > 0) reasons.push('port')
        if (processes.length > 0) reasons.push('process')
        return reasons
      },
    }))

    // This plugin's own opening frame for a client that has just connected.
    // The services snapshot is derived (from the process registry and the live
    // socket scan), so — like ports and processes — it has no mutation moment to
    // diff against on connect. Without replaying it here, a reconnecting client
    // or one that has just switched machines keeps the previous snapshot until
    // the next mutation, because the store hydrates by GET only on its FIRST
    // subscriber, not on every reconnect (machine-events: each contributor
    // replays its own snapshot).
    host.events.onConnect(async (push) => {
      const [ports, processes, services] = await Promise.all([
        listListeningPorts(),
        listProcesses(),
        servicesSnapshot(),
      ])
      push({ type: 'ports.changed', properties: { ports } })
      push({ type: 'processes.changed', properties: { processes } })
      push({ type: 'services.changed', properties: services })
    })
    watchServices(host.jobs.every)

    // why it lives with processes and ports rather than with the file tree.
    host.routes.delete('/services/:id', route_services_id_delete)
    host.routes.patch('/services/:id', route_services_id_patch)
    host.routes.get('/services/:id/logs', route_services_id_logs_get)
    host.routes.post('/services/:id/restart', route_services_id_restart_post)
    host.routes.post('/services/:id/start', route_services_id_start_post)
    host.routes.post('/services/:id/stop', route_services_id_stop_post)
    host.routes.post('/services/adopt', route_services_adopt_post)
    host.routes.get('/services', route_services_index_get)
    host.routes.post('/services', route_services_index_post)
    host.routes.get('/processes/:id/logs', route_processes_id_logs_get)
    host.routes.post('/processes/:id/stop', route_processes_id_stop_post)
    host.routes.get('/processes', route_processes_index_get)
    host.routes.get('/ports', route_ports_get)
  },
})
