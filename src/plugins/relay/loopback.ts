import { createServer, type Server } from 'node:http'
import { attachedLink } from './link.js'

/**
 * ── The engine's door to the tunnel ──────────────────────────────────────────
 *
 * A relay provider's `baseUrl` points here: a plain HTTP listener that turns
 * each request into frames on the connector's socket and streams the answer
 * back. The engine and `discoverProvider` then need nothing new — a tunnelled
 * endpoint is just an OpenAI-compatible URL like every other.
 *
 * Bound to `127.0.0.1`, port `0`. The interface binding IS the access control:
 * a forwarding surface reachable through the public ingress guarded only by an
 * "is this loopback?" header check would be one bug away from an open proxy
 * into the person's home network (design.md §2). Anything already on the box
 * can reach it, and that is the intended blast radius — the agent can drive
 * these models through an ordinary turn anyway.
 *
 * Paths are `/ep/<advertised id>/<rest>`. Only the path travels; the connector
 * resolves it against the base URL it holds for that id, so this surface
 * cannot name arbitrary destinations on the far side.
 *
 **/

/** Request headers worth carrying to a local runtime. Deliberately an
 *  allowlist: the engine's placeholder `Authorization` is a machine credential
 *  shape that no keyless local runtime needs and none should see. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept']

/** Hop-by-hop response headers that must not survive re-streaming: the
 *  forwarder writes chunked, so a stale `content-length` from the runtime
 *  would truncate or hang every client of this response. */
const DROP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive'])

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value
  }
  return out
}

const refuse = (res: import('node:http').ServerResponse, status: number, message: string): void => {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

export interface LoopbackForwarder {
  server: Server
  port: number
  close(): Promise<void>
}

/** Bind the forwarder and resolve with the port the OS chose. */
export function startLoopbackForwarder(): Promise<LoopbackForwarder> {
  const server = createServer((req, res) => {
    const link = attachedLink()
    if (!link) {
      refuse(res, 503, 'No local-models connector is attached to this machine.')
      return
    }
    const match = /^\/ep\/([^/?#]+)([^?#]*)/.exec(req.url ?? '')
    const endpoint = match ? link.endpoints.get(match[1]!) : undefined
    if (!endpoint) {
      refuse(res, 404, 'No such tunnelled endpoint.')
      return
    }
    const path = match![2] || '/'

    const headers: Record<string, string> = {}
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }

    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => body.push(chunk))
    req.on('error', () => res.destroy())
    req.on('end', () => {
      const id = link.calls.begin({
        onResponse: (status, responseHeaders) => {
          if (!res.headersSent) res.writeHead(status, sanitizeResponseHeaders(responseHeaders))
        },
        onChunk: (bytes) => {
          if (!res.writableEnded) res.write(bytes)
        },
        onEnd: () => {
          if (!res.writableEnded) res.end()
        },
        onError: (message) => refuse(res, 502, message),
      })
      /**
       *
       * The engine hung up — a person stopped the turn, or the SSE consumer
       * died. Telling the connector is what stops an abandoned generation
       * from occupying somebody's GPU until it finishes on its own.
       *
       **/
      res.on('close', () => {
        if (link.calls.cancel(id)) link.send({ t: 'cancel', id })
      })
      const sent = link.send({
        t: 'req',
        id,
        ep: endpoint.id,
        method: req.method ?? 'GET',
        path,
        headers,
        bodyB64: body.length > 0 ? Buffer.concat(body).toString('base64') : null,
      })
      if (!sent) {
        link.calls.cancel(id)
        refuse(res, 502, 'The connector went away while sending this request.')
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('the loopback forwarder bound to no port'))
        return
      }
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            /**
             *
             * A streaming response holds its connection open indefinitely, and
             * `close()` alone never resolves while one exists — the exact
             * SIGTERM hang the daemon already fixed once. Destroy them.
             *
             **/
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
