import type {
  McpConnectorTokenSource,
  McpConnectorTokenSourceReference,
  McpConnectorTokenSourceResult,
} from '../../mcp-connectors.js'
import type { AuthStatus } from './oauth-store.js'

/**
 * Product brokers are process-local on purpose. Their Platform credentials and
 * any token they mint belong to the product plugin, not a connector definition
 * on disk. A restart therefore begins with an empty map and requires the
 * product plugin to bind its source again during setup.
 */
const sources = new Map<string, McpConnectorTokenSource>()
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export class InvalidTokenSourceError extends Error {}

/** Bind a source for the current harness process. A second plugin may not
 * silently replace the first source with the same name: doing so would turn a
 * declaration into an implicit credential-routing decision. */
export function bindTokenSource(id: string, resolve: McpConnectorTokenSource): () => void {
  if (!SOURCE_ID.test(id)) {
    throw new InvalidTokenSourceError('A connector token source id must use letters, digits, dots, dashes, or underscores.')
  }
  if (typeof resolve !== 'function') throw new InvalidTokenSourceError('A connector token source needs a resolver function.')
  const existing = sources.get(id)
  if (existing && existing !== resolve) throw new InvalidTokenSourceError('A connector token source is already bound.')
  sources.set(id, resolve)
  return () => {
    if (sources.get(id) === resolve) sources.delete(id)
  }
}

/** Called by the MCP plugin shutdown hook. This makes the restart contract
 * executable in same-process library tests as well as a real daemon restart. */
export function clearTokenSources(): void {
  sources.clear()
}

/** A deliberately ordinary error surface. Neither a resolver exception nor an
 * upstream OAuth response reaches a machine client or an agent tool list. */
export class TokenSourceUnavailableError extends Error {
  constructor(readonly auth: AuthStatus, message: string) {
    super(message)
  }
}

export async function resolveTokenSource(
  reference: McpConnectorTokenSourceReference,
  name: string,
): Promise<string> {
  const resolve = sources.get(reference.id)
  if (!resolve) {
    throw new TokenSourceUnavailableError('needs-auth', 'The required connector token source is not available.')
  }

  let result: McpConnectorTokenSourceResult
  try {
    result = await resolve({ name, scopes: [...(reference.scopes ?? [])] })
  } catch {
    throw new TokenSourceUnavailableError('needs-auth', 'The connector authorization is not available.')
  }

  if (result?.state === 'available' && typeof result.accessToken === 'string' && result.accessToken) {
    return result.accessToken
  }
  if (result?.state === 'expired') {
    throw new TokenSourceUnavailableError('expired', 'The connector authorization has expired.')
  }
  /** Revocation and transient broker failure have the same safe next action:
   * reconnect the product account. Do not expose which one occurred. */
  throw new TokenSourceUnavailableError('needs-auth', 'The connector authorization is not available.')
}
