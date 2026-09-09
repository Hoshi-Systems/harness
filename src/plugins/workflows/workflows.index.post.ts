import { defineEventHandler } from 'h3'
import { requireAuth, optionalProjectId, readJsonBody } from '../../kernel/index.js'
import {
  createWorkflow,
  validateWorkflowDescription,
  validateWorkflowDraft,
  validateWorkflowName,
} from './workflows.js'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ name?: unknown; description?: unknown; projectId?: unknown; draft?: unknown }>(
    event,
  )

  return {
    workflow: await createWorkflow({
      name: validateWorkflowName(body.name),
      description: validateWorkflowDescription(body.description),
      projectId: optionalProjectId(body.projectId),
      draft: validateWorkflowDraft(body.draft),
    }),
  }
})
