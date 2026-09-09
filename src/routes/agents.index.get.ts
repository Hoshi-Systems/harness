import { defineEventHandler } from 'h3'
import { requireAuth, requestedDirectory, listAgents } from '../kernel/index.js'

/** Addressable agents on this machine: the built-ins with any overrides folded
 *  in, plus whatever was added here. Never empty — a machine with no agents
 *  could not start a session. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  /**
   *
   * Scoped to the session's checkout when the caller names one: a project's own
   * definitions override the machine's, and a client with a session open should
   * see what that session will actually run.
   *
   **/
  return { agents: await listAgents(await requestedDirectory(event)) }
})
