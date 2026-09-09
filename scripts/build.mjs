import { rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist')

/** `tsc` does not remove emit for source files that no longer exist. A package
 * build must be a fresh artifact: otherwise a removed private module can still
 * be shipped from a previous build. */
await rm(output, { recursive: true, force: true })

const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
const [code, signal] = await new Promise((resolve) => child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])))
if (code !== 0) throw new Error(`TypeScript build failed${signal ? ` (${signal})` : ''}`)
