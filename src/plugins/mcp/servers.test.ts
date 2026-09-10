import { describe, expect, it } from 'vitest'
import { InvalidServerError, parseConfig, parseRemoteConnector } from './servers.js'

/**
 * ── What a connector definition may be ───────────────────────────────────────
 *
 * `parseConfig` sits between something a person typed and a subprocess this
 * machine spawns, or a URL it will hand credentials to. It is the only place
 * that says no, and it has to say no where the person is looking — a definition
 * that cannot possibly connect must be refused at write time rather than
 * surfacing later as a mysterious `unreachable`.
 *
 * The `mcp` plugin had no tests at all (docs/STRUCTURE_REVIEW.md H-06), which
 * for the one function here that is pure and load-bearing is the wrong way
 * round.
 *
 **/

describe('parseConfig', () => {
  it('accepts a stdio connector and keeps its command', () => {
    expect(parseConfig({ type: 'stdio', command: 'npx' })).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('keeps only the args that are strings, so a malformed array cannot reach execFile', () => {
    expect(parseConfig({ type: 'stdio', command: 'npx', args: ['-y', 42, null, 'pkg'] })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
    })
  })

  it('omits args entirely when none were given, rather than inventing an empty list', () => {
    expect(parseConfig({ type: 'stdio', command: 'npx' })).not.toHaveProperty('args')
  })

  it('refuses a stdio connector with nothing to run', () => {
    for (const bad of [{ type: 'stdio' }, { type: 'stdio', command: '' }, { type: 'stdio', command: 7 }]) {
      expect(() => parseConfig(bad)).toThrow(InvalidServerError)
    }
  })

  it('accepts http and sse, and keeps the type it was given', () => {
    expect(parseConfig({ type: 'http', url: 'https://example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    })
    expect(parseConfig({ type: 'sse', url: 'https://example.com/sse' }).type).toBe('sse')
  })

  it('refuses a url that is not one, which is the case a typo produces', () => {
    expect(() => parseConfig({ type: 'http', url: 'example.com' })).toThrow(InvalidServerError)
    expect(() => parseConfig({ type: 'http' })).toThrow(InvalidServerError)
  })

  it('refuses a type it does not serve, and says which ones it does', () => {
    expect(() => parseConfig({ type: 'ws', url: 'wss://example.com' })).toThrow(/stdio, http, sse/)
    expect(() => parseConfig({})).toThrow(InvalidServerError)
  })

  it('treats nothing at all as a definition with no type, not as a crash', () => {
    expect(() => parseConfig(null)).toThrow(InvalidServerError)
    expect(() => parseConfig(undefined)).toThrow(InvalidServerError)
  })
})

describe('what a connector definition must carry', () => {
  /**
   *
   * Both of these were dropped, silently, and both were found while adding a
   * THIRD auth mode — which is not much use if the second never worked. A
   * connector stored without its credential connects, fails, and shows an error
   * that describes the symptom rather than the cause.
   *
   **/
  it('keeps the headers a remote connector authenticates with', () => {
    const config = parseConfig({ type: 'http', url: 'https://mcp.test/x', headers: { Authorization: 'Bearer k' } })
    expect(config).toEqual({ type: 'http', url: 'https://mcp.test/x', headers: { Authorization: 'Bearer k' } })
  })

  it('keeps the environment a local connector needs', () => {
    const config = parseConfig({ type: 'stdio', command: 'run', args: ['x'], env: { TOKEN: 'k' } })
    expect(config).toEqual({ type: 'stdio', command: 'run', args: ['x'], env: { TOKEN: 'k' } })
  })

  it('drops headers that are not a plain string map rather than storing nonsense', () => {
    expect(parseConfig({ type: 'http', url: 'https://mcp.test/x', headers: ['a'] })).toEqual({
      type: 'http',
      url: 'https://mcp.test/x',
    })
    expect(parseConfig({ type: 'http', url: 'https://mcp.test/x', headers: { a: 1 } })).toEqual({
      type: 'http',
      url: 'https://mcp.test/x',
    })
  })
})

describe('the public declared-connector boundary', () => {
  it('accepts only remote transports and stores a vault binding rather than a credential', () => {
    expect(
      parseRemoteConnector({
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        vaultHeaders: { Authorization: { key: 'HOSHI_GITHUB_TOKEN', template: 'Bearer {{secret}}' } },
      }),
    ).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      vaultHeaders: { Authorization: { key: 'HOSHI_GITHUB_TOKEN', template: 'Bearer {{secret}}' } },
    })
  })

  it('refuses a local transport, non-http endpoint, and an unsafe vault binding', () => {
    expect(() =>
      parseRemoteConnector({ name: 'local', transport: 'stdio' as never, url: 'https://example.test/mcp' }),
    ).toThrow(InvalidServerError)
    expect(() => parseRemoteConnector({ name: 'ftp', transport: 'http', url: 'ftp://example.test/mcp' })).toThrow(
      InvalidServerError,
    )
    expect(() =>
      parseRemoteConnector({
        name: 'unsafe',
        transport: 'sse',
        url: 'https://example.test/sse',
        vaultHeaders: { Authorization: { key: 'token', template: 'Bearer {{secret}}' } },
      }),
    ).toThrow(InvalidServerError)
    expect(() =>
      parseRemoteConnector({
        name: 'unsafe-template',
        transport: 'sse',
        url: 'https://example.test/sse',
        vaultHeaders: { Authorization: { key: 'TOKEN', template: 'Bearer token' } },
      }),
    ).toThrow(InvalidServerError)
    expect(() =>
      parseRemoteConnector({
        name: 'unsafe-template',
        transport: 'sse',
        url: 'https://example.test/sse',
        vaultHeaders: { Authorization: { key: 'TOKEN', template: 'Token {{secret}}' } },
      }),
    ).toThrow(InvalidServerError)
  })
})
