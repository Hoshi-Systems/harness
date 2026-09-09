import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, apiError } from '../../kernel/index.js'
import { resolveGitDir } from './exec.js'
import { gitStatus } from './git.js'

/** Branch / ahead-behind / dirty state for a workspace directory, plus the
 *  branch's own commits — what the Changes surface's proposed-change scope
 *  renders above the diff.
 *
 *  Query: `directory` (required), `pr` (`1` to also resolve the branch's pull
 *  request). The PR lookup is opt-in because it crosses the network to the
 *  forge: the panel asks for it when it opens, and the SSE-driven refreshes
 *  after that don't. PR state lives on the forge, so it is never polled. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = getQuery(event)

  const directory = typeof query.directory === 'string' ? query.directory : ''
  if (!directory) apiError(400, 'git_directory_required', 'A directory query parameter is required.')
  const withPr = query.pr === '1' || query.pr === 'true'

  return gitStatus(await resolveGitDir(directory), { withPr })
})
