import { defineEventHandler, getRouterParam } from 'h3'
import { answer, apiError, ASK_RESPONSES, readJsonBody, requireAuth, type AskResponse } from '../kernel/index.js'

/** Answer a pending ask. `always` allows this call and persists it, so "don't
 *  ask me again" is one action rather than an approval plus a trip to settings.
 *
 *  `patterns` says HOW WIDELY, on the same request rather than a second one:
 *  the tool's id grants the whole tool, anything else becomes a rule scoped to
 *  it (`git push *`). Omitted, the machine grants the narrowest scope the ask
 *  itself suggested — a card showing one harmless command must not silently
 *  approve every command the machine will ever run.
 *
 *  Answering an ask that is already gone is a 404 rather than a silent success:
 *  two clients may both be showing the card, and the second one deserves to
 *  know the decision was made elsewhere. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ response?: unknown; patterns?: unknown }>(event)
  if (!ASK_RESPONSES.includes(body.response as AskResponse)) {
    apiError(400, 'permission.responseInvalid', `response must be one of: ${ASK_RESPONSES.join(', ')}.`)
  }
  const patterns = Array.isArray(body.patterns)
    ? body.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && !!pattern.trim())
    : undefined
  const answered = await answer(getRouterParam(event, 'id') ?? '', body.response as AskResponse, patterns)
  if (!answered) apiError(404, 'permission.notFound', 'That request is no longer waiting for an answer.')
  return { ok: true }
})
