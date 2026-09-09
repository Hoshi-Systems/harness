import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { RouteTable } from '../http/router.js'
import { configureKernel } from './host-ports.js'
import { capabilityPassport } from './capabilities.js'
import { definePlugin } from '../plugins/define.js'
import { startPlugins, stopPlugins } from '../plugins/registry.js'

beforeEach(async () => {
  await stopPlugins()
  configureKernel({})
})

afterEach(stopPlugins)

describe('Capability Passport', () => {
  it('projects a declared plugin’s live routes, tools, requirements, and state', async () => {
    const plugin = definePlugin({
      name: 'example',
      description: 'An example capability',
      capability: {
        id: 'example.inspect',
        title: 'Example inspection',
        description: 'Inspects an example.',
      },
      uses: ['platform'],
      system: [{ id: 'exampled', reason: 'Runs the example inspection.', verify: 'true' }],
      setup(host) {
        host.routes.get('/example', () => ({ ok: true }))
        host.tools.add(() => ({}), () => ['example_inspect'])
      },
    })
    const table = new RouteTable()

    await startPlugins([plugin], table)

    expect(capabilityPassport(table.list())).toEqual({
      schemaVersion: 1,
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          id: 'example.inspect',
          owner: { kind: 'plugin', name: 'example' },
          state: 'ready',
          reason: null,
          requires: {
            system: [{ id: 'exampled', reason: 'Runs the example inspection.' }],
            ports: ['platform'],
          },
          surfaces: {
            tools: ['example_inspect'],
            routes: [{ method: 'GET', path: '/example' }],
          },
        }),
      ]),
    })
  })

  it('does not invent an identity for a pre-passport plugin', async () => {
    const legacy = definePlugin({
      name: 'legacy',
      description: 'Uses the pre-passport plugin contract',
      setup() {},
    })
    const table = new RouteTable()

    await startPlugins([legacy], table)

    expect(capabilityPassport(table.list()).capabilities.map((capability) => capability.id)).toEqual(['harness.kernel'])
  })

  it('rejects a capability outside its plugin namespace before startup', async () => {
    const plugin = definePlugin({
      name: 'example',
      description: 'An example capability',
      capability: { id: 'other.inspect', title: 'Inspection', description: 'Inspects.' },
      setup() {},
    })

    await expect(startPlugins([plugin], new RouteTable())).rejects.toThrow('must start with "example."')
  })
})
