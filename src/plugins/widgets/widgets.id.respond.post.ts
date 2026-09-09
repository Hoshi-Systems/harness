import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { respondToWidget } from './widgets.js'

/** Deliver the user's answer to an input widget (form/choice) that has the
 *  agent's tool call blocked. The widget id comes from the tool part's
 *  `hoshi.widget` metadata. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  if (!/^[\w-]{1,64}$/.test(id)) {
    apiError(400, 'widgets.invalidId', 'Invalid widget id.')
  }

  const body = await readJsonBody<{ response?: unknown }>(event)
  if (!body.response || typeof body.response !== 'object' || Array.isArray(body.response)) {
    apiError(400, 'widgets.invalidResponse', 'response must be an object.')
  }

  respondToWidget(id, body.response as Record<string, unknown>)
  return { ok: true }
})
