/**
 * ── Machine event bus ────────────────────────────────────────────────────────
 *
 * The rule: all realtime communication with a machine flows over events, never
 * client polling. This is the ONE bus — turns, goals, dispatched tasks,
 * background processes, listening ports (there was a second stream while a
 * separate agent server sat behind a proxy). Every mutation path publishes
 * here, and `routes/events.get.ts` fans the bus out to each connected client as
 * `GET /events` — so a client hydrates a surface once with a plain GET and then
 * only ever listens. Anything new the machine owns that a client watches live
 * MUST publish here in the same change that adds it.
 *
 * Event shape mirrors OpenCode's `{ type, properties }` convention so client
 * fan-out code handles both streams identically.
 *
 **/

export interface MachineEvent {
  type: string
  properties: Record<string, unknown>
}

type MachineEventHandler = (event: MachineEvent) => void

const handlers = new Set<MachineEventHandler>()

/** Broadcast one event to every live `/events` connection. Handlers consume
 *  synchronously (the SSE route serializes at push time), so passing live
 *  store objects is safe — no defensive copies needed. */
export function publishMachineEvent(type: string, properties: Record<string, unknown>): void {
  const event: MachineEvent = { type, properties }
  for (const handler of handlers) {
    try {
      handler(event)
    } catch (error) {
      console.error(`[machine-events] subscriber failed on ${type}:`, error)
    }
  }
}

export function subscribeMachineEvents(handler: MachineEventHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** How many `/events` connections are live right now — the state watchers
 *  (plugins/state-events.ts) only scan while someone is actually listening. */
export function machineEventSubscriberCount(): number {
  return handlers.size
}

/**
 * ── How many CLIENTS are watching ────────────────────────────────────────────
 *
 * Deliberately not `machineEventSubscriberCount()`, and the difference is not a
 * detail: that one counts every subscriber on the in-process bus, and at least
 * five of this machine's own plugins hold one for its whole life. Anything that
 * asks "is anybody looking at this machine" and reads THAT number gets `true`
 * forever — which is how idle sleep was first written, and it would have shipped
 * as a feature that reported diligently and never suspended anything.
 *
 * Incremented by `routes/events.get.ts` alone, because an open SSE stream is the
 * only thing on this machine that means a person has it on screen.
 *
 **/
let clientStreams = 0

/** Register an open client event stream. Returns the function that closes it —
 *  call it exactly once, from the stream's own teardown. */
export function openClientStream(): () => void {
  clientStreams += 1
  let closed = false
  return () => {
    if (closed) return
    closed = true
    clientStreams -= 1
  }
}

export function clientStreamCount(): number {
  return clientStreams
}
