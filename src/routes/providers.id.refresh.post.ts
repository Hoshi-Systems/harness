import { defineEventHandler, getRouterParam } from 'h3'
import {
  apiError,
  requireAuth,
  ProviderUnreachableError,
  publishMachineState,
  refreshProviderModels,
} from '../kernel/index.js'

/** Ask a provider what models it has, again, right now.
 *
 *  For the endpoints whose model list is a live fact rather than a published
 *  one: a local runtime (LM Studio, Ollama, vLLM) gains and loses models as the
 *  person loads and unloads them, and this machine keeps the list it was given
 *  when the provider was connected. Before this, a model loaded since then was
 *  invisible — and a list captured before the runtime published its context
 *  lengths kept reporting zero, which is why the composer's context meter
 *  vanished for anybody running one.
 *
 *  The stored list is REPLACED, not merely re-read: the stale answer is on
 *  disk, so dropping a cache would have changed nothing. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  try {
    const provider = await refreshProviderModels(id)
    if (!provider) apiError(404, 'provider.notFound', 'No such provider on this machine.')
    await publishMachineState()
    return { provider }
  } catch (error) {
    if (error instanceof ProviderUnreachableError) apiError(502, 'provider.unreachable', error.message)
    throw error
  }
})
