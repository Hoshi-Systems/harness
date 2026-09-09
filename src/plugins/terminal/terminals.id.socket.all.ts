import { createError, defineEventHandler } from 'h3'
import type { Peer } from 'crossws'
import { authorizeUpgrade } from '../../kernel/index.js'
import { attachTerminal, resizeTerminal, writeTerminal } from './terminals.js'

/**
 * ── One shell, one socket ────────────────────────────────────────────────────
 *
 * The socket carries BYTES, not a session. Attaching hands back everything the
 * terminal has said so far and then streams what it says next; detaching leaves
 * the shell running, which is the entire reason terminals are owned by the
 * machine (./terminals.ts).
 *
 * Framing follows the voice stream's, which is the only other socket here: every
 * client frame is binary with a one-byte tag, because crossws's Node adapter
 * surfaces text frames as Buffers too and so frame TYPE cannot carry meaning.
 *
 *   0x01 + UTF-8 JSON   control — `attach`, `resize`
 *   0x02 + UTF-8 bytes  keystrokes, straight to the PTY
 *
 * Downward it is the same split by frame KIND, which is cheaper than a tag and
 * unambiguous in this direction: a TEXT frame is the shell's own output, sent
 * raw because it is already a byte stream and wrapping every chunk in JSON
 * would double the traffic of a `find /`; a BINARY frame is the machine
 * talking about the shell rather than for it (`gone`, `exit`). Splitting them
 * matters: a shell that prints `{"type":"gone"}` — `cat` a fixture, echo a
 * payload — must not be able to close its own tab.
 *
 **/

const FRAME_CONTROL = 0x01
const FRAME_INPUT = 0x02

/** A control message down the wire: binary, so it can never be confused with
 *  something the shell printed. */
function control(peer: Peer, message: Record<string, unknown>): void {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const framed = new Uint8Array(body.length + 1)
  framed[0] = FRAME_CONTROL
  framed.set(body, 1)
  try {
    peer.send(framed)
  } catch {
    /** Peer gone; `close` will clean up. */
  }
}

interface SocketState {
  terminalId: string
  detach: () => void
}

function state(peer: Peer): SocketState | null {
  return (peer.context.terminal as SocketState | undefined) ?? null
}

export default defineEventHandler({
  websocket: {
    async upgrade(request) {
      if (!(await authorizeUpgrade(request.headers, new URL(request.url)))) {
        return new Response('Unauthorized', { status: 401 })
      }
    },

    message(peer, message) {
      /**
       *
       * Nothing here may reject — crossws does not catch async hook failures,
       * and an unhandled rejection is process-fatal under the resilience policy
       * (plugins/resilience.ts).
       *
       **/
      try {
        const bytes = message.uint8Array()
        if (bytes.byteLength === 0) return

        if (bytes[0] === FRAME_INPUT) {
          const current = state(peer)
          if (current) writeTerminal(current.terminalId, new TextDecoder().decode(bytes.subarray(1)))
          return
        }
        if (bytes[0] !== FRAME_CONTROL) return

        let command: { type?: string; id?: string; cols?: number; rows?: number }
        try {
          command = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
        } catch {
          return
        }

        if (command.type === 'attach' && typeof command.id === 'string') {
          state(peer)?.detach()
          /**
           *
           * Size FIRST, then replay.
           *
           * A shell's line editor repaints its prompt on SIGWINCH — and a
           * repaint clears from the prompt down, over anything already on the
           * screen. Resizing after the replay therefore wipes it: the client
           * paints the transcript, sends its size, and the shell erases what it
           * just painted. Doing it in this order puts the repaint INTO the
           * buffer, so the replay is already the settled screen.
           *
           **/
          if (typeof command.cols === 'number' && typeof command.rows === 'number') {
            resizeTerminal(command.id, command.cols, command.rows)
          }
          const attached = attachTerminal(
            command.id,
            (chunk) => {
              try {
                peer.send(chunk)
              } catch {
                /** Peer gone mid-write; `close` will clean up. */
              }
            },
            (exitCode) => control(peer, { type: 'exit', exitCode }),
          )
          if (!attached) {
            control(peer, { type: 'gone' })
            return
          }
          peer.context.terminal = { terminalId: command.id, detach: attached.detach } satisfies SocketState
          /**
           *
           * Replay before any new byte can arrive — the listener is already
           * attached, so anything printed in between is queued behind this
           * send rather than lost ahead of it.
           *
           **/
          if (attached.replay) peer.send(attached.replay)
          return
        }

        if (command.type === 'resize') {
          const current = state(peer)
          if (current && typeof command.cols === 'number' && typeof command.rows === 'number') {
            resizeTerminal(current.terminalId, command.cols, command.rows)
          }
        }
      } catch {
        /** A malformed frame is not worth killing a shell over. */
      }
    },

    /**
     *
     * Detach only. The shell keeps running, keeps buffering, and is there when
     * the person comes back — which is the promise this whole plugin exists to
     * make (./terminals.ts).
     *
     **/
    close(peer) {
      state(peer)?.detach()
      peer.context.terminal = undefined
    },
  },

  /**
   *
   * WebSocket-only — a plain request has nothing to talk to.
   *
   **/
  handler: () => {
    throw createError({ statusCode: 426, statusMessage: 'Upgrade Required' })
  },
})
