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

export interface McpConnectorDeclaration {
  name: string
  url: string
  transport: McpConnectorTransport
  /** Header name -> vault binding. Literal credentials are intentionally absent. */
  vaultHeaders?: Record<string, McpConnectorVaultHeader>
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
  beginDcrAuthorization(input: McpDcrAuthorizationRequest): Promise<{ url: string }>
  status(name: string): Promise<McpConnectorSnapshot | null>
}
