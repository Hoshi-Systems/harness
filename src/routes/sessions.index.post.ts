import { defineEventHandler } from 'h3'
import {
  requireAuth,
  apiError,
  readJsonBody,
  createSession,
  InvalidDirectoryError,
  resolveSessionDirectory,
} from '../kernel/index.js'

/** Create a session. `directory` is where its work happens; absent means the
 *  personal space, so a client with no project context still gets a usable
 *  session (docs/MACHINE_WIRE.md).
 *
 *  `chat: true` asks for a session that stays a leaf — no children, no goal,
 *  read-only. It is a request rather than a mode: everything else about the
 *  session is unchanged, and every route below this one treats it as the
 *  session it is. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ directory?: unknown; chat?: unknown }>(event)
  try {
    const directory = await resolveSessionDirectory(body.directory)
    return { session: await createSession(directory, body.chat === true ? { chat: true } : {}) }
  } catch (error) {
    if (error instanceof InvalidDirectoryError) apiError(400, 'session.directoryInvalid', error.message)
    throw error
  }
})
