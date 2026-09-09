import { defineEventHandler, getQuery } from 'h3'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { apiError, requireAuth, OutsideWorkspaceError, resolveWorkspacePath } from '../../kernel/index.js'

/** The direct children of one directory, for the file panel.
 *
 *  One level, not a recursive walk: the panel expands a folder at a time, and a
 *  route that returned the whole tree would spend its time on branches nobody
 *  opened. Directories first, then files, both alphabetical — a panel that
 *  reorders itself between reads is a panel people lose their place in. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const requested = String(getQuery(event).path ?? '')

  let absolute: string
  try {
    absolute = resolveWorkspacePath(requested)
  } catch (error) {
    if (error instanceof OutsideWorkspaceError) apiError(400, 'files.outsideWorkspace', error.message)
    throw error
  }

  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null)
  if (!entries) apiError(404, 'files.notFound', 'No such directory on this machine.')

  const files = entries
    .map((entry) => ({
      name: entry.name,
      path: path.join(requested, entry.name),
      absolute: path.join(absolute, entry.name),
      type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      /**
       *
       * Dotfiles and the usual build output: present, but the panel dims them
       * rather than hiding them — a file you cannot see is a file you cannot
       * ask about.
       *
       **/
      ignored: entry.name.startsWith('.') || IGNORED.has(entry.name),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))

  return { files }
})

const IGNORED = new Set(['node_modules', 'dist', 'build', '.output', '.nuxt', 'target', '.venv', '__pycache__'])
