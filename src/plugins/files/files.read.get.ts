import { defineEventHandler, getQuery } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { apiError, requireAuth, OutsideWorkspaceError, resolveWorkspacePath } from '../../kernel/index.js'

/** One file's contents, for the file panel's viewer.
 *
 *  Binary files come back base64 rather than as mangled text: the panel shows an
 *  image or says "binary", and a UTF-8 decode of a PNG is neither. Detection is
 *  a NUL byte in the first block — crude, and right about every real case here,
 *  which is source files versus images and archives. */
const MAX_BYTES = 2 * 1024 * 1024
const SNIFF_BYTES = 8_000

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const requested = String(getQuery(event).path ?? '')
  if (!requested) apiError(400, 'files.pathRequired', 'path is required.')

  let absolute: string
  try {
    absolute = resolveWorkspacePath(requested)
  } catch (error) {
    if (error instanceof OutsideWorkspaceError) apiError(400, 'files.outsideWorkspace', error.message)
    throw error
  }

  const stats = await stat(absolute).catch(() => null)
  if (!stats?.isFile()) apiError(404, 'files.notFound', 'No such file on this machine.')
  if (stats.size > MAX_BYTES) {
    apiError(413, 'files.tooLarge', 'That file is too large to open here — read it from a session instead.')
  }

  const buffer = await readFile(absolute)
  const binary = buffer.subarray(0, SNIFF_BYTES).includes(0)
  return binary
    ? { type: 'binary' as const, content: buffer.toString('base64'), encoding: 'base64' as const }
    : { type: 'text' as const, content: buffer.toString('utf8') }
})
