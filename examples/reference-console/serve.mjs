import { createReadStream, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4876)
const TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const assets = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/console.js', 'console.js'],
  ['/styles.css', 'styles.css'],
])

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://console.local').pathname
  const asset = assets.get(path)
  if (!asset) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  const file = join(ROOT, asset)
  if (!existsSync(file)) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Console asset is missing')
    return
  }
  response.writeHead(200, { 'content-type': TYPES[asset.slice(asset.lastIndexOf('.'))], 'cache-control': 'no-store' })
  createReadStream(file).pipe(response)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Harness Reference Console: http://127.0.0.1:${PORT}`)
})
