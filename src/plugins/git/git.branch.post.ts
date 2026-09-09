import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { resolveGitDir } from './exec.js'
import { sessionBranchName } from './remote.js'
import { gitCreateBranch } from './git.js'

/** Create (or switch to) the working branch a change is proposed on.
 *
 *  Body: `directory` (required) plus either an explicit `name`, or a `slug` the
 *  route turns into the `hoshi/<slug>` convention — a session title, a ticket
 *  key, whatever the caller has. Idempotent: switching to a branch that already
 *  exists is a success, not a conflict. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ directory?: unknown; name?: unknown; slug?: unknown }>(event)

  if (typeof body.directory !== 'string' || !body.directory) {
    apiError(400, 'git_directory_required', 'A directory is required.')
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : typeof body.slug === 'string' && body.slug.trim()
        ? sessionBranchName(body.slug)
        : null
  if (!name) {
    apiError(400, 'git.branchNameRequired', 'Pass either a branch name or a slug to derive one from.')
  }

  return gitCreateBranch(await resolveGitDir(body.directory), name)
})
