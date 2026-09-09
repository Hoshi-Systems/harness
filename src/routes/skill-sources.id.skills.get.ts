import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { apiError, requireAuth, browseSkillSource, SkillSourceError } from '../kernel/index.js'

/** What a source offers, for a query. A directory needs one (its index is the
 *  size of the ecosystem); a repository lists everything it has and treats the
 *  query as a filter. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  const query = getQuery(event).q
  try {
    return { skills: await browseSkillSource(id, typeof query === 'string' ? query : '') }
  } catch (error) {
    if (error instanceof SkillSourceError) apiError(error.status, 'skillSource.browseFailed', error.message)
    throw error
  }
})
