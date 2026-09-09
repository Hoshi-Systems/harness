import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { requireRunnableGraph } from './graph/index.js'
import { getWorkflow, publishWorkflow, validateVersionNote } from './workflows.js'

/** Snapshot the draft as the next version and make it the one triggers fire.
 *  The draft's SHAPE was checked on every save; what is checked here is
 *  COMPLETENESS — a half-written node is fine to leave on the canvas overnight
 *  and never fine to put behind a schedule. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ note?: unknown }>(event)

  const id = getRouterParam(event, 'id')!
  const existing = await getWorkflow(id)
  if (!existing) apiError(404, 'workflow.notFound', 'Workflow not found.')
  requireRunnableGraph(existing.draft)

  const workflow = await publishWorkflow(id, validateVersionNote(body.note))
  if (!workflow) apiError(404, 'workflow.notFound', 'Workflow not found.')
  return { workflow }
})
