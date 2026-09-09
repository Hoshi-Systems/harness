import type { Server } from 'node:http'

/**
 *
 * Closing a listening server that has clients attached.
 *
 * `server.close()` alone NEVER resolves on a machine with a client attached. It
 * stops accepting new connections and then waits for the open ones — and this
 * daemon's open ones are event streams, which by design do not end. One
 * connected browser tab was enough to make the process ignore SIGTERM entirely,
 * so `docker stop` sat out its timeout and then SIGKILLed the machine mid-turn:
 * exactly the corruption the graceful path exists to prevent, caused by the
 * graceful path.
 *
 * So: stop accepting, hang up the idle keep-alives at once, give whatever is
 * genuinely mid-request a short window to finish writing, then cut the streams.
 * A turn survives this — its transcript write is not the socket.
 *
 * This lives in its own module so `shutdown.test.ts` can drive the REAL
 * function. It used to be five lines inline in `createHarness().close()`, with
 * a hand-copied replica in the test carrying the comment "the shutdown
 * `createHarness().close()` performs" — which is an assertion about the
 * implementation that nothing checked. A copy cannot fail when the original
 * regresses, and that is the whole job this test was written to do.
 *
 **/
export async function closeHttpServer(
  server: Server,
  { grace, deadline }: { grace: number; deadline: number },
): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeIdleConnections()
  const cut = setTimeout(() => server.closeAllConnections(), grace)
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, deadline))])
  clearTimeout(cut)
}
