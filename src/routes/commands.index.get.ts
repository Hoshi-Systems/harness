import { defineEventHandler } from 'h3'
import { requireAuth, requestedDirectory, listCommands } from '../kernel/index.js'

/** Slash commands defined on this machine. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  /**
   *
   * Scoped to the session's checkout when the caller names one: a project's own
   * definitions override the machine's, and a client with a session open should
   * see what that session will actually run.
   *
   **/
  return { commands: await listCommands(await requestedDirectory(event)) }
})
