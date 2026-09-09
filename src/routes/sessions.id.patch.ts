import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, readJsonBody, renameSession, markManualTitle, releaseTitle } from '../kernel/index.js'

const MAX_TITLE = 200

/** Rename a session. Null clears the title back to "untitled" — the client's
 *  own way to undo a rename, so it is an explicit value rather than a delete. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ title?: unknown }>(event)

  let title: string | null = null
  if (body.title !== null && body.title !== undefined) {
    if (typeof body.title !== 'string') apiError(400, 'session.titleInvalid', 'title must be a string or null.')
    title = body.title.trim().slice(0, MAX_TITLE) || null
  }

  const sessionId = getRouterParam(event, 'id') ?? ''
  const session = await renameSession(sessionId, title)
  if (!session) apiError(404, 'session.notFound', 'No such session on this machine.')
  /**
   *
   * The one place a person names a session, so the one place that can tell the
   * title refresher to keep its hands off it (utils/session-titles.ts).
   *
   **/
  if (title) await markManualTitle(sessionId)
  else await releaseTitle(sessionId)
  return { session }
})
