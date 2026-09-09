import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, optionalProjectId, readJsonBody } from '../../kernel/index.js'
import type { Workflow } from './workflows.js'
import {
  updateWorkflow,
  validateWorkflowDescription,
  validateWorkflowDraft,
  validateWorkflowName,
} from './workflows.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    name?: unknown
    description?: unknown
    enabled?: unknown
    projectId?: unknown
    draft?: unknown
  }>(event)

  const patch: Partial<Pick<Workflow, 'name' | 'description' | 'enabled' | 'projectId' | 'draft'>> = {}
  if (body.name !== undefined) patch.name = validateWorkflowName(body.name)
  if (body.description !== undefined) patch.description = validateWorkflowDescription(body.description)
  /**
   *
   * Saving the canvas never changes what triggers run — that needs a publish.
   *
   **/
  if (body.draft !== undefined) patch.draft = validateWorkflowDraft(body.draft)
  if (body.enabled !== undefined) patch.enabled = body.enabled === true
  if (body.projectId !== undefined) patch.projectId = optionalProjectId(body.projectId)

  const workflow = await updateWorkflow(getRouterParam(event, 'id')!, patch)
  if (!workflow) apiError(404, 'workflow.notFound', 'Workflow not found.')
  return { workflow }
})
