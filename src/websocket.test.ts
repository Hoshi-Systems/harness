import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineEventHandler } from 'h3'
import { afterAll, expect, it } from 'vitest'
import { createHarness } from './index.js'
import { definePlugin } from './plugins/index.js'
import { stopHarness } from './runtime.js'

/**
 *
 * The daemon has to perform the UPGRADE itself. Routing a websocket handler is
 * not the same thing: an upgrade is a request nothing in the normal pipeline
 * sees, so a harness that only registered the route would accept the HTTP call
 * and never connect anything — which is exactly why the editor bridge, the
 * preview proxy and the voice stream were the last routes Nitro still served.
 *
 * So this connects a REAL client to a REAL daemon over a plugin's own route.
 * Anything less would pass against a harness that cannot open a socket at all.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-ws-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(async () => {
  await stopHarness()
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const echo = definePlugin({
  name: 'ws-echo',
  description: 'A websocket route, for proving the daemon can upgrade one',
  setup(host) {
    host.routes.all(
      '/echo',
      defineEventHandler({
        websocket: {
          message(peer, message) {
            peer.send(`echo:${message.text()}`)
          },
        },
        handler: () => 'this route is for websockets',
      }),
    )
  },
})

it('upgrades a plugin websocket route and carries a message both ways', async () => {
  /**
   *
   * One plugin and nothing else — the thing a plugin author actually wants,
   * and the reason `createHarness` is a real entry point rather than an
   * afterthought of the CLI (docs/decisions/0002-own-harness.md).
   *
   **/
  const harness = createHarness({
    port: 18_431,
    host: '127.0.0.1',
    workspace: home,
    state: home,
    plugins: [],
    extraPlugins: [echo],
  })

  const { url } = await harness.listen()
  try {
    const socket = new WebSocket(`${url.replace('http://', 'ws://')}/echo`)
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the socket never answered')), 5_000)
      socket.addEventListener('open', () => socket.send('hello'))
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('the upgrade was refused'))
      })
    })
    expect(reply).toBe('echo:hello')
    socket.close()
  } finally {
    await harness.close()
  }
}, 20_000)
