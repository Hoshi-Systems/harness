import { defineEventHandler, getRouterParam, send, setResponseHeaders, setResponseStatus } from 'h3'
import { requireAuth, apiError, getSession, attachToTurn, isTurnRunning } from '../kernel/index.js'

/** Rejoin a turn already in flight.
 *
 *  204 when nothing is running — that status is the whole contract: it is how a
 *  reconnecting client tells "no turn" apart from "a turn I cannot see", and it
 *  is what @openharness/vue's resume expects.
 *
 *  A late subscriber gets everything emitted so far before the live feed, so
 *  reopening a laptop mid-answer shows the whole reply rather than joining
 *  mid-sentence. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(id))) apiError(404, 'session.notFound', 'No such session on this machine.')

  /**
   *
   * Decided BEFORE any stream is opened. Closing an empty event-stream would
   * answer 200 with nothing in it, and "an empty stream" is exactly what a
   * client cannot distinguish from "a turn whose events I am missing".
   *
   **/
  if (!isTurnRunning(id)) {
    setResponseStatus(event, 204)
    return null
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (chunk: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))

      const close = () => {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      const attached = attachToTurn(id, {
        onChunk: send,
        /**
         *
         * The turn ended — so does this stream. Leaving it open would hand the
         * client a connection that will never produce another byte, which it
         * cannot tell apart from a model still thinking.
         *
         **/
        onDone: close,
      })
      if (!attached) {
        close()
        return
      }
      if (attached.replay) send(attached.replay)
      event.node.res.on('close', () => {
        attached.detach()
        close()
      })
    },
  })

  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  return stream
})
