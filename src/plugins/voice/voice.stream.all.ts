import { defineEventHandler, createError } from 'h3'
import type { Peer } from 'crossws'
import { VoiceStreamSession } from './stream-session.js'
import { authorizeUpgrade } from '../../kernel/index.js'

/** Dictation over one WebSocket — the desktop sidecar's protocol adapted to
 *  the wire: every client frame is binary with a one-byte tag (crossws's Node
 *  adapter surfaces text frames as Buffers too, so frame *type* can't carry
 *  meaning): 0x01 + UTF-8 JSON for commands (`start`/`stop`/`cancel`), 0x02 +
 *  16 kHz mono Float32 PCM for audio. Events flow back as JSON text frames —
 *  this route owns the framing and dispatch; the utterance/engine lifecycle
 *  (and the event vocabulary) is utils/voice/stream-session.ts. */

const FRAME_COMMAND = 0x01
const FRAME_AUDIO = 0x02

function sessionOf(peer: Peer): VoiceStreamSession {
  return (peer.context.voice ??= new VoiceStreamSession((event) =>
    peer.send(JSON.stringify(event)),
  )) as VoiceStreamSession
}

export default defineEventHandler({
  websocket: {
    async upgrade(request) {
      if (!(await authorizeUpgrade(request.headers, new URL(request.url)))) {
        return new Response('Unauthorized', { status: 401 })
      }
    },

    async message(peer, message) {
      /**
       *
       * Nothing here may reject — crossws doesn't catch async hook failures,
       * and an unhandled rejection is process-fatal under the resilience
       * policy (plugins/resilience.ts, scripts/dev-guard.cjs).
       *
       **/
      try {
        const bytes = message.uint8Array()
        if (bytes.byteLength === 0) return

        if (bytes[0] === FRAME_AUDIO) {
          const session = sessionOf(peer)
          if (!session.listening) return
          /**
           *
           * Copy past the tag — `bytes` may be a pooled Node Buffer (whose
           * .slice is a view), and the samples must be 4-byte aligned in a
           * buffer the utterance can own. `new Uint8Array(view)` is a true
           * copy into an exactly-sized fresh buffer.
           *
           **/
          const pcm = new Uint8Array(bytes.subarray(1))
          if (pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return
          session.append(new Float32Array(pcm.buffer))
          return
        }
        if (bytes[0] !== FRAME_COMMAND) return

        let command: { type?: string }
        try {
          command = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
        } catch {
          return
        }
        switch (command.type) {
          case 'start':
            await sessionOf(peer).start()
            break
          case 'stop':
            await sessionOf(peer).stop()
            break
          case 'cancel':
            sessionOf(peer).cancel()
            break
        }
      } catch (err) {
        try {
          peer.send(
            JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'voice stream failed' }),
          )
        } catch {
          /**
           *
           * Peer already gone — nothing to tell.
           *
           **/
        }
      }
    },

    close(peer) {
      sessionOf(peer).dispose()
    },
  },

  /**
   *
   * The route is WebSocket-only — a plain request has nothing to talk to.
   *
   **/
  handler: () => {
    throw createError({ statusCode: 426, statusMessage: 'Upgrade Required' })
  },
})
