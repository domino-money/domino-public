// Node-only browser admission. Run before both Vite middleware and its HMR
// upgrade listener. This module neither loads credentials nor contacts a host.
export const REQUEST_LIMIT = 8192
export const RESPONSE_LIMIT = 1048576
export const DEADLINE_MS = 20000
// read-v1's ten POST routes, in the contract's order. A development gateway that
// lists a route outside this set fails the capabilities check (local-live-proxy.mjs),
// so the stored-data reads are here before the gateway serves them.
export const READS = Object.freeze(['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot'])
/** read-v3's own routes; never merged with READS, so a v1 name can never open a v3 path or the reverse. */
export const READS_V3 = Object.freeze(['overview', 'history', 'search'])

export function parsePort(args) {
  if (!args.length) return 5273
  if (args.length !== 2 || args[0] !== '--port' || !/^[1-9][0-9]{3,4}$/.test(args[1])) throw new Error('Use only --port with an explicit port from 1024 to 65535.')
  const port = Number(args[1])
  if (port < 1024 || port > 65535) throw new Error('Port must be from 1024 to 65535.')
  return port
}

export function permittedBrowserRequest(req, port, websocket = false) {
  // rawHeaders is essential: Node joins or discards some duplicates.
  const count = new Map()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase()
    count.set(name, (count.get(name) ?? 0) + 1)
  }
  for (const name of ['host', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'content-type', 'content-length', 'sec-websocket-protocol']) {
    if ((count.get(name) ?? 0) > 1) return false
  }
  const h = req.headers
  const origin = `http://127.0.0.1:${port}`
  if (h.host !== `127.0.0.1:${port}` || (h.origin !== undefined && h.origin !== origin)) return false
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20\x7f]/.test(req.url)) return false
  if (Object.keys(h).some((name) => name === 'authorization' || name.startsWith('cf-') || name.startsWith('x-forwarded-'))) return false
  if (websocket) {
    // Chromium may omit Fetch Metadata for WebSockets; Origin remains exact
    // and mandatory. A partial or cross-site metadata set is never accepted.
    const absent = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].every((name) => h[name] === undefined)
    return req.method === 'GET' && h.origin === origin && h.upgrade?.toLowerCase() === 'websocket'
      && h['sec-websocket-protocol'] === 'vite-hmr'
      && (absent || (h['sec-fetch-site'] === 'same-origin' && h['sec-fetch-mode'] === 'websocket' && h['sec-fetch-dest'] === 'empty'))
      && /^\/\?token=[A-Za-z0-9_-]{8,128}$/.test(req.url)
  }
  if (h['sec-fetch-site'] !== 'same-origin') {
    return req.method === 'GET' && !req.url.startsWith('/api') && h['sec-fetch-site'] === 'none'
      && h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-dest'] === 'document' && h.origin === undefined
  }
  if (req.url.startsWith('/api')) {
    return ['GET', 'POST'].includes(req.method) && h['sec-fetch-dest'] === 'empty'
      && ['cors', 'same-origin'].includes(h['sec-fetch-mode']) && (req.method !== 'POST' || h.origin === origin)
  }
  return ['GET', 'HEAD'].includes(req.method) && ['cors', 'no-cors', 'same-origin', 'navigate'].includes(h['sec-fetch-mode'])
    && ['empty', 'script', 'style', 'image', 'font', 'document'].includes(h['sec-fetch-dest'])
}

/** Exact raw paths only: no normalization can turn a forbidden URL into an
 * allowed operation. Query strings (including empty ones) are not accepted. */
export function readRoute(path, method) {
  if (path === '/api/read/v2/capabilities') return method === 'GET' ? { route: 'capabilities', path: '/internal/read/v2/capabilities', version: 'v2' } : null
  if (path === '/api/read/v2/pool-market') return method === 'POST' ? { route: 'pool-market', path: '/internal/read/v2/pool-market', version: 'v2' } : null
  if (path === '/api/dev/v1/status') return method === 'GET' ? { route: 'status', path: '/internal/dev/v1/status' } : null
  if (path === '/api/read/v3/capabilities') return method === 'GET' ? { route: 'capabilities', path: '/internal/read/v3/capabilities', version: 'v3' } : null
  const v3 = path.startsWith('/api/read/v3/') ? path.slice('/api/read/v3/'.length) : ''
  if (v3) return method === 'POST' && READS_V3.includes(v3) ? { route: v3, path: `/internal/read/v3/${v3}`, version: 'v3' } : null
  if (path === '/api/read/v1/capabilities') return method === 'GET' ? { route: 'capabilities', path: '/internal/read/v1/capabilities' } : null
  const route = path.startsWith('/api/read/v1/') ? path.slice('/api/read/v1/'.length) : ''
  return method === 'POST' && READS.includes(route) ? { route, path: `/internal/read/v1/${route}` } : null
}
