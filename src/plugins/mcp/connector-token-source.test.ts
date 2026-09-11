import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(),
}))

vi.mock('@openharness/core', () => ({
  closeMCPClients: mocks.close,
  connectMCPServers: mocks.connect,
}))

import { configureStateRoot, resetStateRoot } from '../../kernel/store.js'
import { setSecret } from '../../kernel/secrets.js'
import { installRemoteServer, listServers, mcpTools } from './servers.js'
import { bindTokenSource, clearTokenSources } from './token-sources.js'

describe('a provider-brokered connector', () => {
  let state = ''

  beforeEach(async () => {
    state = await mkdtemp(path.join(tmpdir(), 'hoshi-mcp-token-source-'))
    configureStateRoot(state)
    clearTokenSources()
    mocks.connect.mockReset()
    mocks.close.mockReset()
    mocks.connect.mockResolvedValue({ clients: [], tools: {} })
  })

  afterEach(async () => {
    clearTokenSources()
    resetStateRoot()
    await rm(state, { recursive: true, force: true })
  })

  it('dials with a brokered bearer token while persisting only the source id and scopes', async () => {
    await installRemoteServer({
      name: 'google-drive',
      transport: 'http',
      url: 'https://mcp.example.test/',
      tokenSource: { id: 'platform.google', scopes: ['drive.readonly'] },
    })
    bindTokenSource('platform.google', async () => ({ state: 'available', accessToken: 'ephemeral-access-token' }))

    await mcpTools()

    expect(mocks.connect).toHaveBeenCalledWith({
      'google-drive': {
        type: 'http',
        url: 'https://mcp.example.test/',
        headers: { Authorization: 'Bearer ephemeral-access-token' },
      },
    })
    const persisted = await readFile(path.join(state, 'mcp.json'), 'utf8')
    expect(persisted).toContain('platform.google')
    expect(persisted).toContain('drive.readonly')
    expect(persisted).not.toContain('ephemeral-access-token')
    expect(persisted).not.toMatch(/refresh|client.secret/i)
  })

  it('keeps the existing vault-header path when no runtime source is declared', async () => {
    await installRemoteServer({
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.test/',
      vaultHeaders: { Authorization: { key: 'GITHUB_TOKEN', template: 'Bearer {{secret}}' } },
    })
    await setSecret('GITHUB_TOKEN', 'vault-token')

    await mcpTools()

    expect(mocks.connect).toHaveBeenCalledWith({
      github: {
        type: 'http',
        url: 'https://mcp.example.test/',
        headers: { Authorization: 'Bearer vault-token' },
      },
    })
  })

  it('does not dial without a source and exposes a safe missing-source status', async () => {
    await installRemoteServer({
      name: 'missing-source',
      transport: 'http',
      url: 'https://mcp.example.test/',
      tokenSource: { id: 'platform.missing' },
    })

    await expect(listServers()).resolves.toMatchObject([
      {
        name: 'missing-source',
        status: 'unreachable',
        auth: 'needs-auth',
        error: 'The required connector token source is not available.',
      },
    ])
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('reports an expired brokered authorization without forwarding the broker response', async () => {
    await installRemoteServer({
      name: 'expired-source',
      transport: 'http',
      url: 'https://mcp.example.test/',
      tokenSource: { id: 'platform.expired' },
    })
    bindTokenSource('platform.expired', async () => ({ state: 'expired' }))

    await expect(listServers()).resolves.toMatchObject([
      {
        name: 'expired-source',
        status: 'unreachable',
        auth: 'expired',
        error: 'The connector authorization has expired.',
      },
    ])
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
