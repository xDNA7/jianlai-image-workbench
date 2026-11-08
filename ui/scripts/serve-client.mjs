// Test-only static SPA server. Serve the exported directory, never Vite's shared
// build/client directory, so another build cannot change assets under a test.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { URL } from 'node:url'

const root = resolve(process.argv[2] || '../dist/frontend-e2e')
const port = Number(process.argv[3] || '4173')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
}
createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return }
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    let file = resolve(root, '.' + path)
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return }
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      if (extname(path)) { response.writeHead(404).end(); return }
      file = resolve(root, 'index.html')
    }
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': body.length })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch { response.writeHead(404).end() }
}).listen(port, '127.0.0.1', () => console.log(`Test SPA exported directory ready on port ${port}`))
