import { defineEventHandler, getRouterParam } from 'h3'
import { requireAuth, apiError, readJsonBody, isLevel, setLevel, type Level } from '../kernel/index.js'

/** Colons and dots included: an MCP tool id is `server:tool`, possibly dotted. */
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,128}$/

/** Set a tool's access level.
 *
 *  Applies immediately, mid-turn included. Under the old runtime this was a
 *  global-config write that disposed the runtime, so a save made during a
 *  generation had to be parked or it would kill the user's work; levels are
 *  read when a tool is about to run now, so saving one cannot reach a running
 *  turn at all. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!TOOL_ID.test(id)) apiError(400, 'tool.invalidId', 'Invalid tool id.')

  const body = await readJsonBody<{ level?: unknown }>(event)
  if (!isLevel(body.level)) apiError(400, 'tool.invalidLevel', 'level must be allow, ask, or deny.')

  await setLevel(id, body.level as Level)
  return { ok: true }
})
