import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RouteTable } from '../http/router.js'
import { definePlugin } from './define.js'
import { pluginStatuses, startPlugins, stopPlugins } from './registry.js'

/**
 *
 * Configuration reaches a plugin, and a bad one is a boot-time refusal.
 *
 * The machinery for this existed and was never used: `startPlugins` was called
 * with plugins alone, `hostFor` took a `config` it never read, and `setup` was
 * handed `config as never`. So `Plugin<Config>` typechecked while no plugin had
 * ever received one — which is the shape of a feature nobody can rely on.
 *
 **/

interface Port {
  port: number
}

afterEach(async () => {
  await stopPlugins()
})

describe('plugin configuration', () => {
  it('hands a plugin what its own parser returned', async () => {
    let seen: Port | null = null
    const plugin = definePlugin<Port>({
      name: 'configured',
      description: 'takes a port',
      config: (input) => ({ port: Number((input as Port).port) }),
      setup(_host, config) {
        seen = config
      },
    })

    await startPlugins([plugin], new RouteTable(), { configured: { port: 4200 } })

    expect(seen).toEqual({ port: 4200 })
    expect(pluginStatuses()).toEqual([expect.objectContaining({ name: 'configured', state: 'ready' })])
  })

  it('lets a parser default what was not supplied', async () => {
    let seen: Port | null = null
    const plugin = definePlugin<Port>({
      name: 'defaulted',
      description: 'has a default',
      config: (input) => ({ port: (input as Port | undefined)?.port ?? 4097 }),
      setup(_host, config) {
        seen = config
      },
    })

    await startPlugins([plugin], new RouteTable())

    expect(seen).toEqual({ port: 4097 })
  })

  it('degrades the plugin whose configuration is wrong, naming what was wrong', async () => {
    let ran = false
    const plugin = definePlugin<Port>({
      name: 'misconfigured',
      description: 'refuses a bad port',
      config: (input) => {
        const port = Number((input as Port).port)
        if (!Number.isInteger(port))
          throw new Error(`port must be an integer, got ${JSON.stringify((input as Port).port)}`)
        return { port }
      },
      setup() {
        ran = true
      },
    })

    await startPlugins([plugin], new RouteTable(), { misconfigured: { port: 'not-a-port' } })

    expect(ran).toBe(false)
    expect(pluginStatuses()).toEqual([
      expect.objectContaining({
        name: 'misconfigured',
        state: 'degraded',
        reason: 'configuration: port must be an integer, got "not-a-port"',
      }),
    ])
  })

  it('does not take the rest of the machine down with it', async () => {
    const bad = definePlugin({
      name: 'bad',
      description: 'throws while configuring',
      config: () => {
        throw new Error('nope')
      },
      setup() {},
    })
    let started = false
    const good = definePlugin({
      name: 'good',
      description: 'starts anyway',
      setup() {
        started = true
      },
    })

    await startPlugins([bad, good], new RouteTable())

    expect(started).toBe(true)
    expect(pluginStatuses().map((entry) => [entry.name, entry.state])).toEqual([
      ['bad', 'degraded'],
      ['good', 'ready'],
    ])
  })

  it('hands undefined to a plugin that declares no parser', async () => {
    let seen: unknown = 'untouched'
    const plugin = definePlugin({
      name: 'unconfigured',
      description: 'declares no config',
      setup(_host, config) {
        seen = config
      },
    })

    await startPlugins([plugin], new RouteTable(), { unconfigured: { ignored: true } })

    expect(seen).toBeUndefined()
  })
})
