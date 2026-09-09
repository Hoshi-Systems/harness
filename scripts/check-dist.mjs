import { createServer } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not reserve a local port')
  server.close()
  return address.port
}

const port = await freePort()
const state = await mkdtemp(path.join(tmpdir(), 'hoshi-harness-state-'))
const workspace = await mkdtemp(path.join(tmpdir(), 'hoshi-harness-workspace-'))
const child = spawn(process.execPath, ['dist/daemon/cli.js', '--host', '127.0.0.1', '--port', String(port), '--state', state, '--workspace', workspace], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
})
child.stderr.on('data', (chunk) => {
  output += chunk
})

try {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => Promise.reject(new Error(`daemon exited early (${code}): ${output}`))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`daemon did not start: ${output}`)), 10_000)),
  ])
  const response = await fetch(`http://127.0.0.1:${port}/health`)
  if (!response.ok) throw new Error(`health check returned ${response.status}`)
  console.log('[check:dist] daemon started and served /health')
} finally {
  child.kill('SIGTERM')
  await once(child, 'exit').catch(() => undefined)
  await Promise.all([rm(state, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })])
}
