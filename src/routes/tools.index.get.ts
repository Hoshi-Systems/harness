import { defineEventHandler } from 'h3'
import { requireAuth, defaultLevelFor, readPolicies, toolNames } from '../kernel/index.js'

/** Every tool the machine can offer an agent, with its effective access level.
 *  The list is derived from the engine's own registry, so a tool that exists
 *  cannot be missing from the screen that governs it.
 *
 *  `label` and `explicit` are here because the screen cannot honestly derive
 *  them. A client left to invent a display name invents a different one per
 *  client, and "is this level set or inherited?" is knowable only from the
 *  store — the surface that showed every row as DEFAULT was reading a field
 *  nobody sent. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const policies = await readPolicies()
  return {
    tools: toolNames().map((id) => {
      const policy = policies[id]
      return {
        id,
        ...describe(id),
        level: policy?.level ?? defaultLevelFor(id),
        explicit: !!policy?.level,
        /**
         *
         * Pattern rules ride along: they are exceptions to the level beside
         * them, and a screen that showed only the level would say "ask" about a
         * tool that silently allows half of what it does.
         *
         **/
        ...(policy?.rules?.length ? { rules: policy.rules } : {}),
      }
    }),
  }
})

/** A readable name, and the connector it came from when it is an MCP tool
 *  (`server:tool` — the one id shape that carries two things). */
function describe(id: string): { label: string; server?: string } {
  const [head, ...rest] = id.split(':')
  const local = rest.length > 0 ? rest.join(':') : head!
  const label = local.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
  return rest.length > 0 ? { label, server: head! } : { label }
}
