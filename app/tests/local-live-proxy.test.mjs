import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createLocalProxy } from '../scripts/local-live-proxy.mjs'
import { validateStatus } from '../scripts/local-live-status.mjs'
import { validateCredentials } from '../scripts/local-live-credentials.mjs'

const packageRoot = process.env.DOMINO_DEV_STATUS_TEST_DIR ?? resolve(import.meta.dirname, '../../api-contracts/dev-status-v1')
const schema = JSON.parse(readFileSync(resolve(packageRoot, 'schema.json'), 'utf8'))
const fixtures = JSON.parse(readFileSync(resolve(packageRoot, 'fixtures.json'), 'utf8')).responses
const credentials = { clientId: 'offline-test-client-132.access', clientSecret: 'a'.repeat(64) }
const token = '0x0000000000000000000000000000000000000000'
const headers = { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '1.1.0-rc.3' }
const response = (body = { error: 'block_unavailable' }, status = 503, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } })
async function server(fetchImpl, deadlineMs) {
  const proxy = createLocalProxy({ credentials, statusSchema: schema, fetchImpl, ...(deadlineMs ? { deadlineMs } : {}) })
  const http = createServer(proxy)
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${http.address().port}`
  return { origin, close: async () => { proxy.close(); http.closeAllConnections(); await new Promise((done) => http.close(done)) } }
}
const post = (s, body = JSON.stringify({ token }), path = '/api/read/v1/token', options = {}) => fetch(`${s.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, ...options })

test('canonical nine producer status fixtures validate; missing, extra, wrong version and cross-field states fail', () => {
  assert.equal(fixtures.length, 9)
  for (const fixture of fixtures) assert.equal(validateStatus(schema, fixture.body), true, fixture.name)
  const good = fixtures[0].body
  for (const key of Object.keys(good)) { const bad = { ...good }; delete bad[key]; assert.equal(validateStatus(schema, bad), false, key) }
  for (const bad of [{ ...good, extra: true }, { ...good, schemaVersion: 2 }, { ...good, providerHealth: 'healthy' }, { ...good, readEnabled: false }, { ...good, readerConnection: { ...good.readerConnection, state: 'cooldown', retryAfterSeconds: 0 } }]) assert.equal(validateStatus(schema, bad), false)
})
test('credential syntax allows current and legacy tokens, never a URL, missing or extra fields', () => {
  assert.equal(validateCredentials({ version: 1, ...credentials }), true)
  assert.equal(validateCredentials({ version: 1, ...credentials, clientSecret: `cfast_${'A'.repeat(48)}` }), true)
  for (const value of [{}, { version: 1, ...credentials, target: 'https://evil' }, { version: 1, ...credentials, clientSecret: 'secret\nheader' }]) assert.equal(validateCredentials(value), false)
})
test('fixed destination, exact headers only; no cookies, browser identity, upstream headers or credential reflection', async () => {
  let sent
  const s = await server(async (url, options) => { sent = { url, options }; return response(undefined, 503, { 'Set-Cookie': 'bad=1', Location: 'https://evil', 'CF-Access-Client-Secret': credentials.clientSecret, 'X-Domino-Request-Id': 'b'.repeat(32) }) })
  try {
    const res = await post(s, undefined, undefined, { headers: { 'Content-Type': 'application/json', Cookie: 'production=never', Origin: 'http://evil', Authorization: 'never', 'CF-Connecting-IP': '1.2.3.4' } })
    assert.equal(sent.url, 'https://dev-read.domino.money/internal/read/v1/token')
    assert.equal(sent.options.redirect, 'manual'); assert.equal(sent.options.credentials, 'omit')
    assert.deepEqual(Object.keys(sent.options.headers).sort(), ['Accept', 'CF-Access-Client-Id', 'CF-Access-Client-Secret', 'Content-Type', 'X-Domino-Read-Contract'].sort())
    assert.equal(res.headers.get('set-cookie'), null); assert.equal(res.headers.get('location'), null)
    assert.equal(res.headers.get('X-Domino-Request-Id'), 'b'.repeat(32)); assert.equal((await res.text()).includes(credentials.clientSecret), false)
  } finally { await s.close() }
})
test('strict UTF8, duplicate/escaped keys, depth, numeric lexemes and body bounds are rejected before upstream', async () => {
  let calls = 0
  const s = await server(async () => { calls++; return response() })
  try {
    for (const body of [`{"token":"${token}","token":"${token}"}`, `{"token":"${token}","to\\u006ben":"${token}"}`, '['.repeat(70) + '0' + ']'.repeat(70), Buffer.from([0xff]), '{}']) assert.equal((await post(s, body)).status, 422)
    assert.equal((await post(s, `{"token":"${token}","limit":1.00000000000000001}`, '/api/read/v1/catalogue')).status, 422)
    assert.equal((await post(s, ' '.repeat(8193))).status, 413)
    assert.equal((await post(s, undefined, '/api/read/v1/token?target=https://evil')).status, 404)
    assert.equal((await post(s, undefined, '/api/read/v1/pool-metrics')).status, 404)
    assert.equal(calls, 0)
  } finally { await s.close() }
})
test('redirects, invalid UTF8/JSON, duplicate replies, oversized response and leaked secrets fail without retries', async () => {
  for (const make of [() => new Response('', { status: 302, headers: { Location: 'https://evil' } }), () => new Response(Buffer.from([0xff]), { headers }), () => new Response('{', { headers }), () => new Response('{"error":"block_unavailable","error":"upstream_unavailable"}', { status: 503, headers }), () => response({ error: credentials.clientSecret }), () => new Response('x'.repeat(1048577), { headers })]) {
    let calls = 0; const s = await server(async () => { calls++; return make() })
    try { const res = await post(s); assert.ok([502, 503].includes(res.status)); const data = await res.json(); assert.ok(['upstream_invalid_response', 'response_too_large'].includes(data.error)); assert.equal(calls, 1) }
    finally { await s.close() }
  }
})
test('deduplicates exact in-flight requests, rejects others and preserves the first deadline', async () => {
  let calls = 0; let release
  const gate = new Promise((done) => { release = done })
  const s = await server(async () => { calls++; await gate; return response() }, 120)
  try {
    const a = post(s); await new Promise((r) => setTimeout(r, 25))
    const b = post(s); await new Promise((r) => setTimeout(r, 25))
    assert.equal((await post(s, JSON.stringify({ token: `0x${'1'.repeat(40)}` }))).status, 429)
    const [x, y] = await Promise.all([a, b]); assert.equal(x.status, 504); assert.equal(y.status, 504); assert.equal(calls, 1)
    assert.equal((await post(s)).status, 429, 'ambiguous cancelled transport retains the occupied slot')
    release()
  } finally { release(); await s.close() }
})
test('last browser cancellation aborts upstream; no hidden retry', async () => {
  let calls = 0; let aborted = false
  const s = await server(async (_url, options) => { calls++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error()) }, { once: true })) })
  try {
    const controller = new AbortController(); const pending = post(s, undefined, undefined, { signal: controller.signal }).catch(() => {})
    await new Promise((r) => setTimeout(r, 30)); controller.abort(); await pending
    await new Promise((r) => setTimeout(r, 30)); assert.equal(aborted, true); assert.equal(calls, 1)
  } finally { await s.close() }
})
test('slow incoming body is timed out before any remote dispatch', async () => {
  let calls = 0; const s = await server(async () => { calls++; return response() }, 60)
  try {
    const status = await new Promise((done) => { const req = httpRequest(`${s.origin}/api/read/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } }, (res) => { res.resume(); done(res.statusCode); req.destroy() }); req.write('{'); req.on('error', () => {}) })
    assert.equal(status, 408); assert.equal(calls, 0)
  } finally { await s.close() }
})
test('development access rejection is distinct in status, canonical diagnostic metadata is projected only after validation', async () => {
  let mode = 'rejected'
  const s = await server(async () => mode === 'rejected' ? new Response('private login page', { status: 403 }) : response(fixtures[0].body, 200))
  try {
    const rejected = await fetch(`${s.origin}/api/dev/v1/status`); assert.equal(rejected.status, 403); assert.equal((await rejected.json()).state, 'access_rejected')
    mode = 'ready'; const ready = await fetch(`${s.origin}/api/dev/v1/status`); assert.equal(ready.status, 200); const body = await ready.json(); assert.equal(body.state, 'validated'); assert.equal(body.backend.providerHealth, 'not_probed')
  } finally { await s.close() }
})
test('an escaped credential in an otherwise valid diagnostic field never reaches the browser', async () => {
  const payload = { ...fixtures[0].body, contractManifestSha256: credentials.clientSecret }
  const wire = JSON.stringify(payload).replace(credentials.clientSecret, '\\u0061'.repeat(64))
  assert.equal(wire.includes(credentials.clientSecret), false)
  const s = await server(async () => new Response(wire, { headers }))
  try { const res = await fetch(`${s.origin}/api/dev/v1/status`); assert.equal(res.status, 502); assert.equal((await res.text()).includes(credentials.clientSecret), false) }
  finally { await s.close() }
})

test('v2 is a fixed pool-market namespace with its own version, strict request and response binding', async () => {
  const payload = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../api-contracts/read-v2/fixtures/producer/pool-market.available.json'), 'utf8'))
  let calls = 0; let sent
  const s = await server(async (url, options) => { calls++; sent = { url, options }; return new Response(JSON.stringify(payload), { headers: { ...headers, 'X-Domino-Read-Contract': '2.0.0-rc.1' } }) })
  try {
    const valid = await post(s, JSON.stringify({ poolId: payload.poolId }), '/api/read/v2/pool-market')
    assert.equal(valid.status, 200); assert.equal(valid.headers.get('X-Domino-Read-Contract'), '2.0.0-rc.1')
    assert.equal(sent.url, 'https://dev-read.domino.money/internal/read/v2/pool-market')
    assert.equal(sent.options.headers['X-Domino-Read-Contract'], '2.0.0-rc.1')
    for (const body of [{ poolId: payload.poolId, includePriceHistory: true }, { poolId: payload.poolId.toUpperCase() }, { poolId: payload.poolId, target: 'https://evil' }]) assert.equal((await post(s, JSON.stringify(body), '/api/read/v2/pool-market')).status, 422)
    assert.equal((await post(s, '{}', '/api/read/v2/token')).status, 404)
    assert.equal(calls, 1)
    assert.equal((await post(s, JSON.stringify({ poolId: `0x${'f'.repeat(64)}` }), '/api/read/v2/pool-market')).status, 502)
  } finally { await s.close() }
})

test('v2 capabilities retain their version and share the one local slot with v1', async () => {
  const caps = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../api-contracts/read-v2/fixtures/capabilities.enabled.json'), 'utf8'))
  let release; const gate = new Promise((done) => { release = done })
  const s = await server(async () => { await gate; return new Response(JSON.stringify(caps), { headers: { ...headers, 'X-Domino-Read-Contract': '2.0.0-rc.1' } }) })
  try {
    const pending = fetch(`${s.origin}/api/read/v2/capabilities`)
    await new Promise((r) => setTimeout(r, 25))
    assert.equal((await post(s)).status, 429)
    release(); const result = await pending
    assert.equal(result.status, 200); assert.equal((await result.json()).contractVersion, '2.0.0-rc.1')
  } finally { release(); await s.close() }
})
