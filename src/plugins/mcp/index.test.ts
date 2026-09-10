import { describe, expect, it, vi } from 'vitest'
import mcp from './index.js'
import type { KernelPorts } from '../../kernel/host-ports.js'
import type { PluginHost } from '../define.js'

describe('the public MCP connector port', () => {
  it('is provided by the MCP plugin without exposing its routes or storage', () => {
    let provided: KernelPorts | undefined
    const routes = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), all: vi.fn() }
    const host: PluginHost = {
      tools: { add: vi.fn() },
      routes,
      events: { publish: vi.fn(), onConnect: vi.fn() },
      jobs: { every: vi.fn(), once: vi.fn() },
      log: { info: vi.fn(), error: vi.fn() },
      unattended: {},
      platform: () => null,
      ports: {},
      provide: (extension) => {
        provided = typeof extension === 'function' ? extension({}) : extension
      },
    }

    mcp.setup(host, undefined)

    expect(provided?.mcpConnectors).toEqual({
      install: expect.any(Function),
      bindTokenSource: expect.any(Function),
      beginDcrAuthorization: expect.any(Function),
      status: expect.any(Function),
    })
    expect(routes.get).toHaveBeenCalledWith('/mcp', expect.any(Function))
    expect(routes.post).toHaveBeenCalledWith('/mcp/:name/oauth', expect.any(Function))
    expect(routes.get).not.toHaveBeenCalledWith('/mcp/registry', expect.any(Function))
  })
})
