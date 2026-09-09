import { bindTools } from '../define-tool.js'
import type { ToolSet } from 'ai'
import { machineToolContext } from '../tool-context.js'
import { gitTools } from './tools.js'
import { definePlugin } from '../define.js'
import { bind } from './host.js'
import { watchGit } from './watch.js'
import route_git_branch_post from './git.branch.post.js'
import route_git_ci_event_post from './git.ci-event.post.js'
import route_git_commit_post from './git.commit.post.js'
import route_git_diff_get from './git.diff.get.js'
import route_git_pr_post from './git.pr.post.js'
import route_git_status_get from './git.status.get.js'

export default definePlugin({
  name: 'git',
  description: 'Repositories, pull requests, and the loop that repairs red CI',
  capability: { id: 'git.repositories', title: 'Repositories', description: 'Repositories, pull requests, and the loop that repairs red CI' },

  uses: ['dispatch', 'mayProceed', 'notify', 'platform', 'spendBlocked'],

  setup(host) {
    /**
     *
     * The CI loop acts with nobody watching: it asks org policy whether a call may proceed,
     * checks the ceiling, dispatches the fix and tells the owner. `platform` is how a pull
     * request gets reported.
     *
     **/
    bind(host)

    /**
     *
     * The agent's `git_branch`/`git_commit`/`git_pr`, beside the routes that
     * serve the same operations to the app. They lived in the tool registry
     * package, contributed by `widgets`, which knows nothing about git
     * (docs/STRUCTURE_REVIEW.md H-08).
     *
     * They still shell out to `git` themselves rather than through ./exec.ts —
     * the tool bodies answer to a model and the route bodies to a client, and
     * the two shapes have not been reconciled. That duplication was invisible
     * while they lived in different packages; it is a neighbour now, which is
     * the point of moving them.
     *
     **/
    host.tools.add(
      (context): ToolSet => bindTools(gitTools, machineToolContext(context)),
      () => Object.keys(gitTools),
    )
    watchGit(host.jobs.every)
    host.routes.post('/git/branch', route_git_branch_post)
    host.routes.post('/git/ci-event', route_git_ci_event_post)
    host.routes.post('/git/commit', route_git_commit_post)
    host.routes.get('/git/diff', route_git_diff_get)
    host.routes.post('/git/pr', route_git_pr_post)
    host.routes.get('/git/status', route_git_status_get)
  },
})
