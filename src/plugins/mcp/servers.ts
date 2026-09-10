import { closeMCPClients, connectMCPServers, type MCPServerConfig } from '@openharness/core'
import type { ToolSet } from 'ai'
import { hoshiFile, readHoshiJson, writeHoshiJson } from '../../kernel/store.js'
import { authorizationHeader } from './oauth-connect.js'
import { authorizedConnectors, authStatus, forgetAuth, type AuthStatus } from './oauth-store.js'
import { publishMachineEvent } from '../../kernel/events.js'
import { isValidSecretKey, readSecretValue } from '../../kernel/secrets.js'
import type { McpConnectorDeclaration, McpConnectorSnapshot, McpConnectorVaultHeader } from '../../mcp-connectors.js'
import { forgetFlowsFor } from './oauth-flow.js'

/**
 * ── MCP connectors ───────────────────────────────────────────────────────────
 *
 * External tool servers the engine dials out to.
 *
 * The property everything here defends: a connector that is CONFIGURED must be
 * distinguishable from one that is WORKING. When status merely echoes the
 * stored definition, a broken connector has exactly one symptom — an agent
 * quietly missing tools and giving worse answers for reasons nobody can see. No
 * error is logged, no request fails, and the user concludes the model got
 * dumber.
 *
 * So status comes from an actual connection attempt, and every attempt is made
 * SERVER BY SERVER. `connectMCPServers` takes them all at once and one failure
 * would take the batch with it — which would mean a single dead connector
 * costing the machine every tool it has, plus the listing that would have
 * explained why.
 *
 **/

export type ServerStatus = 'connected' | 'unreachable' | 'disabled'

/** A connector as this machine stores it: the library's own definition, plus
 *  whether the person has it switched on.
 *
 *  Off is a state a connector is IN, not a definition that was deleted — the
 *  command, the url and the credentials stay exactly as they were, so switching
 *  it back on is one click rather than setting it up again. The machine had no
 *  notion of this at all while every client offered the toggle. */
export type StoredServer = MCPServerConfig & {
  enabled?: boolean
  /** Credential references only. Resolved immediately before connecting. */
  vaultHeaders?: Record<string, McpConnectorVaultHeader>
}

export interface McpServer {
  name: string
  config: MCPServerConfig
  status: ServerStatus
  /**
   *
   * OAuth authorization, or null for a connector that has none — headers-auth,
   * stdio, and any remote server never connected to an identity provider.
   *
   * A WORD, never a token or any part of one. `needs-auth` is the state that
   * matters: the connector keeps its definition and its place in the list and
   * asks to be re-authorized, rather than disappearing or looking broken.
   *
   **/
  auth: AuthStatus | null
  /** How many tools it contributed, so "connected but empty" is visible. */
  toolCount: number
  /** Their names.
   *
   *  Reported by the connector itself rather than left to be matched out of the
   *  machine-wide tool list: the library namespaces an MCP tool `server_tool`,
   *  with an underscore, and the screen that tried to find them by a `server:`
   *  prefix matched nothing and showed every connector as having no tools at
   *  all. The server knows what it gave us; asking it is the short way. */
  tools: string[]
  /** Why it is unreachable, in the words the server or the socket used. */
  error: string | null
}

const FILE = () => hoshiFile('mcp.json')

/** How long a connection attempt gets. A refused port fails instantly, but a
 *  black-holed host would hang forever and take the listing — and every turn
 *  that needs tools — down with it. */
const CONNECT_TIMEOUT_MS = 5_000

interface McpFile {
  servers?: Record<string, StoredServer>
}

async function readDefinitions(): Promise<Record<string, StoredServer>> {
  const data = await readHoshiJson<McpFile>(FILE())
  return data?.servers ?? {}
}

async function writeDefinitions(servers: Record<string, StoredServer>): Promise<void> {
  await writeHoshiJson(FILE(), { servers })
  invalidate()
  publishMachineEvent('mcp.changed', {})
}

/**
 * ── Live connections ─────────────────────────────────────────────────────────
 *
 * Cached, because connecting on every turn would add a round trip per tool call
 * to every conversation. Invalidated whenever the definitions change, so an
 * edit takes effect on the next turn rather than after a restart.
 *
 **/

interface Live {
  clients: Awaited<ReturnType<typeof connectMCPServers>>['clients']
  tools: ToolSet
  statuses: Map<string, { status: ServerStatus; toolCount: number; tools: string[]; error: string | null }>
}

let live: Promise<Live> | null = null

function invalidate(): void {
  const previous = live
  live = null
  /**
   *
   * Closing is best-effort and deliberately not awaited: a server that has
   * stopped answering must not make removing it hang.
   *
   **/
  void previous?.then(({ clients }) => closeMCPClients(clients)).catch(() => undefined)
}

/** Merge the machine's bearer token into a remote connector's headers. Returns
 *  the config untouched for stdio, and for anything with no authorization. */
async function withAuthorization(name: string, config: MCPServerConfig): Promise<MCPServerConfig> {
  if (config.type === 'stdio') return config
  const stored = config as StoredServer
  const vaultHeaders = await resolveVaultHeaders(stored.vaultHeaders)
  const header = await authorizationHeader(name)
  return { ...config, headers: { ...config.headers, ...vaultHeaders, ...header } }
}

/** Resolve only while connecting. Stored declarations carry vault key NAMES and
 * templates, never a value that a config/status read could reveal. */
async function resolveVaultHeaders(
  bindings: Record<string, McpConnectorVaultHeader> | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    const secret = await readSecretValue(binding.key)
    if (secret !== null) headers[name] = binding.template.replaceAll('{{secret}}', secret)
  }
  return headers
}

async function connectAll(): Promise<Live> {
  const definitions = await readDefinitions()
  const clients: Live['clients'] = []
  const statuses: Live['statuses'] = new Map()
  let tools: ToolSet = {}

  for (const [name, stored] of Object.entries(definitions)) {
    const { enabled, ...config } = stored as StoredServer
    /**
     *
     * A connector switched off is not dialled at all — that is the whole point
     * of the switch. Reported as `disabled` rather than left out of the list:
     * it is still configured, and a connector that vanished from the screen
     * when it was turned off would read as one that had been deleted.
     *
     **/
    if (enabled === false) {
      statuses.set(name, { status: 'disabled', toolCount: 0, tools: [], error: null })
      continue
    }
    try {
      /**
       *
       * An OAuth-authorized connector is dialled with a bearer header the
       * machine holds, refreshed here if it is close to expiring. A connector
       * with no authorization record gets exactly the config it always got —
       * headers-auth and stdio are untouched by any of this.
       *
       **/
      const dialled = await withAuthorization(name, config as MCPServerConfig)
      const connection = await withTimeout(connectMCPServers({ [name]: dialled }), CONNECT_TIMEOUT_MS)
      clients.push(...connection.clients)
      tools = { ...tools, ...connection.tools }
      statuses.set(name, {
        status: 'connected',
        toolCount: Object.keys(connection.tools).length,
        tools: Object.keys(connection.tools),
        error: null,
      })
    } catch (error) {
      /**
       *
       * Swallowed on purpose, and recorded rather than thrown: a connector the
       * user misconfigured is their problem to see and fix, not a reason for
       * the machine to stop answering.
       *
       **/
      statuses.set(name, {
        status: 'unreachable',
        toolCount: 0,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { clients, tools, statuses }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

function ensureConnected(): Promise<Live> {
  live ??= connectAll()
  return live
}

/** Every connector with its LIVE state. */
export async function listServers(): Promise<McpServer[]> {
  const [definitions, connected, authorized] = await Promise.all([
    readDefinitions(),
    ensureConnected(),
    authorizedConnectors(),
  ])
  const auth = new Map(authorized.map((entry) => [entry.name, entry.auth]))
  return Object.entries(definitions).map(([name, config]) => {
    const state = connected.statuses.get(name)
    return {
      name,
      config,
      status: state?.status ?? 'unreachable',
      auth: authStatus(auth.get(name) ?? null),
      toolCount: state?.toolCount ?? 0,
      tools: state?.tools ?? [],
      error: state?.error ?? null,
    }
  })
}

/** The tools every reachable connector contributes, for an agent to use.
 *  Namespaced `server_tool` by the library, so two servers cannot collide. */
export async function mcpTools(): Promise<ToolSet> {
  return (await ensureConnected()).tools
}

/** A projection safe for another plugin to render or return. It intentionally
 * omits the endpoint and header bindings alongside every credential value. */
export async function connectorStatus(name: string): Promise<McpConnectorSnapshot | null> {
  const server = (await listServers()).find((entry) => entry.name === name)
  return server
    ? { name: server.name, status: server.status, auth: server.auth, toolCount: server.toolCount }
    : null
}

export class InvalidServerError extends Error {}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** Validate a definition before it is stored. A connector that cannot possibly
 *  connect is rejected at write time, where the person who typed it is looking,
 *  rather than surfacing later as a mysterious `unreachable`. */
/** A plain `string -> string` map, or not. Used for both `headers` and `env`,
 *  which arrive from a textarea and must not be trusted to be either. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function vaultHeaderBindings(value: unknown): Record<string, McpConnectorVaultHeader> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidServerError('vaultHeaders must be a map of header names to vault bindings.')
  }
  const parsed: Record<string, McpConnectorVaultHeader> = {}
  for (const [header, binding] of Object.entries(value)) {
    if (!header || /[\r\n]/.test(header)) throw new InvalidServerError('A vault header name cannot be empty or contain a line break.')
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
      throw new InvalidServerError(`Vault header ${header} must name a key and template.`)
    }
    const { key, template } = binding as Record<string, unknown>
    if (typeof key !== 'string' || !isValidSecretKey(key)) {
      throw new InvalidServerError(`Vault header ${header} needs a valid uppercase vault key.`)
    }
    if (template !== '{{secret}}' && template !== 'Bearer {{secret}}') {
      throw new InvalidServerError(`Vault header ${header} must use {{secret}} or Bearer {{secret}}.`)
    }
    parsed[header] = { key, template }
  }
  return parsed
}

export function parseRemoteConnector(input: McpConnectorDeclaration): StoredServer {
  const config = parseConfig({ type: input.transport, url: input.url })
  if (config.type === 'stdio') throw new InvalidServerError('A declared connector must use an HTTP or SSE transport.')
  const protocol = new URL(config.url).protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new InvalidServerError('A declared connector needs an http or https endpoint.')
  }
  const vaultHeaders = vaultHeaderBindings(input.vaultHeaders)
  return { ...config, ...(vaultHeaders ? { vaultHeaders } : {}) }
}

export function parseConfig(raw: unknown): MCPServerConfig {
  const value = (raw ?? {}) as Record<string, unknown>
  const type = value.type
  if (type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command) {
      throw new InvalidServerError('A stdio connector needs a command.')
    }
    return {
      type: 'stdio',
      command: value.command,
      ...(Array.isArray(value.args) ? { args: value.args.filter((a): a is string => typeof a === 'string') } : {}),
      /** Same omission as the headers below: a local connector configured with
       *  an API key in its environment was stored without it. */
      ...(isStringRecord(value.env) ? { env: value.env } : {}),
      ...(typeof value.cwd === 'string' && value.cwd ? { cwd: value.cwd } : {}),
    }
  }
  if (type === 'http' || type === 'sse') {
    if (typeof value.url !== 'string') throw new InvalidServerError(`A ${type} connector needs a url.`)
    try {
      new URL(value.url)
    } catch {
      throw new InvalidServerError('That url is not valid.')
    }
    /**
     *
     * HEADERS ARE CARRIED THROUGH, and were not: this returned `{ type, url }`
     * and silently dropped them, so every headers-authenticated connector was
     * stored without its credential and then failed to connect for a reason
     * nothing on screen could explain. Found while adding OAuth, which is a
     * third auth mode beside this one — and a third mode is not much use if the
     * second never worked.
     *
     **/
    return {
      type,
      url: value.url,
      ...(isStringRecord(value.headers) ? { headers: value.headers } : {}),
    }
  }
  throw new InvalidServerError('type must be one of: stdio, http, sse.')
}

export async function addServer(name: string, config: MCPServerConfig): Promise<void> {
  if (!NAME.test(name)) throw new InvalidServerError('A connector name must be letters, digits, dashes or underscores.')
  const servers = await readDefinitions()
  servers[name] = config
  await writeDefinitions(servers)
}

/** Install a remote declaration from a product plugin. This is deliberately
 * separate from the owner-facing add route: product code gets no stdio or
 * literal-header escape hatch. Changing the remote identity makes all prior
 * OAuth state unusable, so it is discarded along with any in-flight flow. */
export async function installRemoteServer(input: McpConnectorDeclaration): Promise<void> {
  if (!NAME.test(input.name)) {
    throw new InvalidServerError('A connector name must be letters, digits, dashes or underscores.')
  }
  const definition = parseRemoteConnector(input)
  const servers = await readDefinitions()
  const previous = servers[input.name]
  const changedEndpoint =
    !previous || previous.type === 'stdio' || previous.type !== definition.type || previous.url !== definition.url
  servers[input.name] = definition
  await writeDefinitions(servers)
  if (changedEndpoint) {
    forgetFlowsFor(input.name)
    await forgetAuth(input.name)
    publishMachineEvent('mcp.changed', { name: input.name, auth: null })
  }
}

/** Merge a change into an existing connector. False when there is nothing by
 *  that name — reported as a 404 rather than quietly creating one, since an
 *  edit that lands as a create is how a typo becomes a second connector nobody
 *  meant to have.
 *
 *  A MERGE, not a replace, because the commonest edit by far is the on/off
 *  switch: `{ enabled: false }` carries no command and no url, and a route that
 *  demanded a whole definition answered "type must be one of: stdio, http, sse"
 *  to somebody who had only flipped a toggle. What the merge produces is
 *  validated, so a partial edit still cannot leave an unusable connector
 *  behind. */
export async function updateServer(name: string, patch: Record<string, unknown>): Promise<boolean> {
  const servers = await readDefinitions()
  const existing = servers[name] as StoredServer | undefined
  if (!existing) return false
  const { enabled, ...rest } = patch as { enabled?: unknown }
  const merged = { ...existing, ...rest } as Record<string, unknown>
  const config = parseConfig(merged) as StoredServer
  if (typeof enabled === 'boolean') config.enabled = enabled
  else if (existing.enabled === false) config.enabled = false
  servers[name] = config
  await writeDefinitions(servers)
  return true
}

/** Dial one connector again, now, and report what came back.
 *
 *  The button behind "why has this connector no tools?". A connector is dialled
 *  once and the result cached for the life of the process, so a server that was
 *  down when the machine started — or one whose token was just fixed — stays
 *  broken on screen with no way to ask again short of restarting the machine.
 *
 *  Every connection is rebuilt, not just this one: they share a single live set,
 *  and rebuilding one in isolation would mean two sets of clients and two
 *  answers to "which tools does this machine have". The answer returned is this
 *  connector's own, which is what the person clicked on. */
export async function reconnectServer(name: string): Promise<McpServer | null> {
  const definitions = await readDefinitions()
  if (!(name in definitions)) return null
  invalidate()
  return (await listServers()).find((server) => server.name === name) ?? null
}

export async function removeServer(name: string): Promise<boolean> {
  const servers = await readDefinitions()
  if (!(name in servers)) return false
  delete servers[name]
  await writeDefinitions(servers)
  return true
}
