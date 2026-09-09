import type { MCPServerConfig } from '@openharness/core'

/** The Connectors marketplace catalog (CYB-97): a curated featured list plus
 *  live search of the official MCP registry (registry.modelcontextprotocol.io),
 *  both mapped to items the client installs through the existing POST /mcp —
 *  a ready config scaffold plus the credential fields to collect first.
 *
 *  Only distributions the machine can actually run survive the mapping: remote
 *  HTTP endpoints and npm packages (the image ships node/npx — no uv, no
 *  docker), so every card in the marketplace is genuinely installable. */

/** One input a marketplace item needs before install — an environment variable
 *  for npm servers, a header for remote ones. */
export type MarketplaceField = {
  /** Env var name (npm) or header name (remote). */
  key: string
  description?: string
  required: boolean
  secret: boolean
  /** Header value template (`Bearer {token}`) — the client substitutes the
   *  `{placeholder}` with the user's input; absent means the input is the
   *  whole value. */
  valueTemplate?: string
}

export type MarketplaceItem = {
  /** Registry server name (reverse-DNS) — unique within the catalog. */
  id: string
  /** Suggested connector name — a valid `config.mcp` key, user-editable. */
  slug: string
  title: string
  description: string
  /** Website or repository, when the registry knows one. */
  homepage?: string
  /** Brand icon URL from the registry entry, when it ships one. */
  icon?: string
  /** Card subtitle: the npm package or endpoint URL the item installs. */
  detail: string
  /** How it runs: an npm package on the machine, or a hosted HTTP endpoint. */
  runtime: 'npm' | 'remote'
  config: MCPServerConfig
  fields: MarketplaceField[]
}

/**
 *
 * ── Registry wire shapes (server.schema.json, pared to what the mapping reads) ─
 *
 **/

type RegistryKeyValue = {
  name?: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  value?: string
}

type RegistryArgument = {
  type?: string
  name?: string
  value?: string
  isRequired?: boolean
}

type RegistryPackage = {
  registryType?: string
  identifier?: string
  version?: string
  environmentVariables?: RegistryKeyValue[]
  packageArguments?: RegistryArgument[]
}

type RegistryRemote = {
  type?: string
  url?: string
  headers?: RegistryKeyValue[]
}

type RegistryServer = {
  name?: string
  title?: string
  description?: string
  websiteUrl?: string
  repository?: { url?: string }
  icons?: Array<{ src?: string; sizes?: string[] }>
  remotes?: RegistryRemote[]
  packages?: RegistryPackage[]
}

/**
 * ── Mapping ──────────────────────────────────────────────────────────────────
 *
 **/

const PLACEHOLDER = /\{[^}]*\}/

/** Split a key/value list into user-facing fields and constants baked straight
 *  into the config: a concrete literal `value` installs as-is; a `{placeholder}`
 *  template or no value at all becomes an input. */
function splitFields(entries: RegistryKeyValue[] | undefined, baked: Record<string, string>): MarketplaceField[] {
  const fields: MarketplaceField[] = []
  for (const entry of entries ?? []) {
    if (!entry?.name) continue
    if (entry.value && !PLACEHOLDER.test(entry.value)) {
      baked[entry.name] = entry.value
      continue
    }
    fields.push({
      key: entry.name,
      description: entry.description,
      required: entry.isRequired === true,
      secret: entry.isSecret === true,
      ...(entry.value ? { valueTemplate: entry.value } : {}),
    })
  }
  return fields
}

/** Suggested connector name from a registry name: the part after `/`, minus
 *  `mcp`/`server` filler; a bare `vendor/mcp` falls back to the vendor's own
 *  leaf (`com.notion` → `notion`). Always a valid `config.mcp` key. */
function slugFrom(registryName: string): string {
  const [scope = '', tail = ''] = registryName.split('/', 2)
  const tokens = tail
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== 'mcp' && token !== 'server')
  const base = tokens.join('-') || (scope.toLowerCase().split('.').filter(Boolean).pop() ?? '')
  const slug = base
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  return slug || 'connector'
}

function titleFrom(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** `npx` invocation for a registry npm package. Only arguments with a concrete
 *  literal value survive; a required argument that needs user input means the
 *  package can't be installed headlessly — the caller skips it. */
function npmCommand(pkg: RegistryPackage): string[] | null {
  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier!
  const command = ['npx', '-y', spec]
  for (const arg of pkg.packageArguments ?? []) {
    const concrete = typeof arg?.value === 'string' && !PLACEHOLDER.test(arg.value) ? arg.value : null
    if (arg?.type === 'named' && arg.name) {
      if (concrete) command.push(arg.name, concrete)
      else if (arg.isRequired) return null
    } else if (concrete) {
      command.push(concrete)
    } else if (arg?.isRequired) {
      return null
    }
  }
  return command
}

/** Largest https icon the entry ships (registry `icons`, sizes like "48x48"). */
function iconFrom(icons: RegistryServer['icons']): string | undefined {
  let best: { src: string; size: number } | undefined
  for (const icon of icons ?? []) {
    if (typeof icon?.src !== 'string' || !icon.src.startsWith('https://')) continue
    const size = Number.parseInt(icon.sizes?.[0] ?? '', 10) || 0
    if (!best || size > best.size) best = { src: icon.src, size }
  }
  return best?.src
}

/** Map one registry server to an installable marketplace item, or null when it
 *  ships nothing the machine can run. Remotes win over packages (zero install,
 *  streamable-http preferred); npm is the local fallback. */
function marketplaceItemFrom(server: RegistryServer): MarketplaceItem | null {
  if (!server.name) return null
  const slug = slugFrom(server.name)
  const base = {
    id: server.name,
    slug,
    title: server.title || titleFrom(slug),
    description: server.description ?? '',
    homepage: server.websiteUrl ?? server.repository?.url,
    icon: iconFrom(server.icons),
  }

  const remotes = (server.remotes ?? []).filter((r) => typeof r?.url === 'string' && /^https?:\/\//.test(r.url))
  const remote = remotes.find((r) => r.type === 'streamable-http') ?? remotes[0]
  if (remote) {
    const headers: Record<string, string> = {}
    const fields = splitFields(remote.headers, headers)
    return {
      ...base,
      detail: remote.url!,
      runtime: 'remote',
      config: {
        /**
         *
         * The registry speaks the MCP spec's own vocabulary; the engine speaks
         * the library's. "remote" is an HTTP transport, "local" is stdio.
         *
         **/
        type: 'http',
        url: remote.url!,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      fields,
    }
  }

  for (const pkg of server.packages ?? []) {
    if (pkg?.registryType !== 'npm' || !pkg.identifier) continue
    const command = npmCommand(pkg)
    if (!command) continue
    const environment: Record<string, string> = {}
    const fields = splitFields(pkg.environmentVariables, environment)
    return {
      ...base,
      detail: pkg.identifier,
      runtime: 'npm',
      config: {
        type: 'stdio',
        command: command[0]!,
        ...(command.length > 1 ? { args: command.slice(1) } : {}),
        ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
      },
      fields,
    }
  }

  return null
}

/**
 * ── Featured catalog ─────────────────────────────────────────────────────────
 *
 **/

/** The hand-curated storefront the marketplace opens on. Static on purpose —
 *  it renders instantly and survives registry slowness. Every entry was
 *  verified against the live registry (2026-07-13): official vendors only,
 *  remote OAuth endpoints (OpenCode runs the OAuth dance on first 401) or npm
 *  packages with a token env var. */
export const FEATURED_INTEGRATIONS: MarketplaceItem[] = [
  {
    id: 'io.github.github/github-mcp-server',
    slug: 'github',
    title: 'GitHub',
    description: 'Repos, issues, pull requests, and workflows — GitHub’s official MCP server.',
    homepage: 'https://github.com/github/github-mcp-server',
    detail: 'https://api.githubcopilot.com/mcp/',
    runtime: 'remote',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    fields: [
      {
        key: 'Authorization',
        description: 'GitHub personal access token',
        required: true,
        secret: true,
        valueTemplate: 'Bearer {token}',
      },
    ],
  },
  {
    id: 'app.linear/linear',
    slug: 'linear',
    title: 'Linear',
    description: 'Issues, projects, and cycles in your Linear workspace.',
    homepage: 'https://linear.app',
    detail: 'https://mcp.linear.app/mcp',
    runtime: 'remote',
    config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    fields: [],
  },
  {
    id: 'com.notion/mcp',
    slug: 'notion',
    title: 'Notion',
    description: 'Pages, databases, and search across your Notion workspace.',
    homepage: 'https://notion.com',
    detail: 'https://mcp.notion.com/mcp',
    runtime: 'remote',
    config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    fields: [],
  },
  {
    id: 'com.figma.mcp/mcp',
    slug: 'figma',
    title: 'Figma',
    description: 'Design context from your Figma files, straight to the agent.',
    homepage: 'https://figma.com',
    detail: 'https://mcp.figma.com/mcp',
    runtime: 'remote',
    config: { type: 'http', url: 'https://mcp.figma.com/mcp' },
    fields: [],
  },
  {
    id: 'com.stripe/mcp',
    slug: 'stripe',
    title: 'Stripe',
    description: 'Customers, products, and payments from your Stripe account.',
    homepage: 'https://github.com/stripe/agent-toolkit',
    detail: 'https://mcp.stripe.com',
    runtime: 'remote',
    config: { type: 'http', url: 'https://mcp.stripe.com' },
    fields: [],
  },
  {
    id: 'io.github.getsentry/sentry-mcp',
    slug: 'sentry',
    title: 'Sentry',
    description: 'Error monitoring and issue debugging from your Sentry projects.',
    homepage: 'https://github.com/getsentry/sentry-mcp',
    detail: '@sentry/mcp-server',
    runtime: 'npm',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server'] },
    fields: [
      { key: 'SENTRY_ACCESS_TOKEN', description: 'Sentry user authentication token', required: true, secret: true },
    ],
  },
  {
    id: 'com.supabase/mcp',
    slug: 'supabase',
    title: 'Supabase',
    description: 'Query databases and manage projects on the Supabase platform.',
    homepage: 'https://supabase.com/mcp',
    detail: '@supabase/mcp-server-supabase',
    runtime: 'npm',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase'] },
    fields: [
      { key: 'SUPABASE_ACCESS_TOKEN', description: 'Supabase personal access token', required: true, secret: true },
    ],
  },
  {
    id: 'io.github.upstash/context7',
    slug: 'context7',
    title: 'Context7',
    description: 'Up-to-date code documentation for any library, in any prompt.',
    homepage: 'https://github.com/upstash/context7',
    detail: '@upstash/context7-mcp',
    runtime: 'npm',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    fields: [
      {
        key: 'CONTEXT7_API_KEY',
        description: 'API key — optional, for higher rate limits',
        required: false,
        secret: true,
      },
    ],
  },
  {
    id: 'io.github.firecrawl/firecrawl-mcp-server',
    slug: 'firecrawl',
    title: 'Firecrawl',
    description: 'Search, scrape, and extract structured data from the web.',
    homepage: 'https://github.com/firecrawl/firecrawl-mcp-server',
    detail: 'firecrawl-mcp',
    runtime: 'npm',
    config: { type: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'] },
    fields: [{ key: 'FIRECRAWL_API_KEY', description: 'Your Firecrawl API key', required: true, secret: true }],
  },
]

/**
 * ── Search ───────────────────────────────────────────────────────────────────
 *
 **/

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'
/** The registry's search regularly takes 25–35s (measured live) — the timeout
 *  has to clear that, and the cache spares repeat queries from paying it. */
const REGISTRY_TIMEOUT_MS = 45_000
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 50

type SearchPage = { items: MarketplaceItem[]; nextCursor: string | null }

const searchCache = new Map<string, { at: number; page: SearchPage }>()

/** Live search of the official MCP registry, mapped and filtered to what this
 *  machine can install. */
export async function searchRegistry(q: string, cursor?: string): Promise<SearchPage> {
  const cacheKey = `${q}\0${cursor ?? ''}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.page

  const url = new URL(REGISTRY_URL)
  url.searchParams.set('search', q)
  url.searchParams.set('version', 'latest')
  url.searchParams.set('limit', '30')
  if (cursor) url.searchParams.set('cursor', cursor)

  const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`MCP registry answered ${res.status}`)
  const body = (await res.json()) as {
    servers?: Array<{ server?: RegistryServer }>
    metadata?: { nextCursor?: string }
  }

  const items: MarketplaceItem[] = []
  for (const entry of body.servers ?? []) {
    const item = entry?.server ? marketplaceItemFrom(entry.server) : null
    if (item && !items.some((existing) => existing.id === item.id)) items.push(item)
  }
  const page: SearchPage = { items, nextCursor: body.metadata?.nextCursor ?? null }

  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value
    if (oldest !== undefined) searchCache.delete(oldest)
  }
  searchCache.set(cacheKey, { at: Date.now(), page })
  return page
}
