import { defineEventHandler, getRouterParam } from 'h3'
import { apiError, requireAuth, readJsonBody } from '../../kernel/index.js'
import { enqueueWorkflowRun } from './workflow-runs.js'
import { requireRunnableGraph } from './graph/index.js'
import { getWorkflow, publishedGraph } from './workflows.js'

/** Manual run. Deliberately allowed on a disabled workflow — disabling gates
 *  the automatic triggers, not an explicit click. The optional `input` body
 *  stands in for a trigger payload (`{{input}}` / `{{trigger.body.*}}`), so
 *  webhook-shaped templates can be test-driven without firing the webhook.
 *
 *  Runs the DRAFT by default — that is the builder's preview, and the whole
 *  point of a draft is being able to try it before publishing. Pass
 *  `{ published: true }` to run exactly what the triggers would. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const workflow = await getWorkflow(getRouterParam(event, 'id')!)
  if (!workflow) apiError(404, 'workflow.notFound', 'Workflow not found.')

  const body = await readJsonBody<{ input?: unknown; published?: unknown }>(event)
  const input = body.input === undefined ? null : { body: body.input, headers: {}, query: {} }

  const usePublished = body.published === true
  const graph = usePublished ? publishedGraph(workflow) : workflow.draft
  if (!graph) apiError(400, 'workflow.notPublished', 'This workflow has no published version yet.')
  /**
   *
   * A draft preview is still a real run, so it is held to the same bar — the
   * difference between draft and published is WHICH graph runs, not whether an
   * unfinished one may.
   *
   **/
  requireRunnableGraph(graph)

  return {
    run: await enqueueWorkflowRun({
      workflow,
      graph,
      version: usePublished ? workflow.publishedVersion : null,
      source: 'manual',
      triggerId: null,
      input,
    }),
  }
})
