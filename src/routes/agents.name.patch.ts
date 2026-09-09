import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, readJsonBody, setAgent, isLevel, type Level } from '../kernel/index.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Edit an agent. Applies immediately and cannot reach a running turn: the
 *  catalogue is read when a turn starts, not baked into a process at boot. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const name = getRouterParam(event, 'name') ?? ''
  const body = await readJsonBody<{
    description?: unknown
    prompt?: unknown
    model?: unknown
    tools?: unknown
    permission?: unknown
  }>(event)

  const patch: {
    description?: string
    prompt?: string
    model?: string | null
    tools?: Record<string, boolean>
    permission?: Record<string, Level>
  } = {}
  for (const key of ['description', 'prompt'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') apiError(400, 'agent.invalidField', `${key} must be a string.`)
      patch[key] = body[key] as string
    }
  }
  if (body.model !== undefined) {
    if (body.model !== null && typeof body.model !== 'string') {
      apiError(400, 'agent.invalidField', 'model must be a string or null.')
    }
    patch.model = body.model as string | null
  }

  /**
   *
   * What this agent may DO, not just what it is told to do. `tools` removes a
   * tool from the set the agent is offered at all; `permission` may only make a
   * machine-wide level stricter (engine/tools.ts).
   *
   **/
  if (body.tools !== undefined) {
    if (!isRecord(body.tools) || Object.values(body.tools).some((value) => typeof value !== 'boolean')) {
      apiError(400, 'agent.invalidField', 'tools must be a map of tool name to true or false.')
    }
    patch.tools = body.tools as Record<string, boolean>
  }
  if (body.permission !== undefined) {
    if (!isRecord(body.permission) || Object.values(body.permission).some((value) => !isLevel(value))) {
      apiError(400, 'agent.invalidField', 'permission must be a map of tool name to allow, ask or deny.')
    }
    patch.permission = body.permission as Record<string, Level>
  }

  const agent = await setAgent(name, patch)
  if (!agent) apiError(404, 'agent.notFound', 'No such agent on this machine.')
  return { agent }
})
