import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, apiError } from '../../kernel/index.js'
import { resolveGitDir, gitBranchInfo, gitDiffSummary, gitDiffFile } from './exec.js'

/** Git diffs for a workspace directory — the data source behind the Hoshi
 *  Computer's Files → Changes → Branch scope. (Session-scope changes come from
 *  OpenCode's own `session.diff`; this route exists for what OpenCode doesn't
 *  track: the branch's whole contribution vs its base.)
 *
 *  Query: `directory` (required), `scope` (`working` | `branch`, default
 *  `working`), `file` (optional — returns that file's unified diff instead of
 *  the summary). Branch scope with no recognizable base answers 200 with
 *  `base: null` and no files — an explainable state, not an error. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = getQuery(event)

  const directory = typeof query.directory === 'string' ? query.directory : ''
  if (!directory) apiError(400, 'git_directory_required', 'A directory query parameter is required.')
  const scope = query.scope === 'branch' ? 'branch' : 'working'
  const file = typeof query.file === 'string' && query.file ? query.file : null

  const dir = await resolveGitDir(directory)
  const { branch, base } = await gitBranchInfo(dir)
  if (scope === 'branch' && !base) return { branch, base: null, files: [] }
  const range = scope === 'branch' ? `${base}...HEAD` : undefined

  if (file) return { path: file, diff: await gitDiffFile(dir, file, range) }
  return { branch, base: scope === 'branch' ? base : null, files: await gitDiffSummary(dir, range) }
})
