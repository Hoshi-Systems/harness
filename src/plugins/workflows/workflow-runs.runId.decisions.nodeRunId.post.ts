import { defineEventHandler, getRouterParam, send } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { decideWorkflowApproval } from './workflow-runs.js'

const MAX_COMMENT = 2_000

/** Answer an approval a run is parked on. Idempotent by construction: the store
 *  409s a second decision, so a double-click or two people answering at once
 *  can't send the run down both ports. */
export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const body = await readJsonBody<{ decision?: unknown; comment?: unknown }>(event)

  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    apiError(400, 'workflowRun.decisionInvalid', 'A decision must be "approved" or "rejected".')
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
  if (comment.length > MAX_COMMENT) {
    apiError(400, 'workflowRun.commentLength', `A comment must be at most ${MAX_COMMENT} characters.`, {
      max: MAX_COMMENT,
    })
  }

  return {
    run: await decideWorkflowApproval({
      runId: getRouterParam(event, 'runId')!,
      nodeRunId: getRouterParam(event, 'nodeRunId')!,
      decision: body.decision,
      /**
       *
       * The email, not the numeric id: this is shown back in the run timeline,
       * and "who approved the deploy" wants a name a person recognizes.
       *
       **/
      decidedBy: session.email,
      comment: comment || null,
    }),
  }
})
