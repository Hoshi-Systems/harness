/**
 * Public, tokenless contract for a plugin that installs a declared remote MCP
 * connector. The MCP plugin owns storage, discovery and credentials; a product
 * plugin only names an endpoint and vault bindings.
 */
export type McpConnectorTransport = 'http' | 'sse'

/** One request header whose value is assembled on the machine when it dials.
 * `template` is either `{{secret}}` or `Bearer {{secret}}`. For example:
 * `{ key: 'GITHUB_TOKEN', template: 'Bearer {{secret}}' }`.
 */
export interface McpConnectorVaultHeader {
  /** Name of a machine-vault key. Its value never crosses this public seam. */
  key: string
  /** `{{secret}}` or `Bearer {{secret}}`. */
  template: string
}

/** A runtime-only identity source supplied by another plugin. The persisted
 * connector definition names this source, but never carries a token, a refresh
 * token, or a client secret. */
export interface McpConnectorTokenSourceReference {
  /** Stable, product-defined name of a source bound during plugin setup. */
  id: string
  /** Permissions the product asks its broker to mint for this connector. */
  scopes?: string[]
}

/** What a product-owned broker can safely tell the MCP plugin. A token is
 * consumed immediately to make one connection and is never written to storage.
 * The non-ready cases intentionally contain no upstream error detail: a
 * machine UI can distinguish an expired authorization from one needing action
 * without exposing a provider response, secret, or account information. */
export type McpConnectorTokenSourceResult =
  | { state: 'available'; accessToken: string }
  | { state: 'unavailable' | 'expired' | 'revoked' }

export interface McpConnectorTokenSourceRequest {
  /** Connector asking for the token; useful when one broker serves several. */
  name: string
  /** The declaration's scopes, copied rather than read from durable storage by
   * the product plugin. */
  scopes: string[]
}

/** A product plugin binds this during every boot. It is deliberately runtime
 * state: a restarted machine must re-establish its Platform connection before
 * a persisted connector can use the source again. */
export type McpConnectorTokenSource = (
  input: McpConnectorTokenSourceRequest,
) => Promise<McpConnectorTokenSourceResult>

export interface McpConnectorDeclaration {
  name: string
  url: string
  transport: McpConnectorTransport
  /** Header name -> vault binding. Literal credentials are intentionally absent. */
  vaultHeaders?: Record<string, McpConnectorVaultHeader>
  /** A non-secret broker source. Mutually exclusive with vault headers: one
   * connector has one credential owner. */
  tokenSource?: McpConnectorTokenSourceReference
}

export type McpConnectorAuthStatus = 'authenticated' | 'needs-auth' | 'expired' | null
export type McpConnectorStatus = 'connected' | 'unreachable' | 'disabled'

/** Deliberately excludes URL, header bindings and all credential material. */
export interface McpConnectorSnapshot {
  name: string
  status: McpConnectorStatus
  auth: McpConnectorAuthStatus
  toolCount: number
}

export interface McpDcrAuthorizationRequest {
  name: string
  /** The request that initiated authorization, used only to derive the machine callback origin. */
  request: { headers: Record<string, string | string[] | undefined> }
  scopes?: string[]
}

/** The MCP plugin's narrow service for external product plugins. */
export interface McpConnectorPort {
  install(input: McpConnectorDeclaration): Promise<void>
  /** Bind a product-owned, short-lived bearer-token resolver for this process.
   * Call from plugin setup on every boot. The returned function releases only
   * this binding, so a plugin can cleanly shut down without affecting another
   * source. */
  bindTokenSource(id: string, resolve: McpConnectorTokenSource): () => void
  beginDcrAuthorization(input: McpDcrAuthorizationRequest): Promise<{ url: string }>
  status(name: string): Promise<McpConnectorSnapshot | null>
}
