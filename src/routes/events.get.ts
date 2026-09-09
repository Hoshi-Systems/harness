import { defineEventHandler, send, createEventStream } from 'h3'
import {
  bootNarration,
  collectMachineState,
  openClientStream,
  requireAuth,
  subscribeMachineEvents,
  type MachineEvent,
} from '../kernel/index.js'
import { ports } from '../kernel/host-ports.js'

/** Keep the client's 30s stream watchdog fed — same ~10s cadence as OpenCode's
 *  own `/event` heartbeats. */
const HEARTBEAT_MS = 10_000

/** The machine's own realtime feed: everything the sidecar owns (goals, tasks,
 *  processes, ports) streams here as SSE, published by utils/machine-events.ts.
 *  Clients hydrate a surface once over plain GET, then subscribe — never poll.
 *
 *  Connecting immediately pushes the `machine.state` snapshot — runtime
 *  readiness and onboarding, what a client routes its entry screens off — and
 *  then hands the stream to whatever else this machine runs, so each of them
 *  can send its own opening snapshot (kernel/ports.ts `replayOnConnect`). The
 *  kernel does not know what those are, which is the point: boot narration,
 *  listening ports, running processes and spend budgets are all somebody
 *  else's, and a stream that had to import them could not ship without them. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const stream = createEventStream(event)
  const push = (e: MachineEvent) => void stream.push(JSON.stringify(e))

  const unsubscribe = subscribeMachineEvents(push)
  /** One open stream is one person with this machine on screen — the only
   *  signal on the machine that says so, and what idle sleep reads. */
  const closeClientStream = openClientStream()
  const heartbeat = setInterval(() => push({ type: 'machine.heartbeat', properties: {} }), HEARTBEAT_MS)
  heartbeat.unref?.()

  stream.onClosed(() => {
    clearInterval(heartbeat)
    unsubscribe()
    closeClientStream()
  })

  void collectMachineState()
    .then((state) => {
      push({ type: 'machine.state', properties: { state } })
      /**
       *
       * The boot narration so far, so a client that arrives mid-boot — or
       * reconnects through one — reads the whole story rather than only the
       * lines that happen to come after it connected.
       *
       **/
      push({ type: 'machine.boot.snapshot', properties: { lines: bootNarration() } })
      return ports().replayOnConnect?.(push)
    })
    .catch((error) => console.error('[harness] failed to replay state on connect:', error))

  return stream.send()
})
