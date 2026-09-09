import { desktopConfig } from './config.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ── The agent's desktop ──────────────────────────────────────────────────────
 *
 * A display the agent's browser runs on, and a stream a person can watch.
 *
 * Two lifetimes, deliberately not one:
 *
 *   the DISPLAY   persists. Chromium is running on it; a viewer closing their
 *                 pane must not take the agent's browser down mid-task.
 *   the STREAM    starts when somebody looks and stops when the last of them
 *                 leaves. Encoding frames nobody is watching is the whole of
 *                 what a desktop costs at rest.
 *
 * Modelled on `plugins/services/editor.ts`, which already solved every hard
 * part of putting a long-lived process in a browser tab — loopback only, spawn
 * on first use, a reserved port so it never reads as "a port opened" — and
 * differs in exactly that one respect: the editor deliberately never stops.
 *
 **/

/** The X display the browser and the RFB server agree on. `:0` is what a real
 *  seat would use; this is not one. */
const DISPLAY = ':1'

/** Big enough to be a desktop rather than a viewport. The pane scales it down
 *  to whatever size the person left it (`DesktopView.vue` sets `scaleViewport`),
 *  so this is the ceiling on detail, not the size anybody sees. */
const SCREEN = '1440x900x24'

/** RFB, loopback only. Never proxied directly — the bridge speaks WebSocket. */
const RFB_PORT = 5900

/** Where websockify offers that RFB stream as a WebSocket, which is what the
 *  machine's authenticated bridge knows how to forward. Reserved in
 *  `listening-ports.ts` so it never surfaces as a user's dev server. */
export function desktopPort(): number {
  return desktopConfig().port
}

export type DesktopStatus = 'unavailable' | 'stopped' | 'running'

interface Process {
  child: ChildProcess
  /** Resolved once the child has stayed up long enough to be believed. */
  ready: Promise<void>
}

/**
 *
 * The encoder is BOTH processes, and that is the whole of a bug.
 *
 * Only websockify used to be held, on the reasoning that killing it is what
 * closes the stream a client can reach and x11vnc's `-forever` makes it
 * harmless to leave. It is not harmless. x11vnc keeps the display's RFB port,
 * so the NEXT `startStream` spawns a second one that cannot have it and dies —
 * the desktop streamed exactly once per machine boot, and every viewer after
 * the first got a failed upgrade. It also keeps scanning the framebuffer for a
 * viewer who left, which is the resting cost this whole split exists to avoid.
 *
 * Found by running the image rather than by reading it.
 *
 **/
interface Stream {
  rfb: Process
  bridge: Process
}

let display: Process | null = null
let stream: Stream | null = null
/** The start every concurrent viewer awaits, so two panes are one encoder. */
let starting: Promise<void> | null = null
let viewers = 0

/** Both halves up. A stream missing either is not one a client can use. */
function streaming(): boolean {
  return stream !== null && stream.rfb.child.exitCode === null && stream.bridge.child.exitCode === null
}

/**
 *
 * Spawn and wait to see whether it survives.
 *
 * `spawn` hands back a pid long before the program has decided whether it can
 * run, so "it started" is not the same fact as "it works" — the editor's own
 * comment records the same trap. A child that exits inside the first second is
 * reported as a failure rather than as a running desktop nobody can connect to.
 *
 **/
function launch(command: string, args: string[], env?: NodeJS.ProcessEnv): Process {
  /**
   *
   * stderr is KEPT, and only until the child is believed.
   *
   * It used to be `stdio: 'ignore'`, which threw away the one sentence that
   * explains a dead desktop — "Server is already active for display 1", "Address
   * already in use", "Cannot open display". What reached a person instead was
   * `x11vnc exited immediately (code 1)`, from which nothing follows. A feature
   * whose whole symptom is a black rectangle cannot also be the one that
   * discards its own diagnosis.
   *
   * Capped and dropped once `ready` settles: these are long-lived processes and
   * x11vnc is chatty, so holding its output for the life of the machine would
   * be a leak dressed up as logging.
   *
   **/
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } })
  let complaint = ''
  const listen = (chunk: Buffer) => {
    complaint = (complaint + chunk.toString()).slice(-2_000)
  }
  child.stderr?.on('data', listen)

  const ready = new Promise<void>((resolve, reject) => {
    const settle = setTimeout(resolve, 1_000)
    child.once('error', (error) => {
      clearTimeout(settle)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(settle)
      const said = complaint.trim().split('\n').slice(-3).join('; ')
      reject(new Error(`${command} exited immediately (code ${code ?? 'null'})${said ? `: ${said}` : ''}`))
    })
  })
  /**
   *
   * This chain exists to release a pipe, and it does one more thing worth
   * stating: attaching to `ready` at all is what makes a DROPPED `ready` safe.
   *
   * A caller that starts something and never awaits it — the desktop session
   * below is exactly that — used to leave a promise that rejects with nobody
   * listening, and daemon/resilience.ts turns an unhandled rejection into
   * `process.exit(1)`. A window manager that would not start took the whole
   * machine with it. Verified against the original: it exits 1 on a missing
   * binary. Handling it HERE covers every child rather than the ones somebody
   * remembered to guard, so a caller's own `.catch` is now about the message.
   *
   * `.catch(() => {})` and not `void`, for the derived promise's own sake: void
   * does not handle a rejection, it only silences the linter.
   *
   **/
  ready
    .finally(() => {
      child.stderr?.off('data', listen)
      /** Nothing reads it after this, and an unread pipe fills and blocks the
       *  child. Resumed rather than closed, so the writes simply go nowhere. */
      child.stderr?.resume()
      complaint = ''
    })
    .catch(() => {})
  return { child, ready }
}

/**
 *
 * The display, started once and kept, with a desktop on it. Callers that need
 * somewhere to draw — the browser as much as a viewer — ask for this.
 *
 * It used to be Xvfb plus `openbox`, on the plan's original "not a workstation"
 * reading: one browser on a bare X, a window manager present only so dialogs
 * had a frame. What that produced was a stream showing an empty rectangle for
 * every moment the agent was not mid-browser-tool — working perfectly, and
 * indistinguishable from the broken state that took until 2026-08-29 to find.
 * A blank desktop does not read as "watch-only", it reads as "off".
 *
 **/
export async function ensureDisplay(): Promise<string> {
  if (!display || display.child.exitCode !== null) {
    display = launch('Xvfb', [DISPLAY, '-screen', '0', SCREEN, '-nolisten', 'tcp'])
    await display.ready
    startDesktopSession()
  }
  return DISPLAY
}

/**
 *
 * XFCE on that display: a panel, a menu, a file manager, a terminal, and a
 * window manager for Chromium to be a window in.
 *
 * `dbus-run-session` rather than a bare `xfce4-session`, because XFCE talks to
 * itself over a session bus and there is none in a container — xfconf, the
 * settings daemon and the panel all fail to reach each other without one, which
 * presents as a session that starts and immediately dies.
 *
 * Failure is NOT fatal. Xvfb is up either way, so the agent's browser still
 * draws and the stream still carries it; what is lost is the furniture around
 * it. Started and not awaited, because a viewer must not wait on a panel.
 *
 * That used to be a `process.exit(1)` rather than a degradation — the promise
 * was created and dropped, and daemon/resilience.ts kills the daemon on an
 * unhandled rejection, so a machine whose window manager would not start took
 * the whole thing down from the one line whose comment promised it would not.
 * `launch` handles its own `ready` now, which covers every child instead of
 * this one; the `.catch` here is for the MESSAGE, so a bare display says why.
 *
 **/
function startDesktopSession(): void {
  launch('dbus-run-session', ['--', 'xfce4-session'], {
    DISPLAY,
    /** XFCE asks, on a first run with no panel config, whether to use the
     *  default layout or an empty one — a modal nobody is there to answer.
     *  This is xfce4-panel's own documented way to take the default. */
    XFCE_PANEL_MIGRATE_DEFAULT: '1',
    /** Several XFCE components want one and warn to stderr on every start
     *  without it. HOME is the durable volume, so the desktop's own settings
     *  survive a container swap along with everything else the machine keeps. */
    XDG_RUNTIME_DIR: runtimeDir(),
  }).ready.catch((error) => console.error('[desktop] the desktop session would not start; the display is bare:', error))
}

/** A private, writable `XDG_RUNTIME_DIR` under the machine's durable HOME.
 *  0700 because that is what the spec requires and what the components check. */
function runtimeDir(): string {
  const dir = join(process.env.HOME ?? tmpdir(), '.hoshi', 'xdg-runtime')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    console.error('[desktop] could not make an XDG_RUNTIME_DIR:', error)
  }
  return dir
}

/** True once something has a display to draw on. Read through the kernel port
 *  by `web-control`, which may not import this module (`pnpm check:harness-barrel`). */
export function displayName(): string | null {
  return display && display.child.exitCode === null ? DISPLAY : null
}

/**
 *
 * Begin encoding, if nobody had. Called when a viewer connects.
 *
 * The count goes up LAST, and that ordering is the whole of two bugs.
 *
 * It used to be the first line, so a viewer whose stream failed to start was
 * still counted: the upgrade answers 503 and no socket is ever opened, which
 * means `close` never fires and `detachViewer` never runs. The counter only
 * ever climbed, and after the first failure the encoder could never be stopped
 * by the last real viewer leaving — a machine encoding frames for nobody, which
 * is precisely the resting cost the two-lifetime split exists to avoid.
 *
 * The start is also SHARED rather than repeated. Two panes opening at once both
 * found no stream and both spawned x11vnc on the same port; the loser died with
 * "Address already in use" and answered 503 to a viewer whose desktop was, by
 * then, running perfectly well. One in-flight start, awaited by everyone who
 * arrives during it.
 *
 **/
export async function attachViewer(): Promise<void> {
  if (!streaming()) {
    starting ??= startStream().finally(() => {
      starting = null
    })
    await starting
  }
  viewers += 1
}

async function startStream(): Promise<void> {
  /** Whatever a previous stream left behind. A stale x11vnc still holds
   *  RFB_PORT, and the one spawned below would die on it. */
  stopStream()
  await ensureDisplay()
  const rfb = launch('x11vnc', [
    '-display',
    DISPLAY,
    '-rfbport',
    String(RFB_PORT),
    '-localhost',
    '-forever',
    '-shared',
    '-nopw',
    '-quiet',
  ])
  try {
    await rfb.ready
    const bridge = launch('websockify', [`127.0.0.1:${desktopPort()}`, `127.0.0.1:${RFB_PORT}`])
    try {
      await bridge.ready
    } catch (error) {
      bridge.child.kill()
      throw error
    }
    stream = { rfb, bridge }
  } catch (error) {
    /** A half-started encoder is the same leak by another route: x11vnc up,
     *  websockify not, and the port held against every later attempt. */
    rfb.child.kill()
    throw error
  }
}

/** Stop encoding. Both halves, because both hold something the next start
 *  needs — the port, and the display scan. */
function stopStream(): void {
  stream?.bridge.child.kill()
  stream?.rfb.child.kill()
  stream = null
}

/**
 *
 * A viewer left. The stream stops when the last one does — the display does
 * not, because the browser is still on it.
 *
 * Counted rather than probed: a bridge socket that closed and a viewer who is
 * reconnecting look identical from here, and stopping on the first close would
 * tear the stream down under a page refresh.
 *
 **/
export function detachViewer(): void {
  viewers = Math.max(0, viewers - 1)
  if (viewers > 0) return
  stopStream()
}

export function desktopStatus(): DesktopStatus {
  return streaming() ? 'running' : 'stopped'
}

export function viewerCount(): number {
  return viewers
}

/** Take everything down. The daemon's shutdown path, and nothing else. */
export function stopDesktop(): void {
  stopStream()
  starting = null
  display?.child.kill()
  display = null
  viewers = 0
}
