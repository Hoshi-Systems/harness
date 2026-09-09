import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, readJsonBody, setCommand } from '../kernel/index.js'

/** Create or edit a slash command. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ description?: unknown; template?: unknown }>(event)
  for (const key of ['description', 'template'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      apiError(400, 'command.invalidField', `${key} must be a string.`)
    }
  }
  const command = await setCommand(getRouterParam(event, 'name') ?? '', {
    description: body.description as string | undefined,
    template: body.template as string | undefined,
  })
  return { command }
})
