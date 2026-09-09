import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, getSession, readMessages } from '../kernel/index.js'

/** The session's full transcript. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await getSession(id))) apiError(404, 'session.notFound', 'No such session on this machine.')
  return { messages: await readMessages(id) }
})
