import { defineEventHandler } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { getEngagement } from './engagements.js'

/** One engagement, whole — its steps, their dependencies and every step's
 *  live status. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = event.context.params?.id
  const engagement = typeof id === 'string' ? await getEngagement(id) : null
  if (!engagement) apiError(404, 'engagement_not_found', 'No such engagement on this machine.')
  return { engagement }
})
