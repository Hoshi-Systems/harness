import { defineEventHandler } from 'h3'
import { apiError, readJsonBody, requireAuth, WORKSPACE_ROOT } from '../../kernel/index.js'
import { openTerminal } from './terminals.js'

/** Open a shell. `directory` is where it starts — a checkout, or the workspace
 *  root for the personal space; anything outside the workspace is refused, the
 *  same boundary every other path-taking route holds.
 *
 *  The size is the client's viewport at the moment it asked. It is a starting
 *  guess: the socket resizes on every layout change, and the dock changes layout
 *  constantly. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ directory?: unknown; cols?: unknown; rows?: unknown }>(event)

  const root = WORKSPACE_ROOT
  const directory = typeof body.directory === 'string' && body.directory ? body.directory : root
  if (!directory.startsWith(root)) {
    apiError(400, 'terminal.outsideWorkspace', 'A shell must start inside the workspace.')
  }

  try {
    return {
      terminal: await openTerminal({
        directory,
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
      }),
    }
  } catch (error) {
    apiError(503, 'terminal.unavailable', (error as Error).message)
  }
})
