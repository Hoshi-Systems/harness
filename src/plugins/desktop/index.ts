import { bindDesktopConfig, parseDesktopConfig, type DesktopConfig } from './config.js'
import { definePlugin } from '../define.js'
import route_desktop_get from './desktop.get.js'
import route_desktop_stream_all from './desktop.stream.all.js'
import { displayName, ensureDisplay, stopDesktop } from './desktop.js'

/**
 * ── The agent's desktop ──────────────────────────────────────────────────────
 *
 * The browser the agent already drives, made visible: a person watches the
 * session live rather than reading screenshots of it after the fact.
 *
 * A plugin, and its binaries are declared rather than assumed. A machine
 * whose image predates this reports `desktop: degraded — Xvfb is not installed`
 * on `machine.state` and registers no routes at all, which is the contract's
 * own answer and is what lets the client hide the pane instead of offering a
 * tab that fails.
 *
 * It PROVIDES the display rather than exporting it, because `web-control` is
 * the other half of this feature and a plugin may not import another
 * (§2). The port is how the browser learns there is somewhere to draw.
 *
 **/
export default definePlugin<DesktopConfig>({
  name: 'desktop',
  description: "The agent's browser, visible and shareable",
  capability: { id: 'desktop.browser', title: 'Shared browser', description: "The agent's browser, visible and shareable" },

  config: parseDesktopConfig,

  /**
   *
   * Every `verify` is a `command -v`, which is a shell BUILTIN — and was the
   * reason this plugin never ran on a real machine until 2026-08-29. See
   * `plugins/system.ts`, which is where that is fixed and explained.
   *
   * `install` recipes because this plugin had none: a machine could be told
   * what was missing and never offered a way to fix it. Debian's own package
   * names, the same ones infra/machine/Dockerfile installs, so the recipe and
   * the image cannot describe different machines.
   *
   **/
  system: [
    {
      id: 'Xvfb',
      reason: 'the display the agent’s browser draws on',
      verify: 'command -v Xvfb',
      install: { apt: ['xvfb'] },
    },
    {
      id: 'x11vnc',
      reason: 'serves that display as an RFB stream',
      verify: 'command -v x11vnc',
      install: { apt: ['x11vnc'] },
    },
    {
      id: 'websockify',
      reason: 'RFB is raw TCP; the machine’s bridge speaks WebSocket',
      verify: 'command -v websockify',
      install: { apt: ['websockify'] },
    },
    /** The desktop itself, replacing `openbox` — a window manager alone left the
     *  stream showing an empty rectangle whenever the agent was not
     *  mid-browser-tool.
     *  `xfce4-session` is verified because it is what `desktop.ts` execs. */
    {
      id: 'xfce4-session',
      reason: 'the desktop a person watches — panel, menu, files, a terminal',
      verify: 'command -v xfce4-session',
      install: {
        apt: [
          'xfce4-session',
          'xfwm4',
          'xfce4-panel',
          'xfdesktop4',
          'xfce4-settings',
          'xfconf',
          'thunar',
          'xfce4-terminal',
          'adwaita-icon-theme',
        ],
      },
    },
    {
      id: 'dbus-run-session',
      reason: 'XFCE needs a session bus, and a container has none',
      verify: 'command -v dbus-run-session',
      install: { apt: ['dbus-x11'] },
    },
  ],

  setup(host, config) {
    bindDesktopConfig(config)

    /**
     *
     * Started at boot, not on first view: the browser needs a display whether
     * or not anybody is watching, and a headful Chromium that had to wait for
     * a viewer would be headless for every unattended run — which is most of
     * them. Encoding, which is the part that costs, still waits (`desktop.ts`).
     *
     **/
    host.jobs.once(async () => {
      await ensureDisplay()
    })

    host.provide({ display: () => displayName() })

    host.routes.get('/desktop', route_desktop_get)
    host.routes.all('/desktop/stream', route_desktop_stream_all)

    return { shutdown: async () => stopDesktop() }
  },
})
