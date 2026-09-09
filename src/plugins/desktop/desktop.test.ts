import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ── The two lifetimes, and the counter that separates them ───────────────────
 *
 * The display persists and the stream does not, and the ONLY thing standing
 * between those two facts is `viewers`.
 * Nothing else ever stops the encoder — so every way that number can drift is a
 * machine encoding frames for an audience of nobody, or tearing the picture out
 * from under somebody still watching.
 *
 * These spawn nothing. The point is the bookkeeping around the spawn, which is
 * where all three of the bugs below actually lived.
 *
 **/

/** Commands this pretend machine refuses to run, by name. */
const broken = new Set<string>()
const spawned: Array<{ command: string; child: FakeChild }> = []

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  stderr = new PassThrough()
  kill = vi.fn(() => {
    this.exitCode = 0
    return true
  })
}

vi.mock('node:child_process', () => ({
  spawn: (command: string) => {
    const child = new FakeChild()
    spawned.push({ command, child })
    if (broken.has(command)) {
      /** Dies the way a real one does — a word about why, then an exit code. */
      queueMicrotask(() => {
        child.stderr.write(`${command}: cannot open display\n`)
        child.exitCode = 1
        child.emit('exit', 1)
      })
    }
    return child
  },
}))

const { attachViewer, detachViewer, desktopStatus, stopDesktop, viewerCount } = await import('./desktop.js')

/** `launch` believes a child that survives one second; nothing here wants to
 *  wait that long four times over. */
async function settle() {
  await vi.advanceTimersByTimeAsync(5_000)
}

/** `runtimeDir()` really does create a directory, so HOME is redirected rather
 *  than left pointing at whoever is running the suite. */
const HOME = process.env.HOME
const scratch = mkdtempSync(join(tmpdir(), 'hoshi-desktop-'))

beforeEach(() => {
  vi.useFakeTimers()
  broken.clear()
  spawned.length = 0
  process.env.HOME = scratch
})

afterEach(() => {
  stopDesktop()
  vi.useRealTimers()
  process.env.HOME = HOME
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('attaching a viewer', () => {
  it('counts nobody when the stream could not start', async () => {
    /**
     *
     * The count used to go up on the FIRST line, before anything had started.
     * A viewer whose desktop failed is answered 503 and never gets a socket, so
     * `close` never fires and `detachViewer` never runs — the number only ever
     * climbed. One failure and the last real viewer leaving could no longer
     * bring it to zero, which is the single condition that stops the encoder.
     *
     **/
    broken.add('Xvfb')
    /** Awaited straight through: the child dies in a microtask, so no timer has
     *  to run — and a rejected promise left handler-less across a turn is an
     *  unhandled rejection, which is `process.exit(1)` on a real machine. */
    await expect(attachViewer()).rejects.toThrow()
    expect(viewerCount()).toBe(0)
  })

  it('says what the machine actually complained about', async () => {
    /**
     *
     * `stdio: 'ignore'` threw away the one sentence that explains a black
     * rectangle. "exited immediately (code 1)" is not a diagnosis.
     *
     **/
    broken.add('Xvfb')
    await expect(attachViewer()).rejects.toThrow(/cannot open display/)
  })

  it('starts one encoder for two panes opening at once', async () => {
    /**
     *
     * Both found no stream, both spawned x11vnc on the same port, and the
     * loser died with "Address already in use" — answering 503 to a viewer
     * whose desktop was by then running perfectly well.
     *
     **/
    const both = Promise.all([attachViewer(), attachViewer()])
    await settle()
    await both

    expect(spawned.filter((s) => s.command === 'x11vnc')).toHaveLength(1)
    expect(spawned.filter((s) => s.command === 'websockify')).toHaveLength(1)
    expect(viewerCount()).toBe(2)
    expect(desktopStatus()).toBe('running')
  })
})

describe('the desktop on that display', () => {
  it('starts a real XFCE session, not a bare window manager', async () => {
    /**
     *
     * The plan's §1 said "not a workstation" and the code installed `openbox`
     * to match. What that produced was a stream showing an empty rectangle for
     * every moment the agent was not mid-browser-tool — working perfectly, and
     * indistinguishable from the broken state. Reversed 2026-08-29.
     *
     * `dbus-run-session` and not a bare `xfce4-session`: XFCE talks to itself
     * over a session bus, and a container has none.
     *
     **/
    const attaching = attachViewer()
    await settle()
    await attaching

    const session = spawned.find((s) => s.command === 'dbus-run-session')
    expect(session).toBeDefined()
    expect(spawned.map((s) => s.command)).not.toContain('openbox')
  })

  it('survives a desktop that will not start — the browser still has a display', async () => {
    /**
     *
     * The furniture is not the feature. Xvfb is up either way, so the agent's
     * browser still draws and the stream still carries it — a viewer gets a
     * bare display rather than a 503.
     *
     * What this does NOT pin is the unhandled rejection that used to ride along
     * with a dead session: `launch` handles its own `ready` now, so no caller
     * can drop one. That property lives there, and is stated there.
     *
     **/
    broken.add('dbus-run-session')
    const attaching = attachViewer()
    await settle()
    await expect(attaching).resolves.toBeUndefined()
    expect(desktopStatus()).toBe('running')
  })
})

describe('the last viewer leaving', () => {
  it('stops the stream then, and not before', async () => {
    const both = Promise.all([attachViewer(), attachViewer()])
    await settle()
    await both
    const bridge = spawned.find((s) => s.command === 'websockify')!

    detachViewer()
    expect(viewerCount()).toBe(1)
    expect(bridge.child.kill).not.toHaveBeenCalled()
    expect(desktopStatus()).toBe('running')

    detachViewer()
    expect(viewerCount()).toBe(0)
    expect(bridge.child.kill).toHaveBeenCalled()
    expect(desktopStatus()).toBe('stopped')
  })

  it('stops BOTH halves, so the next viewer can start one', async () => {
    /**
     *
     * Only websockify used to be stopped. x11vnc kept the RFB port, so the next
     * `startStream` spawned a second one that could not have it and died — the
     * desktop streamed exactly once per machine boot.
     *
     * Caught by running the image, not by reading it: the first `curl` after a
     * reconnect reported `status: stopped, viewers: 0` while a viewer was
     * holding the socket open.
     *
     **/
    const first = attachViewer()
    await settle()
    await first
    const rfb = spawned.find((s) => s.command === 'x11vnc')!
    const bridge = spawned.find((s) => s.command === 'websockify')!

    detachViewer()
    expect(bridge.child.kill).toHaveBeenCalled()
    expect(rfb.child.kill).toHaveBeenCalled()

    /** And a second viewer really does get a stream. */
    const second = attachViewer()
    await settle()
    await second
    expect(spawned.filter((s) => s.command === 'x11vnc')).toHaveLength(2)
    expect(desktopStatus()).toBe('running')
    expect(viewerCount()).toBe(1)
  })

  it('leaves the display up, because the browser is on it', async () => {
    /**
     *
     * The half of §4.3 that was written down wrong and corrected by building
     * it: stopping the display when the last viewer leaves takes the agent's
     * browser with it, mid-task, because somebody closed a tab.
     *
     **/
    const attaching = attachViewer()
    await settle()
    await attaching
    const xvfb = spawned.find((s) => s.command === 'Xvfb')!

    detachViewer()
    expect(xvfb.child.kill).not.toHaveBeenCalled()
  })
})
