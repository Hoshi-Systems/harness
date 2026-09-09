import { defineEventHandler } from 'h3'
import { requireAuth, readJsonBody } from '../../kernel/index.js'
import {
  createService,
  validateCommand,
  validateCwd,
  validateEnv,
  validateName,
  validatePort,
  validateScope,
} from './services.js'

/** Declare a service. This is the panel's own writer — the ad-hoc one the user
 *  fills in by hand. Stage 2 adds two more writers into the same store (the
 *  project's `dev.yml` `run:` block and detection); they differ only in the
 *  `source` they stamp, which is why it isn't accepted from the wire here. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{
    name?: unknown
    command?: unknown
    cwd?: unknown
    port?: unknown
    scope?: unknown
    env?: unknown
  }>(event)

  return {
    service: await createService({
      name: validateName(body.name),
      command: validateCommand(body.command),
      cwd: validateCwd(body.cwd),
      port: validatePort(body.port),
      scope: validateScope(body.scope),
      env: validateEnv(body.env),
    }),
  }
})
