import { defineEventHandler } from 'h3'
import { requireAuth, publishMachineState, apiError, refreshCatalogue } from '../kernel/index.js'

/** Refetch the open model catalogue (models.dev) now.
 *
 *  The machine refreshes it at boot and once a day, best-effort. This is the
 *  retry for the case that leaves a person stuck: the boot fetch failed — no
 *  egress yet, a proxy not configured, the machine started before the network
 *  did — and "Connect provider" opens on an empty list with nothing to explain
 *  it. Here the failure is the answer, so it is reported rather than swallowed.
 */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  try {
    const result = await refreshCatalogue()
    await publishMachineState()
    return result
  } catch (error) {
    apiError(
      502,
      'catalogue.unreachable',
      `Could not reach the model catalogue: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
})
