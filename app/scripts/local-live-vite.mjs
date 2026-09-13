// Native loopback/HMR shell. No upstream client and no credential loading.
import { createServer } from 'node:http'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { permittedBrowserRequest } from './local-live-boundary.mjs'
import { within } from './local-live-credentials.mjs'

const APP = resolve(import.meta.dirname, '..')
const ROOTS = [APP, resolve(APP, '../web'), resolve(APP, '../api-contracts')]
/** Vite's public middleware skips fs.allow. Resolve the actual file on every
 * request, including links created after startup, before ANY Vite middleware.
 * No inverse public/@fs alias can make a private external file serveable. */
export function permittedFileRequest(url) {
  try {
    const pathname = decodeURIComponent(url.split('?')[0])
    if (pathname.includes('\\') || pathname.includes('\0')) return false
    const paths = pathname.startsWith('/@fs/') ? [pathname.slice(5)] : [resolve(APP, `.${pathname}`), resolve(APP, 'public', `.${pathname}`)]
    for (const path of paths) {
      if (!existsSync(path)) continue
      const actual = realpathSync.native(path)
      if (!ROOTS.some((root) => within(actual, realpathSync.native(root)))) return false
      const entry = lstatSync(actual)
      if (entry.isFile() && entry.nlink !== 1) return false
      // Apply the private-file exclusion to the destination, not just the
      // visible alias name. public/ may otherwise bypass Vite's fs.deny.
      const normalized = actual.replaceAll('\\', '/').toLowerCase()
      if (/(?:^|\/)(?:\.git|\.env[^/]*|scripts|tests|local-live)(?:\/|$)|\/(?:access\.json)$|\.(?:crt|pem|key)$/.test(normalized)) return false
    }
    return true
  } catch { return false }
}
export async function createGuardedVite({ port, handleRead }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof handleRead !== 'function') throw new Error('An explicit port and reviewed read handler are required.')
  if (Object.keys(process.env).some((name) => name.startsWith('VITE_'))) throw new Error('Remove VITE_ environment variables before starting local development.')
  // This dispatcher never listens. The real listener admits a WebSocket
  // before forwarding the upgrade to Vite; destroying a socket in a prepended
  // listener would still invoke Vite's other EventEmitter listeners.
  const hmr = createServer()
  const http = createServer({ maxHeaderSize: 16384, requestTimeout: 20000, headersTimeout: 10000, keepAliveTimeout: 5000 })
  http.maxConnections = 32
  http.maxRequestsPerSocket = 100
  const sockets = new Set()
  http.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const vite = await createViteServer({
    root: APP, configFile: resolve(APP, 'vite.config.ts'), mode: 'local-live', envFile: false,
    logLevel: 'silent', clearScreen: false,
    server: { middlewareMode: true, host: '127.0.0.1', port, strictPort: true, cors: false,
      hmr: { server: hmr, host: '127.0.0.1', clientPort: port, protocol: 'ws' },
      fs: { strict: true, allow: [APP, resolve(APP, '../web'), resolve(APP, '../api-contracts')],
        deny: ['**/.git/**', '**/.env*', '**/*.{crt,pem,key}', '**/access.json', '**/local-live/**', '**/scripts/**', '**/tests/**'] },
    },
  })
  http.on('upgrade', (req, socket, head) => {
    if (!permittedBrowserRequest(req, port, true)) { socket.destroy(); return }
    hmr.emit('upgrade', req, socket, head)
  })
  http.on('request', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!permittedBrowserRequest(req, port)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"local_browser_required"}'); return }
    if (req.url.startsWith('/api')) {
      try { await handleRead(req, res) }
      catch { if (!res.destroyed && !res.writableEnded) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"upstream_unavailable"}') } }
      return
    }
    if (!permittedFileRequest(req.url)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"private_file_refused"}'); return }
    // Image-only policy leaves Vite scripts/HMR unchanged. An approved CDN
    // image cannot redirect the browser to an arbitrary or private host.
    res.setHeader('Content-Security-Policy', "img-src 'self' data: https://cdn.dexscreener.com")
    vite.middlewares(req, res, () => { res.statusCode = 404; res.end() })
  })
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await vite.close()
    if (http.listening) await new Promise((done) => http.close(done))
  }
  try {
    await new Promise((done, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); done() }) })
  } catch { await close(); throw new Error('Local listener could not start. The selected port may already be occupied; choose --port explicitly.') }
  return { http, vite, close, origin: `http://127.0.0.1:${port}` }
}
