import { definePlugin } from '../define.js'
import { checkRunningWorkflowRuns } from './workflow-run-poll.js'
import { listActiveWorkflowRuns, runSessionIds } from './workflow-run-queries.js'
import { bind } from './host.js'
import { createWorkflow, getWorkflow, listWorkflows, publishedGraph, updateWorkflow } from './workflows.js'
import { enqueueWorkflowRun, replayPendingApprovals } from './workflow-runs.js'
import { recoverWorkflowRuns } from './workflow-run-lifecycle.js'
import route_workflows_id_delete from './workflows.id.delete.js'
import route_workflows_id_get from './workflows.id.get.js'
import route_workflows_id_patch from './workflows.id.patch.js'
import route_workflows_id_publish_post from './workflows.id.publish.post.js'
import route_workflows_id_run_post from './workflows.id.run.post.js'
import route_workflows_id_versions_version_restore_post from './workflows.id.versions.version.restore.post.js'
import route_workflows_index_get from './workflows.index.get.js'
import route_workflows_index_post from './workflows.index.post.js'
import route_workflow_runs_runId_get from './workflow-runs.runId.get.js'
import route_workflow_runs_runId_cancel_post from './workflow-runs.runId.cancel.post.js'
import route_workflow_runs_runId_decisions_nodeRunId_post from './workflow-runs.runId.decisions.nodeRunId.post.js'
import route_workflow_runs_index_get from './workflow-runs.index.get.js'

export default definePlugin({
  name: 'workflows',
  description: 'Multi-step graphs the machine runs on its own',

  uses: ['bindSessionToProject', 'detachTriggersForWorkflow', 'markUnattended', 'notify'],

  setup(host) {
    /**
     *
     * A run files its session under a project, tells the owner once when it settles, and on
     * delete asks whoever owns triggers to detach whatever still points at it.
     *
     **/
    bind(host)

    /**
     *
     * What a schedule or a webhook pointing at a workflow actually does. A
     * trigger fires the PUBLISHED graph and nothing else, so a half-finished
     * edit open on the canvas can never go off at 03:00 — and the caller is
     * told WHY it did not start, because a trigger aimed at a disabled or
     * unpublished workflow is an ordinary state somebody has to be able to see.
     *
     **/
    host.provide({
      startWorkflow: async ({ workflowId, source, triggerId, input }) => {
        const workflow = await getWorkflow(workflowId)
        if (!workflow || !workflow.enabled) return { started: false, reason: 'the workflow is missing or disabled' }
        const graph = publishedGraph(workflow)
        if (!graph) return { started: false, reason: 'the workflow has no published version' }
        await enqueueWorkflowRun({
          workflow,
          graph,
          version: workflow.publishedVersion,
          source: source as 'schedule' | 'webhook',
          triggerId,
          input: (input ?? null) as Parameters<typeof enqueueWorkflowRun>[0]['input'],
        })
        return { started: true }
      },
      /**
       *
       * What an asset library may do with workflows, and nothing more: list
       * what can be shared, read one out, take one in. A handle on the store
       * would let a library do anything at all to them.
       *
       **/
      workflowLibrary: () => ({
        list: async () =>
          (await listWorkflows()).map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            publishedVersion: workflow.publishedVersion,
          })),
        read: async (idOrName) => {
          const workflow = (await listWorkflows()).find((entry) => entry.id === idOrName || entry.name === idOrName)
          /**
           *
           * The PUBLISHED graph, never the draft: what an org installs should
           * be what its author decided was ready, not whatever was open on
           * their canvas.
           *
           **/
          return workflow ? { id: workflow.id, name: workflow.name, graph: publishedGraph(workflow) } : null
        },
        upsert: async ({ name, description, graph }) => {
          const existing = (await listWorkflows()).find((entry) => entry.name === name)
          const fields = { name, description: description ?? '', draft: graph as never }
          if (existing) return { id: ((await updateWorkflow(existing.id, fields)) ?? existing).id }
          return { id: (await createWorkflow({ ...fields, projectId: null })).id }
        },
      }),
    })

    /**
     *
     * A run reports its outcome ONCE. Without this a five-node workflow tells
     * the owner five times, and the notification becomes noise nobody reads.
     *
     **/
    host.provide((current) => ({
      ...current,
      claimsCompletion: async (sessionId) => {
        if (await current.claimsCompletion?.(sessionId)) return true
        const runs = await listActiveWorkflowRuns(['running', 'waiting'])
        return runs.some((run) => runSessionIds(run).includes(sessionId))
      },
    }))

    /**
     *
     * Resume whatever a restart interrupted, then drive the runs: poll the
     * active step's session for its finished turn, chain the next step, settle.
     * Clients never tick — every transition reaches them as a push.
     *
     **/
    host.jobs.once(recoverWorkflowRuns)
    host.jobs.every(5_000, checkRunningWorkflowRuns)
    /**
     *
     * This plugin's opening frame: the approvals still waiting on a person.
     *
     * A run can be parked for days, so the client most likely to care is the one
     * that was not connected when it parked. Without this the only announcement
     * was the single live push at the moment it happened.
     *
     **/
    host.events.onConnect(replayPendingApprovals)
    host.routes.delete('/workflows/:id', route_workflows_id_delete)
    host.routes.get('/workflows/:id', route_workflows_id_get)
    host.routes.patch('/workflows/:id', route_workflows_id_patch)
    host.routes.post('/workflows/:id/publish', route_workflows_id_publish_post)
    host.routes.post('/workflows/:id/run', route_workflows_id_run_post)
    host.routes.post('/workflows/:id/versions/:version/restore', route_workflows_id_versions_version_restore_post)
    host.routes.get('/workflows', route_workflows_index_get)
    host.routes.post('/workflows', route_workflows_index_post)
    host.routes.get('/workflow-runs/:runId', route_workflow_runs_runId_get)
    host.routes.post('/workflow-runs/:runId/cancel', route_workflow_runs_runId_cancel_post)
    host.routes.post('/workflow-runs/:runId/decisions/:nodeRunId', route_workflow_runs_runId_decisions_nodeRunId_post)
    host.routes.get('/workflow-runs', route_workflow_runs_index_get)
  },
})
