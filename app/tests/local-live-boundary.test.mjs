import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePort, permittedBrowserRequest, readRoute, READS } from '../scripts/local-live-boundary.mjs'

const port = 5273
const origin = `http://127.0.0.1:${port}`
function request({ path = '/api/read/v1/token', method = 'POST', headers = {}, raw = [] } = {}) {
  const h = { host: '127.0.0.1:5273', origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', ...headers }
  for (const [k, v] of Object.entries(h)) if (v === undefined) delete h[k]
  return { url: path, method, headers: h, rawHeaders: [...Object.entries(h).flat(), ...raw] }
}
test('port is explicit, loopback default, no fallback/config/secret arguments', () => {
  assert.equal(parsePort([]), 5273)
  assert.equal(parsePort(['--port', '5280']), 5280)
  for (const args of [['--port', '0'], ['--port', '80'], ['--port', '65536'], ['--port', '05273'], ['--host', '0.0.0.0'], ['--token', 'secret'], ['--port', '5273', '--port', '5274']]) assert.throws(() => parsePort(args))
})
test('Host, Origin, duplicates and client identity headers fail closed', () => {
  assert.equal(permittedBrowserRequest(request(), port), true)
  for (const headers of [{ host: 'localhost:5273' }, { host: '127.0.0.1:5280' }, { host: 'evil.example' }, { origin: 'https://domino.money' }, { origin: 'null' }, { origin: undefined }, { authorization: 'x' }, { 'cf-connecting-ip': '1.2.3.4' }, { 'cf-access-client-secret': 'x' }, { 'x-forwarded-for': '1.2.3.4' }]) assert.equal(permittedBrowserRequest(request({ headers }), port), false)
  for (const name of ['Host', 'Origin', 'Sec-Fetch-Site', 'Content-Length']) assert.equal(permittedBrowserRequest(request({ raw: [name, 'x', name, 'x'] }), port), false)
})
test('Fetch Metadata distinguishes top-level navigation from cross-site scripts and API reads', () => {
  for (const site of ['cross-site', 'same-site', 'none', undefined]) assert.equal(permittedBrowserRequest(request({ headers: { 'sec-fetch-site': site } }), port), false)
  assert.equal(permittedBrowserRequest(request({ path: '/', method: 'GET', headers: { origin: undefined, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }), port), true)
  assert.equal(permittedBrowserRequest(request({ path: '/api/read/v1/capabilities', method: 'GET', headers: { origin: undefined } }), port), true)
  for (const path of ['//evil.example/a', 'https://evil.example/a', '/\\evil.example/a', '/api/\nread']) assert.equal(permittedBrowserRequest(request({ path }), port), false)
})
test('HMR requires exact Origin, protocol and path before Vite gets the upgrade', () => {
  const args = { path: '/?token=abcdefgh1234', method: 'GET', headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr', 'sec-fetch-site': undefined, 'sec-fetch-mode': undefined, 'sec-fetch-dest': undefined } }
  assert.equal(permittedBrowserRequest(request(args), port, true), true)
  for (const headers of [{ origin: undefined }, { origin: 'http://evil.example' }, { 'sec-websocket-protocol': 'other' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'same-origin' }]) assert.equal(permittedBrowserRequest(request({ ...args, headers: { ...args.headers, ...headers } }), port, true), false)
  for (const path of ['/', '/api/read/v1/token', '/?token=abcdefgh&target=evil', '/?token=short']) assert.equal(permittedBrowserRequest(request({ ...args, path }), port, true), false)
})
test('ten exact read POSTs and two GETs; no queries, session, private routes or target URLs', () => {
  // read-v1's ten POST routes, the stored-data reads included, so a development gateway that lists them still passes.
  assert.deepEqual([...READS], ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot'])
  for (const route of READS) assert.deepEqual(readRoute(`/api/read/v1/${route}`, 'POST'), { route, path: `/internal/read/v1/${route}` })
  assert.deepEqual(readRoute('/api/read/v1/markets-snapshot', 'POST'), { route: 'markets-snapshot', path: '/internal/read/v1/markets-snapshot' })
  assert.equal(readRoute('/api/read/v1/capabilities', 'GET').route, 'capabilities')
  assert.equal(readRoute('/api/dev/v1/status', 'GET').route, 'status')
  for (const path of ['/api/read/v1/token?', '/api/read/v1/token?url=https://evil', '/api/read/v1//token', '/api/read/v1/%74oken', '/api/read/v1/a/../token', '/api/read/v1/swap-preview', '/api/read/v1/markets-snapshot/', '/api/read/v1/markets-snapshot?poolIds=1', '/api/read/v1/%6darkets-snapshot', '/api/read/v2/markets-snapshot', '/api/read/v2/pool-metrics', '/api/session/v1/login', '/api/deposit/v1/quote', 'https://evil/api/read/v1/token']) assert.equal(readRoute(path, 'POST'), null)
  assert.equal(readRoute('/api/read/v1/token', 'GET'), null)
  assert.equal(readRoute('/api/read/v1/markets-snapshot', 'GET'), null)
  assert.equal(readRoute('/api/read/v1/capabilities', 'POST'), null)
})
