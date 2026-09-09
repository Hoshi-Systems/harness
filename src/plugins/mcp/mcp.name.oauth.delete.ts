import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth } from '../../kernel/index.js'
import { disconnectAuth } from './oauth-connect.js'
import { reconnectServer } from './servers.js'

/** Disconnect a connector's authorization: revoke it with the provider where
 *  they support it, and always forget it locally. The connector DEFINITION
 *  stays — somebody disconnecting an account has not asked to delete the server
 *  they configured, and deleting it would lose the URL they typed. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const name = getRouterParam(event, 'name')!
  await disconnectAuth(name)
  void reconnectServer(name).catch(() => undefined)
  return { ok: true }
})
