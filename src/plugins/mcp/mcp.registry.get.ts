import { defineEventHandler, getQuery } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { FEATURED_INTEGRATIONS, searchRegistry } from './registry.js'

/** The Connectors marketplace catalog (CYB-97). No query serves the curated
 *  featured list (static — the marketplace opens instantly and survives a slow
 *  registry); a query searches the official MCP registry live. Items come
 *  pre-mapped to an installable config plus credential fields; installing goes
 *  through the normal POST /mcp. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim() : ''
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : undefined

  if (!q) return { items: FEATURED_INTEGRATIONS, nextCursor: null }

  try {
    return await searchRegistry(q, cursor)
  } catch {
    apiError(502, 'mcp.registryUnreachable', 'The integration registry is unreachable right now — try again shortly.')
  }
})
