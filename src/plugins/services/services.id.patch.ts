import { defineEventHandler, getRouterParam, send } from 'h3'
import { requireAuth, readJsonBody } from '../../kernel/index.js'
import {
  type ServiceRecord,
  patchService,
  validateCommand,
  validateCwd,
  validateEnv,
  validateName,
  validatePort,
  validateScope,
} from './services.js'

/** Edit a declaration. Every field is optional — an env-only save (US-8, the
 *  "it won't start without DATABASE_URL" fix) must not have to re-send the
 *  command. Edits never touch a running process: the change lands on the
 *  record, and the user restarts when they're ready. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id')!
  const body = await readJsonBody<{
    name?: unknown
    command?: unknown
    cwd?: unknown
    port?: unknown
    scope?: unknown
    env?: unknown
  }>(event)

  const patch: Partial<Pick<ServiceRecord, 'name' | 'command' | 'cwd' | 'port' | 'scope' | 'env'>> = {}
  if (body.name !== undefined) patch.name = validateName(body.name)
  if (body.command !== undefined) patch.command = validateCommand(body.command)
  if (body.cwd !== undefined) patch.cwd = validateCwd(body.cwd)
  if (body.port !== undefined) patch.port = validatePort(body.port)
  if (body.scope !== undefined) patch.scope = validateScope(body.scope)
  if (body.env !== undefined) patch.env = validateEnv(body.env)

  return { service: await patchService(id, patch) }
})
