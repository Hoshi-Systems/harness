import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { apiError, EDITOR_AUTH_COOKIE, requireEditorAuth, workspaceRoot } from '../../kernel/index.js'
import { envUrlPort } from './listening-ports.js'
import { forwardToPort, handleTokenHandshake } from './preview-proxy.js'

/**
 *
 * The machine's embedded code editor: openvscode-server (baked into the
 * machine image at /opt/openvscode-server; see infra/machine/Dockerfile),
 * running on loopback under `--server-base-path /editor` so the sidecar's
 * authenticated /editor/** routes can proxy it 1:1 — HTTP through
 * forwardToPort, WebSockets through the ws bridge (utils/ws-proxy.ts). The
 * sidecar owns the lifecycle: started on demand by the first proxied request,
 * kept up for the machine's lifetime (an editor tab may stay open for days),
 * its port reserved (utils/ports.ts) so it never surfaces as a user dev
 * server.
 *
 **/

export const EDITOR_BASE_PATH = '/editor'

export function editorPort(): number {
  return envUrlPort(process.env.HOSHI_EDITOR_URL, 4099)
}

export type EditorStatus = 'unavailable' | 'stopped' | 'starting' | 'running'

/** The server binary: env override first (local dev pointing anywhere), then
 *  the machine image's install. Null means this machine has no editor. */
function editorBin(): string | null {
  const override = process.env.HOSHI_EDITOR_BIN
  if (override) return existsSync(override) ? override : null
  const baked = '/opt/openvscode-server/bin/openvscode-server'
  return existsSync(baked) ? baked : null
}

let child: ChildProcess | null = null
/** Our child answers requests — spawn() hands out a pid long before the
 *  server listens, so the pid alone must never short-circuit ensure (a
 *  request proxied in that window 502s — found live). */
let ready = false
let starting: Promise<void> | null = null
/** Probe verdict cache — an editor page load is a burst of asset requests, and
 *  an externally-started server (sidecar dev restart) shouldn't eat a probe
 *  per asset. */
let lastProbeOkAt = 0

/** Anything answering on the editor port counts as up — covers a server this
 *  sidecar process didn't itself spawn (a dev restart of the sidecar). */
async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${editorPort()}${EDITOR_BASE_PATH}/`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (res.status >= 500) return false
    lastProbeOkAt = Date.now()
    return true
  } catch {
    return false
  }
}

export async function editorStatus(): Promise<EditorStatus> {
  if (!editorBin()) return 'unavailable'
  if (starting) return 'starting'
  if ((child?.pid && ready) || (await probe())) return 'running'
  return 'stopped'
}

/** Make sure the editor answers before a request is forwarded to it. Fast
 *  path: our own child is alive AND confirmed answering. Otherwise probe, and
 *  cold-start on demand — the in-flight promise is assigned synchronously so
 *  concurrent callers (an iframe's asset burst, a racing WebSocket upgrade)
 *  always share one start. */
export function ensureEditorRunning(): Promise<void> {
  if (child?.pid && ready) return Promise.resolve()
  if (starting) return starting
  starting = bringUp().finally(() => {
    starting = null
  })
  return starting
}

async function bringUp(): Promise<void> {
  if (Date.now() - lastProbeOkAt < 5_000) return
  if (await probe()) return
  const bin = editorBin()
  if (!bin) {
    apiError(501, 'editor.unavailable', 'This machine has no code editor installed.')
  }
  await startEditor(bin)
}

async function startEditor(bin: string): Promise<void> {
  /**
   *
   * Server data (extensions, settings the user installs from the editor UI)
   * belongs on the durable volume next to the sidecar's other state.
   *
   **/
  const dataDir = path.join(process.env.HOME ?? homedir(), '.hoshi', 'editor')
  mkdirSync(dataDir, { recursive: true })
  const log = openSync(path.join(dataDir, 'server.log'), 'a')

  /**
   *
   * Loopback only — the sidecar's /editor/** routes are the sole way in, and
   * they run the machine's own auth. The connection token would be a second
   * credential the iframe can't carry, so it's disabled in favor of ours.
   *
   **/
  const spawned = spawn(
    bin,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(editorPort()),
      '--server-base-path',
      EDITOR_BASE_PATH,
      '--without-connection-token',
      '--telemetry-level',
      'off',
      '--server-data-dir',
      dataDir,
      '--default-folder',
      workspaceRoot(),
    ],
    { stdio: ['ignore', log, log] },
  )
  child = spawned
  ready = false
  const gone = () => {
    if (child === spawned) {
      child = null
      ready = false
    }
  }
  spawned.on('exit', gone)
  spawned.on('error', gone)

  for (let attempt = 0; attempt < 120; attempt++) {
    if (!child) break // died during startup — the log has the story
    if (await probe()) {
      ready = true
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  apiError(502, 'editor.startFailed', 'The code editor did not start.')
}

/** Shared handler for every /editor/** HTTP request: a `?hoshi_token=` iframe
 *  handshake persisted as an editor-only cookie, then an on-demand server
 *  start, then a 1:1 forward —
 *  the upstream serves under the SAME `/editor` base path, so the request's
 *  own pathname is the upstream pathname. No picker script: that belongs to
 *  previewed dev servers, not the machine's own editor chrome. */
export async function handleEditorRequest(event: H3Event): Promise<unknown> {
  const url = getRequestURL(event)
  const redirected = await handleTokenHandshake(event, url, {
    cookie: EDITOR_AUTH_COOKIE,
    cookiePath: EDITOR_BASE_PATH,
  })
  if (redirected) return
  await requireEditorAuth(event)
  await ensureEditorRunning()
  return forwardToPort(event, editorPort(), url.pathname.slice(1), url.search, { pickerScript: false })
}
