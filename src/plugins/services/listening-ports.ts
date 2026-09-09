import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, readlink } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const DEFAULT_SCHEME_PORTS: Record<string, number> = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 }

/** `host:port` with no scheme — what an operator naturally writes, and what
 *  `new URL` misreads (see below). */
const HOST_PORT = /^[\w.-]+:(\d{1,5})$/

/** Port of a loopback service the sidecar knows by URL env var.
 *
 *  Getting this wrong is silent and cuts both ways: the answer joins
 *  `reservedPorts()`, so a wrong port hides a user's dev server that happens to
 *  sit there, while the daemon's real port stays unreserved and surfaces as a
 *  spurious "port opened" notification.
 *
 *  Hence the care with a scheme-less value. `new URL('localhost:11434')` does
 *  not throw — it reads `localhost:` as the SCHEME and `11434` as an opaque
 *  path, leaving no hostname and no port, which the old default-port branch
 *  turned into 80. A hostname check catches that, and the `host:port` form is
 *  then read for what it obviously means rather than dropped on the floor. */
export function envUrlPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback

  let port: number | undefined
  try {
    const url = new URL(value)
    /**
     *
     * An opaque URL (no `//`) has an empty hostname — not a real address.
     *
     **/
    if (url.hostname) port = Number(url.port || DEFAULT_SCHEME_PORTS[url.protocol])
  } catch {
    /* not a URL; try the bare host:port form below */
  }
  if (port === undefined) port = Number(HOST_PORT.exec(value)?.[1])

  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

/** The machine's own listeners — never previewable, never listed. Reserved
 *  unconditionally even for services that are optional (router, memory graph)
 *  or bind lazily mid-session (the widget reply bridge): these ports belong to
 *  the machine whether or not something is listening right now, and a
 *  lazy bind must not surface as a "port opened" notification. */
export function reservedPorts(): Set<number> {
  return new Set<number>([
    Number(process.env.PORT ?? process.env.NITRO_PORT ?? 4200), // this sidecar
    envUrlPort(process.env.HOSHI_MEMORY_GRAPH_URL, 4098), // omnigraph memory graph
    envUrlPort(process.env.HOSHI_ROUTER_URL, 11434), // ollama task router
    envUrlPort(process.env.HOSHI_EDITOR_URL, 4099), // openvscode-server (utils/editor.ts — /editor/** proxies it)
    /** websockify (plugins/desktop — /desktop/stream bridges it). Read from the
     *  environment rather than from that plugin's configuration, because a
     *  plugin may not import another and there is no port for "what have you
     *  reserved". It agrees with `parseDesktopConfig`'s default and with the
     *  same env var, and diverges only if a harness is started with a
     *  programmatic `pluginConfig.desktop.port` — which nothing does yet. When
     *  something does, that is the change that adds the port. */
    Number(process.env.HOSHI_DESKTOP_PORT ?? 4097),
  ])
}

/** The machine's own daemons also bind ports no fixed reserved set can know —
 *  ollama's model runner comes up on a RANDOM loopback port when the routing
 *  model first loads. Each listening port is attributed to its owning process
 *  (comm on Linux, lsof's COMMAND locally) and system owners are dropped like
 *  reserved ports. Prefix match, because /proc comm truncates at 15 chars
 *  ("omnigraph-serve") and lsof's COMMAND column at 9. Deliberately NOT
 *  node/bun — the user's own dev servers run on those. `chrome`/`chromium`
 *  target headless Chromium automation (Playwright/Puppeteer) — spelled out
 *  in full rather than truncated to `chrom`, which also matched a user's own
 *  Chroma DB (a realistic RAG server for this product's audience) and hid it
 *  from "port opened" notifications. */
const SYSTEM_LISTENER = /^(opencode|ollama|omnigraph|chrome|chromium|headless)/i

/** Daemons whose whole process TREE is the machine's: ollama's runner is a
 *  child named `llama-server` (verified live), a name a user's own llama.cpp
 *  server could legitimately carry too — so the runner is caught by descent
 *  from the ollama daemon, not by its own name. OpenCode is deliberately NOT
 *  here: user dev servers are its descendants (bash/process tools). */
const SYSTEM_ANCESTOR = /^(ollama|omnigraph)/i

/** TCP ports something on this machine is listening on, the machine's own
 *  (reserved or system-daemon-owned) listeners excluded. Linux (the machine
 *  image) reads the kernel's socket table directly; darwin (local dev) shells
 *  out to lsof. Failures degrade to an empty list — port discovery is a
 *  convenience, never worth a 500. */
export async function listListeningPorts(): Promise<number[]> {
  const reserved = reservedPorts()
  try {
    const ports = process.platform === 'linux' ? await procNetPorts() : await lsofPorts()
    return [...ports].filter((port) => !reserved.has(port)).sort((a, b) => a - b)
  } catch {
    return []
  }
}

/** port → owning socket inode + verdict, so the /proc owner walk (the one
 *  costly step) runs only when a port appears or changes hands, not on every
 *  2.5s scan. Unresolvable owners are cached too (as user-owned — hiding a
 *  real dev server is the worse failure), so they don't re-trigger the walk. */
const portOwners = new Map<number, { inode: string; system: boolean }>()

/** Parse /proc/net/tcp{,6}: column 1 is `HEXIP:HEXPORT`, column 3 the socket
 *  state — 0A is LISTEN — and column 9 the socket inode that ties the port to
 *  its owning process. */
async function procNetPorts(): Promise<Set<number>> {
  const sockets = new Map<number, string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const data = await readFile(table, 'utf8').catch(() => '')
    for (const line of data.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10 || parts[3] !== '0A') continue
      const hexPort = parts[1]?.split(':')[1]
      if (!hexPort) continue
      const port = Number.parseInt(hexPort, 16)
      if (!Number.isInteger(port) || port <= 0) continue
      if (!sockets.has(port)) sockets.set(port, parts[9] ?? '')
    }
  }

  for (const port of portOwners.keys()) if (!sockets.has(port)) portOwners.delete(port)

  const unresolved = new Map<string, number[]>()
  for (const [port, inode] of sockets) {
    if (portOwners.get(port)?.inode === inode) continue
    unresolved.set(inode, [...(unresolved.get(inode) ?? []), port])
  }
  if (unresolved.size > 0) {
    const pids = await socketOwners(new Set(unresolved.keys()))
    for (const [inode, ports] of unresolved) {
      const pid = pids.get(inode)
      const system = pid !== undefined && (await ownedBySystem(pid))
      for (const port of ports) portOwners.set(port, { inode, system })
    }
  }

  const visible = new Set<number>()
  for (const port of sockets.keys()) if (!portOwners.get(port)?.system) visible.add(port)
  return visible
}

/** pid of the process holding each socket inode, resolved in one /proc pass:
 *  fd symlinks read `socket:[inode]`. Everything that listens on the machine
 *  runs as the same user as this sidecar, so the fd dirs are readable; a pid
 *  that isn't (or dies mid-walk) is skipped and its ports stay visible. */
async function socketOwners(inodes: Set<string>): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name))
  for (const pid of pids) {
    if (found.size === inodes.size) break
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [])
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
      if (inode && inodes.has(inode) && !found.has(inode)) found.set(inode, Number(pid))
    }
  }
  return found
}

/** Is this pid one of the machine's own processes? Its own comm decides for
 *  the daemons themselves; the ancestor walk (ppid from /proc/pid/stat, field
 *  after the parenthesized comm) catches their helpers. Unreadable procs
 *  resolve to user-owned — hiding a real dev server is the worse failure. */
async function ownedBySystem(pid: number): Promise<boolean> {
  let current = pid
  /**
   *
   * The walk includes pid 1 — in a container the daemon itself can BE pid 1.
   *
   **/
  for (let depth = 0; depth < 16 && current >= 1; depth++) {
    const comm = (await readFile(`/proc/${current}/comm`, 'utf8').catch(() => '')).trim()
    if ((depth === 0 ? SYSTEM_LISTENER : SYSTEM_ANCESTOR).test(comm)) return true
    const stat = await readFile(`/proc/${current}/stat`, 'utf8').catch(() => '')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!Number.isInteger(ppid) || ppid === current || ppid < 1) break
    current = ppid
  }
  return false
}

async function lsofPorts(): Promise<Set<number>> {
  const ports = new Set<number>()
  const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  for (const line of stdout.split('\n')) {
    const match = /:(\d+)\s+\(LISTEN\)/.exec(line)
    if (!match) continue
    if (SYSTEM_LISTENER.test(line.split(/\s+/)[0] ?? '')) continue
    ports.add(Number(match[1]))
  }
  return ports
}
