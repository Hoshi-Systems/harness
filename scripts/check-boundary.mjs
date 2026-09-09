import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const failures = []

if ('./hgl' in packageJson.exports) failures.push('package.json must not export ./hgl')

for (const relative of ['src/hgl.ts', 'src/plugins/widgets']) {
  try {
    await access(path.join(root, relative))
    failures.push(`${relative} belongs in a product plugin, not this package`)
  } catch {
    // Its absence is the boundary.
  }
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)))
    else if (entry.isFile() && /\.(?:ts|mts|cts)$/.test(entry.name)) files.push(absolute)
  }
  return files
}

for (const file of await sourceFiles(path.join(root, 'src'))) {
  if (/\bHGL\b/i.test(await readFile(file, 'utf8'))) failures.push(`${path.relative(root, file)} mentions HGL`)
}

for (const relative of ['dist/hgl.js', 'dist/hgl.d.ts', 'dist/plugins/widgets']) {
  try {
    await access(path.join(root, relative))
    failures.push(`${relative} is stale product emit`)
  } catch {
    // Its absence is the boundary.
  }
}

if (failures.length) throw new Error(`Public boundary check failed:\n- ${failures.join('\n- ')}`)
console.log('[check:boundary] no HGL source, export, widget plugin, or stale emit')
