/**
 * ── The relay wire, and the multiplexer over it ──────────────────────────────
 *
 * One WebSocket carries every request the machine has in flight to the
 * connector, so frames are tagged with a request id and this module keeps the
 * ledger of who is waiting for what. Pure on purpose: no socket, no HTTP —
 * the unit tests drive it with frames alone.
 *
 * JSON text frames, not binary. The traffic is model tokens and JSON bodies;
 * the base64 quarter on chunks buys nothing to optimize away at that
 * throughput, and the voice plugin already documents crossws surfacing text
 * frames as Buffers — tags-in-JSON is the least surprising shape this
 * codebase has.
 *
 * The CONNECTOR side of this vocabulary is reimplemented in
 * `apps/cli/src/bridge/` rather than imported: the connector is a client
 * program, and pulling the whole machine package into it for four frame
 * shapes would couple their releases for no reason — the same deliberate-copy
 * reasoning as kernel/provider-discovery.ts and the Platform's.
 *
 **/

/** What a connector says it can reach. Just an id and a display name — the
 *  LOCAL address stays on the connector's side of the socket, because the
 *  machine has no business knowing it (design.md §4). */
export interface RelayEndpointAd {
  id: string
  name: string
}

/** Connector → machine. */
export type ConnectorFrame =
  | { t: 'hello'; connector: { name: string; version: string }; endpoints: RelayEndpointAd[] }
  | { t: 'res'; id: number; status: number; headers: Record<string, string> }
  | { t: 'chunk'; id: number; b64: string }
  | { t: 'end'; id: number }
  | { t: 'err'; id: number; message: string }
  | { t: 'pong' }

/** Machine → connector. */
export type MachineFrame =
  | {
      t: 'ready'
      endpoints: Array<{ id: string; providerId: string; models: number }>
      failed: Array<{ id: string; reason: string }>
    }
  | {
      t: 'req'
      id: number
      /** The ADVERTISED endpoint id — the connector resolves it against the
       *  base URL it holds for that id and nothing else, which is what keeps
       *  the tunnel from being aimed at arbitrary addresses on the person's
       *  network. */
      ep: string
      method: string
      path: string
      headers: Record<string, string>
      bodyB64: string | null
    }
  | { t: 'cancel'; id: number }
  | { t: 'ping' }

const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string')

/** One frame off the socket, or null for anything malformed. Null rather than
 *  a throw: the peer is the network, and a bad frame must cost that frame,
 *  never the connection carrying everyone else's requests. */
export function parseConnectorFrame(raw: unknown): ConnectorFrame | null {
  let value: unknown
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : null
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  switch (frame.t) {
    case 'hello': {
      const connector = (frame.connector ?? {}) as Record<string, unknown>
      if (typeof connector.name !== 'string' || typeof connector.version !== 'string') return null
      if (!Array.isArray(frame.endpoints)) return null
      const endpoints: RelayEndpointAd[] = []
      for (const raw of frame.endpoints) {
        const endpoint = (raw ?? {}) as Record<string, unknown>
        if (typeof endpoint.id !== 'string' || typeof endpoint.name !== 'string') return null
        endpoints.push({ id: endpoint.id, name: endpoint.name })
      }
      return { t: 'hello', connector: { name: connector.name, version: connector.version }, endpoints }
    }
    case 'res':
      return typeof frame.id === 'number' && typeof frame.status === 'number' && isStringRecord(frame.headers)
        ? { t: 'res', id: frame.id, status: frame.status, headers: frame.headers }
        : null
    case 'chunk':
      return typeof frame.id === 'number' && typeof frame.b64 === 'string'
        ? { t: 'chunk', id: frame.id, b64: frame.b64 }
        : null
    case 'end':
      return typeof frame.id === 'number' ? { t: 'end', id: frame.id } : null
    case 'err':
      return typeof frame.id === 'number' && typeof frame.message === 'string'
        ? { t: 'err', id: frame.id, message: frame.message }
        : null
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

export interface CallHandlers {
  onResponse(status: number, headers: Record<string, string>): void
  onChunk(bytes: Uint8Array): void
  onEnd(): void
  onError(message: string): void
}

/** How long a request may sit with NO frame arriving for it before it is
 *  failed. Generous, because a local model paging into VRAM can take a minute
 *  to its first token — but not infinite, because a connector that is alive
 *  while its runtime hangs would otherwise pin the engine's request forever. */
const IDLE_TIMEOUT_MS = 300_000

interface PendingCall {
  handlers: CallHandlers
  timer: NodeJS.Timeout
}

/** The machine side's ledger of in-flight tunnel requests.
 *
 *  Every terminal transition — `end`, `err`, a cancel, `failAll` — forgets the
 *  id, so a connector replying to a request nobody sent (or to one already
 *  finished) is ignored rather than crossing streams. */
export class RelayCalls {
  private next = 1
  private readonly pendingCalls = new Map<number, PendingCall>()

  begin(handlers: CallHandlers, idleMs: number = IDLE_TIMEOUT_MS): number {
    const id = this.next++
    const call: PendingCall = { handlers, timer: setTimeout(() => this.expire(id), idleMs) }
    call.timer.unref?.()
    this.pendingCalls.set(id, call)
    return id
  }

  /** Route one connector frame to whoever is waiting on its id. Unknown ids
   *  and non-call frames are ignored by design. */
  handle(frame: ConnectorFrame, idleMs: number = IDLE_TIMEOUT_MS): void {
    if (frame.t !== 'res' && frame.t !== 'chunk' && frame.t !== 'end' && frame.t !== 'err') return
    const call = this.pendingCalls.get(frame.id)
    if (!call) return
    clearTimeout(call.timer)
    if (frame.t === 'end') {
      this.pendingCalls.delete(frame.id)
      call.handlers.onEnd()
      return
    }
    if (frame.t === 'err') {
      this.pendingCalls.delete(frame.id)
      call.handlers.onError(frame.message)
      return
    }
    call.timer = setTimeout(() => this.expire(frame.id), idleMs)
    call.timer.unref?.()
    if (frame.t === 'res') call.handlers.onResponse(frame.status, frame.headers)
    else call.handlers.onChunk(Buffer.from(frame.b64, 'base64'))
  }

  /** The caller stopped caring (its own client hung up). True when the id was
   *  still pending — the moment to tell the connector to abort its fetch. */
  cancel(id: number): boolean {
    const call = this.pendingCalls.get(id)
    if (!call) return false
    clearTimeout(call.timer)
    this.pendingCalls.delete(id)
    return true
  }

  /** The socket under every pending call is gone. */
  failAll(message: string): void {
    const calls = [...this.pendingCalls.entries()]
    this.pendingCalls.clear()
    for (const [, call] of calls) {
      clearTimeout(call.timer)
      call.handlers.onError(message)
    }
  }

  pending(): number {
    return this.pendingCalls.size
  }

  private expire(id: number): void {
    const call = this.pendingCalls.get(id)
    if (!call) return
    this.pendingCalls.delete(id)
    call.handlers.onError('The connector stopped answering this request.')
  }
}
