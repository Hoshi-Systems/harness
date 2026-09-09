import { defineEventHandler } from 'h3'
import { markSetupComplete, publishMachineState, requireAuth } from '../kernel/index.js'

/** The first-run wizard was finished or skipped. Recorded on the machine's
 *  own volume, then the state snapshot is re-published so every connected
 *  client — this one included — routes off the new answer rather than a
 *  response body. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  await markSetupComplete()
  const state = await publishMachineState()
  return { state }
})
