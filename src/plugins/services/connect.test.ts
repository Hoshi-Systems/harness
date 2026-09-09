import type { MachineEvent } from '../../wire/index.js'
import { describe, expect, it, vi } from 'vitest'

import type { PluginHost } from '../define.js'

// The connect-time replay is the whole point of this test: a client that
// reconnects or switches machines rehydrates its services mirror only if this
// plugin re-pushes its snapshot on connect. Ports and processes already did;
// `services.changed` was the omission. Mock the three data sources so the test
// asserts the WIRE (which frames the plugin emits on connect), not the OS.
vi.mock('./listening-ports.js', async (orig) => ({
  ...(await orig<typeof import('./listening-ports.js')>()),
  listListeningPorts: vi.fn(async () => [3000]),
}))
vi.mock('./processes.js', async (orig) => ({
  ...(await orig<typeof import('./processes.js')>()),
  listProcesses: vi.fn(async () => []),
}))
vi.mock('./services.js', async (orig) => ({
  ...(await orig<typeof import('./services.js')>()),
  servicesSnapshot: vi.fn(async () => ({ services: [{ id: 's1' }], unmanaged: [] })),
}))

const servicesPlugin = (await import('./index.js')).default

type Replay = (push: (event: MachineEvent) => void) => void | Promise<void>

function fakeHost(): { host: PluginHost; getReplay: () => Replay | null } {
  let replay: Replay | null = null
  const host = {
    tools: { add() {} },
    routes: { all() {}, get() {}, post() {}, patch() {}, delete() {} },
    events: {
      publish() {},
      onConnect(cb: Replay) {
        replay = cb
      },
    },
    jobs: { every() {}, once() {} },
    log: { info() {}, error() {} },
    unattended: {},
    platform: () => null,
    provide() {},
  } as unknown as PluginHost
  return { host, getReplay: () => replay }
}

describe('services plugin connect-time replay', () => {
  it('pushes ports, processes AND services snapshots on connect', async () => {
    const { host, getReplay } = fakeHost()
    await servicesPlugin.setup(host, {})

    const replay = getReplay()
    expect(replay).toBeTypeOf('function')

    const frames: MachineEvent[] = []
    await replay!((event) => frames.push(event))

    const types = frames.map((frame) => frame.type)
    expect(types).toContain('ports.changed')
    expect(types).toContain('processes.changed')
    expect(types).toContain('services.changed')

    const services = frames.find((frame) => frame.type === 'services.changed')
    expect(services?.properties).toEqual({ services: [{ id: 's1' }], unmanaged: [] })
  })
})
