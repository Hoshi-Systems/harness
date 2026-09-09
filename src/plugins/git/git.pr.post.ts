import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { resolveGitDir } from './exec.js'
import { openPullRequest } from './git.js'

const MAX_TITLE_LENGTH = 500
const MAX_BODY_LENGTH = 60_000

/** Push the working branch and open a pull/merge request for it, through
 *  whichever forge CLI the remote points at (`gh` / `glab`) and whichever
 *  credential this machine already holds — the account's SSH identity for the
 *  push, a vault token for the forge API. No new credential mechanism.
 *
 *  Body: `directory` + `title` (required), `body`, `base`, `draft`. Returns
 *  `{ url, number, branch }` (plus the PR's state) — and returns the EXISTING
 *  pull request, with `created: false`, when the branch already has one open. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    directory?: unknown
    title?: unknown
    body?: unknown
    base?: unknown
    draft?: unknown
  }>(event)

  if (typeof body.directory !== 'string' || !body.directory) {
    apiError(400, 'git_directory_required', 'A directory is required.')
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) {
    apiError(400, 'git.titleRequired', 'A pull request title is required.')
  }
  if (title.length > MAX_TITLE_LENGTH) {
    apiError(400, 'git.titleLength', 'A pull request title can be at most {max} characters.', {
      max: MAX_TITLE_LENGTH,
    })
  }
  const description = typeof body.body === 'string' ? body.body : ''
  if (description.length > MAX_BODY_LENGTH) {
    apiError(400, 'git.bodyLength', 'A pull request description can be at most {max} characters.', {
      max: MAX_BODY_LENGTH,
    })
  }
  const base = typeof body.base === 'string' && body.base.trim() ? body.base.trim() : undefined

  const { pr, branch, created } = await openPullRequest(await resolveGitDir(body.directory), {
    title,
    body: description,
    base,
    draft: body.draft === true,
  })
  return { url: pr.url, number: pr.number, branch, state: pr.state, checks: pr.checks, title: pr.title, created }
})
