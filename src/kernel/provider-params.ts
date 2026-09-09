import { getRouterParam, type H3Event } from 'h3'
import { apiError } from './api-error.js'
import { isConfigKey } from './config-key.js'

/** OpenCode provider ids — same slug shape the org side enforces. */

/** The `[id]` route param as a validated OpenCode provider id. */
export function requireProviderIdParam(event: H3Event): string {
  const id = getRouterParam(event, 'id') ?? ''
  if (!isConfigKey(id)) {
    apiError(400, 'providers.idInvalid', 'Provider id must be a short lowercase id like "anthropic".')
  }
  return id
}
