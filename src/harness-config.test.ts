import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHarness } from './index.js'
import { hoshiFile, workspaceRoot } from './kernel/index.js'
import { definePlugin } from './plugins/index.js'

const scratch = mkdtempSync(path.join(tmpdir(), 'harness-config-'))
const workspace = path.join(scratch, 'workspace')
const state = path.join(scratch, 'state')
const running: ReturnType<typeof createHarness>[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((harness) => harness.close()))
  rmSync(scratch, { recursive: true, force: true })
})

it('applies workspace and state to the runtime, not only its returned config', async () => {
  let observed: { workspace: string; stateFile: string } | null = null
  const probe = definePlugin({
    name: 'runtime-path-probe',
    description: 'Records the runtime paths selected by its host',
    setup() {
      observed = { workspace: workspaceRoot(), stateFile: hoshiFile('probe.json') }
    },
  })
  const harness = createHarness({ host: '127.0.0.1', port: 0, workspace, state, plugins: [], extraPlugins: [probe] })
  running.push(harness)

  await harness.listen()

  expect(observed).toEqual({ workspace, stateFile: path.join(state, 'probe.json') })
})

it('refuses a second live Harness instead of mixing its global runtime state', async () => {
  const first = createHarness({ host: '127.0.0.1', port: 0, workspace, state, plugins: [] })
  const second = createHarness({ host: '127.0.0.1', port: 0, workspace, state, plugins: [] })
  running.push(first, second)

  await first.listen()
  await expect(second.listen()).rejects.toThrow(/already running in this Node process/)
})
