import { describe, expect, it } from 'vitest'
import { Agent, createServer, get, type Server } from 'node:http'
import { connect } from 'node:net'

import { closeHttpServer } from './http/shutdown.js'

/**
 * ── Shutting down with a client attached ─────────────────────────────────────
 *
 * This machine's clients hold the connection open on purpose: the event stream
 * is how they learn anything. `server.close()` waits for open connections, so
 * on a daemon whose connections never end it never resolves — the process
 * ignored SIGTERM entirely, `docker stop` sat out its timeout, and the machine
 * died by SIGKILL mid-turn. The graceful path caused the corruption it exists
 * to prevent, and it did so only when somebody was actually connected, which is
 * why it survived every test that connected and left.
 *
 * Tested against a bare node server rather than the harness: the defect is in
 * how a listening socket is closed, and standing up a whole machine to prove it
 * would test the machine instead of the shutdown.
 *
 **/

/** The shutdown `createHarness().close()` performs — the REAL one. This used to
 *  be a hand-copied replica of those five lines, which meant the suite could not
 *  fail when the implementation regressed: the one job it was written to do. */
function shutdown(server: Server, { grace = 50, deadline = 500 } = {}): Promise<void> {
  return closeHttpServer(server, { grace, deadline })
}

/** A server that answers with a stream it never ends — an /events subscriber. */
async function streamingServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': open\n\n')
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return { server, port }
}

/** Open a raw request and wait for the first byte, so the connection is
 *  genuinely established and streaming by the time we shut down. */
function subscribe(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n')
    })
    socket.on('error', () => {})
    socket.once('data', () => resolve())
  })
}

/** Open a raw TCP connection and wait until the SERVER has registered it.
 *
 *  Resolving on the client's `connect` callback alone is not enough, and that
 *  is a race this test lost 5 times out of 5 on a warm machine. The callback
 *  fires when the handshake completes CLIENT-side, which is routinely before
 *  the server has emitted `'connection'` — and a shutdown that starts in that
 *  window finds a server with no connections to wait for, so `close()` resolves
 *  on the spot and the run measures ~0ms instead of the grace window. The
 *  failure reads exactly like the grace window having been skipped, which is
 *  the bug this test exists to catch, so the race did not look like a race. */
function connectSilently(server: Server, port: number): Promise<void> {
  const registered = new Promise<void>((resolve) => server.once('connection', () => resolve()))
  const connected = new Promise<void>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => resolve())
    socket.on('error', () => {})
  })
  return Promise.all([registered, connected]).then(() => undefined)
}

/** A server that answers a request and keeps the connection for reuse — the
 *  shape a client is in between polls. */
async function keepAliveServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '2' })
    response.end('ok')
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return { server, port }
}

/** Complete one request over a keep-alive agent and leave the socket open, so
 *  the server is holding a genuinely IDLE connection: a finished HTTP
 *  transaction, nothing in flight, the socket kept for the next request. */
async function idleKeepAlive(port: number): Promise<Agent> {
  const agent = new Agent({ keepAlive: true })
  await new Promise<void>((resolve, reject) => {
    get({ port, host: '127.0.0.1', agent, path: '/' }, (response) => {
      response.resume()
      response.on('end', () => resolve())
    }).on('error', reject)
  })
  return agent
}

describe('closing the daemon', () => {
  it('finishes even while a client is streaming', async () => {
    const { server, port } = await streamingServer()
    await subscribe(port)

    const started = Date.now()
    await shutdown(server)

    /**
     *
     * The number that matters is "it returned at all". A machine that takes a
     * little while to stop is fine; one that never stops is the bug.
     *
     **/
    expect(Date.now() - started).toBeLessThan(400)
    expect(server.listening).toBe(false)
  })

  it('hangs up on an idle keep-alive without waiting out the grace window', async () => {
    /**
     *
     * A client that finished a request and went quiet has nothing left to
     * finish, so it must not be what a shutdown is waiting for: it has to be
     * hung up on the spot, long before the grace timer would fire.
     *
     * What this does NOT prove is that `closeIdleConnections()` is the thing
     * doing it. Since node 19 `server.close()` closes idle connections itself,
     * so on the node this repo pins (22, `.nvmrc`) the assertion below holds
     * with that call removed — verified by deleting it and watching all three
     * tests still pass. The call is kept as an explicit statement of intent in
     * a path whose failure mode was a SIGKILLed machine, not because this test
     * defends it. Treat a green here as "an idle keep-alive does not hold the
     * shutdown open", which is the contract that matters, and nothing more.
     *
     * It must be a REAL keep-alive: a completed HTTP transaction on a socket
     * kept open for reuse. This test used to open a bare TCP socket and never
     * send a request, which is not a keep-alive at all — no transaction has
     * happened, so node's server has no idle HTTP connection to close and
     * `closeIdleConnections()` correctly leaves it alone. The assertion below
     * therefore could not pass, and the suite has been failing since the test
     * landed (2026-08-14); the half-open case it was reaching for is the one
     * below, where the grace timer is the right answer.
     *
     **/
    const { server, port } = await keepAliveServer()
    const agent = await idleKeepAlive(port)

    const started = Date.now()
    await shutdown(server, { grace: 5_000, deadline: 5_000 })
    expect(Date.now() - started).toBeLessThan(400)
    agent.destroy()
  })

  it('cuts a socket that never sent a request once the grace window passes', async () => {
    /**
     *
     * A connection that opened and never spoke is not idle in any sense node's
     * http server tracks — there is no transaction to be between. Nothing
     * hangs up on it, and nothing should: it is `closeAllConnections()` at the
     * end of the grace window that clears it. What matters is the same thing
     * that mattered in the outage — the shutdown finishes.
     *
     **/
    const { server, port } = await streamingServer()
    await connectSilently(server, port)

    const started = Date.now()
    await shutdown(server, { grace: 50, deadline: 2_000 })
    const elapsed = Date.now() - started
    /**
     *
     * `setTimeout(50)` does not guarantee that `Date.now()` advances by 50.
     * Node arms the timer against libuv's cached loop time, which can already
     * be a fraction of a millisecond ahead of the `Date.now()` read taken just
     * before it — so a bare `>= grace` is wrong by construction, and fails
     * roughly one run in a hundred with "expected 49 to be >= 50". It did,
     * under a full `pnpm verify` where every workspace's suite is competing for
     * the loop. The tolerance is the clock's granularity, not slack: what this
     * asserts is still that the grace window was WAITED OUT rather than skipped,
     * which the keep-alive test above proves is a distinguishable outcome.
     *
     **/
    expect(elapsed).toBeGreaterThanOrEqual(49)
    expect(elapsed).toBeLessThan(400)
    expect(server.listening).toBe(false)
  })
})
