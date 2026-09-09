import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody } from '../../kernel/index.js'
import { resolveGitDir } from './exec.js'
import { gitCommit } from './git.js'

const MAX_MESSAGE_LENGTH = 20_000

/** Stage and commit the proposed change with the machine's resolved git
 *  identity.
 *
 *  Body: `directory` + `message` (required), optional `paths` to narrow what
 *  gets staged. The MESSAGE IS THE CALLER'S — this route never invents one. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ directory?: unknown; message?: unknown; paths?: unknown }>(event)

  if (typeof body.directory !== 'string' || !body.directory) {
    apiError(400, 'git_directory_required', 'A directory is required.')
  }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) {
    apiError(400, 'git.messageRequired', 'A commit message is required.')
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    apiError(400, 'git.messageLength', 'A commit message can be at most {max} characters.', {
      max: MAX_MESSAGE_LENGTH,
    })
  }
  let paths: string[] | undefined
  if (body.paths !== undefined) {
    if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string' || !p)) {
      apiError(400, 'git.pathsInvalid', 'paths must be an array of non-empty strings.')
    }
    paths = body.paths as string[]
  }

  return gitCommit(await resolveGitDir(body.directory), message, paths)
})
