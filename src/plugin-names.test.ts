import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createHarness } from './index.js'
import { definePlugin } from './plugins/index.js'
import { stopHarness } from './runtime.js'

/**
 *
 * A name names one plugin. Two under the same name would share an event
 * prefix and one status line, and the second would register its routes over
 * the first's — which the route table refuses, but only for the routes they
 * happen to share. Loading the same plugin package twice is an operator's
 * mistake, and the boot says so instead of coming up with half of one.
 *
 **/

const home = mkdtempSync(path.join(tmpdir(), 'harness-names-'))
const originalHome = process.env.HOME
process.env.HOME = home

afterAll(async () => {
  await stopHarness()
  process.env.HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const twin = () => definePlugin({ name: 'twin', description: 'The same plugin, loaded twice', setup() {} })

it('refuses to boot with two plugins under one name', async () => {
  const harness = createHarness({
    port: 18_437,
    host: '127.0.0.1',
    workspace: home,
    state: home,
    plugins: [],
    extraPlugins: [twin(), twin()],
  })
  await expect(harness.listen()).rejects.toThrow(/Two plugins are named "twin"/)
})
