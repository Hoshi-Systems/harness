import { defineEventHandler } from 'h3'
import { requireAuth, apiError, readJsonBody, isLevel, setAllLevels, toolNames } from '../kernel/index.js'

/** One access level for every tool on this machine — the Tools screen's
 *  "default for all tools" control.
 *
 *  It overwrites each tool's own setting rather than changing what "default"
 *  means, which is what the screen says it does: the user can re-tweak
 *  individual tools afterwards. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readJsonBody<{ level?: unknown }>(event)
  if (!isLevel(body.level)) apiError(400, 'tool.invalidLevel', 'level must be allow, ask or deny.')
  return { ok: true, count: await setAllLevels(toolNames(), body.level) }
})
