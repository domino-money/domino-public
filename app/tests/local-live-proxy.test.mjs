import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import * as readV1 from '../../api-contracts/read-v1/runtime.mjs'
import * as readV2 from '../../api-contracts/read-v2/runtime.mjs'
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
    assert.equal((await post(s, undefined, '/api/read/v1/swap-preview')).status, 404)
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

// A read service on another release than this checkout's runtime: the dev reader on 85e7511 answers v2 pool-market with
// protocol_fee_unsupported where read-v2 2.0.0-rc.1 derives an estimate. The proxy lets through exactly what the app's
// tolerant path takes (estimateValidators in src/lib/read/estimateSource.ts, pinned in tests/read-estimate.test.mjs).
const v2PoolMarket = (folder, name) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../api-contracts/read-v2/fixtures/${folder}/pool-market.${name}.json`), 'utf8'))
const V2_GOOD = v2PoolMarket('producer', 'available')
/** A reply whose estimate this runtime refuses and nothing else: another figure than the one it derives from the same inputs. */
const V2_SKEWED = { ...V2_GOOD, estimate: { ...V2_GOOD.estimate, feeAprEstimate24hPercent: '99.99' } }
const without = (body, key) => { const copy = structuredClone(body); delete copy[key]; return copy }
/** Each body through the proxy as the upstream reply to a v2 pool-market read of its own pool id: the status and body the browser got, and the upstream calls. */
async function throughProxy(bodies) {
  let reply; let calls = 0
  const s = await server(async () => { calls++; return new Response(JSON.stringify(reply), { headers: { ...headers, 'X-Domino-Read-Contract': readV2.CONTRACT_VERSION } }) })
  try {
    const seen = []
    for (const body of bodies) {
      reply = body
      // Asked for the envelope's own pool id where it has one, so the request binding is never why a reply is refused.
      const poolId = /^0x[0-9a-f]{64}$/.test(body.poolId) ? body.poolId : V2_GOOD.poolId
      const res = await post(s, JSON.stringify({ poolId }), '/api/read/v2/pool-market')
      seen.push({ status: res.status, contract: res.headers.get('X-Domino-Read-Contract'), body: await res.json() })
    }
    return { seen, calls }
  } finally { await s.close() }
}
async function assertRefused(cases, { marketValid }) {
  for (const [label, body] of cases) {
    assert.equal(readV2.validateResponse('pool-market', body), false, `${label}: the v2 runtime refuses it`)
    assert.equal(readV1.validateResponse('pool-market', body.market), marketValid, `${label}: its market part ${marketValid ? 'passes' : 'fails'} read-v1`)
  }
  const { seen, calls } = await throughProxy(cases.map(([, body]) => body))
  assert.deepEqual(seen.map((reply, index) => [cases[index][0], reply.status, reply.body]), cases.map(([label]) => [label, 502, { error: 'upstream_invalid_response' }]))
  assert.equal(calls, cases.length, 'one upstream call each, and no retry')
}

test('v2 pool-market: a reply refused for its estimate alone reaches the browser unchanged, as the app’s tolerant path takes it', async () => {
  const cases = [
    ['the dev reader’s protocol_fee_unsupported', { ...V2_GOOD, estimate: { ...V2_GOOD.estimate, status: 'unavailable', feeAprEstimate24hPercent: null, reasons: ['protocol_fee_unsupported'] } }],
    ...['apr-tampered', 'apr-float', 'limitation-removed', 'protocol-promoted', 'stale-promoted'].map((name) => [name, v2PoolMarket('invalid', name)]),
  ]
  for (const [label, body] of cases) {
    assert.equal(readV2.validateResponse('pool-market', body), false, `${label}: the v2 runtime refuses it`)
    assert.equal(readV1.validateResponse('pool-market', body.market), true, `${label}: its market part passes read-v1`)
  }
  const { seen, calls } = await throughProxy(cases.map(([, body]) => body))
  assert.deepEqual(seen.map((reply, index) => [cases[index][0], reply.status, reply.contract, reply.body]), cases.map(([label, body]) => [label, 200, readV2.CONTRACT_VERSION, body]), 'forwarded as it came, with its own contract version')
  assert.equal(calls, cases.length)
  // A reply the runtime accepts is untouched by any of this.
  assert.deepEqual((await throughProxy([V2_GOOD])).seen, [{ status: 200, contract: readV2.CONTRACT_VERSION, body: V2_GOOD }])
})

test('v2 pool-market: a refused reply whose envelope is not read-v2’s stays refused, even when its market part passes read-v1', async () => {
  await assertRefused([
    ['the package’s schemaVersion 2', v2PoolMarket('invalid', 'version')],
    ['the package’s executionAvailable true', v2PoolMarket('invalid', 'execution')],
    ['an extra top-level key', { ...V2_SKEWED, somethingNew: true }],
    ['no estimate key', without(V2_SKEWED, 'estimate')],
    ['an estimate that is null', { ...V2_SKEWED, estimate: null }],
    ['an estimate that is a list', { ...V2_SKEWED, estimate: [V2_SKEWED.estimate] }],
    ['a schemaVersion written as a string', { ...V2_SKEWED, schemaVersion: '1' }],
    ['no executionAvailable', without(V2_SKEWED, 'executionAvailable')],
  ], { marketValid: true })
})

test('v2 pool-market: a refused reply whose market part fails read-v1 stays refused', async () => {
  await assertRefused([
    ['a market pool id that is not one', { ...V2_SKEWED, market: { ...V2_SKEWED.market, poolId: 'not-a-pool' } }],
    ['a market with a key read-v1 does not have', { ...V2_SKEWED, market: { ...V2_SKEWED.market, somethingNew: true } }],
    ['a market of another schema version', { ...V2_SKEWED, market: { ...V2_SKEWED.market, schemaVersion: 2 } }],
    ['no market snapshot', { ...V2_SKEWED, market: without(V2_SKEWED.market, 'snapshot') }],
  ], { marketValid: false })
})

test('v2 pool-market: a refused reply whose envelope is about another pool or chain than its market stays refused', async () => {
  await assertRefused([
    ['the package’s market about another pool', v2PoolMarket('invalid', 'market-pool')],
    ['the package’s envelope about another pool', v2PoolMarket('invalid', 'outer-pool')],
    ['an envelope on another chain', { ...V2_SKEWED, chainId: 1 }],
  ], { marketValid: true })
})

const readFixture = (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../api-contracts/read-v1/fixtures/gateway/${name}.json`), 'utf8'))
const PUBLIC_READS = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity']

test('the status scope may add the stored-data reads, in any order, each once; every public read stays required', () => {
  const good = fixtures[0].body
  assert.deepEqual(good.enabledReads, PUBLIC_READS)
  for (const enabledReads of [
    [...PUBLIC_READS, 'markets-snapshot'],
    [...PUBLIC_READS, 'pool-positions', 'pool-metrics', 'markets-snapshot'],
    ['markets-snapshot', ...[...PUBLIC_READS].reverse(), 'pool-metrics'],
  ]) assert.equal(validateStatus(schema, { ...good, enabledReads }), true, JSON.stringify(enabledReads))
  for (const enabledReads of [
    [],
    PUBLIC_READS.slice(1),
    [...PUBLIC_READS.slice(0, 6), 'markets-snapshot', 'pool-metrics', 'pool-positions'],
    [...PUBLIC_READS, 'swap-preview'],
    [...PUBLIC_READS, 'token'],
    [...PUBLIC_READS, 'markets-snapshot', 'markets-snapshot'],
  ]) assert.equal(validateStatus(schema, { ...good, enabledReads }), false, JSON.stringify(enabledReads))
  const off = fixtures.find((fixture) => fixture.body.readEnabled === false).body
  assert.equal(validateStatus(schema, { ...off, enabledReads: ['markets-snapshot'] }), false, 'a disabled gateway lists nothing')
})

test('capabilities that list the stored-data reads pass through; the development status with them validates', async () => {
  let reply
  const s = await server(async () => reply)
  try {
    for (const enabledReads of [[...PUBLIC_READS, 'markets-snapshot'], readFixture('capabilities.live_read_only').enabledReads]) {
      reply = response({ ...readFixture('capabilities.live_read_only'), enabledReads }, 200)
      const res = await fetch(`${s.origin}/api/read/v1/capabilities`)
      assert.equal(res.status, 200, JSON.stringify(enabledReads))
      assert.deepEqual((await res.json()).enabledReads, enabledReads)
    }
    reply = response({ ...readFixture('capabilities.live_read_only'), enabledReads: ['token', 'swap-preview'] }, 200)
    assert.equal((await fetch(`${s.origin}/api/read/v1/capabilities`)).status, 502, 'a read outside read-v1 still fails closed')

    reply = response({ ...fixtures[0].body, enabledReads: [...PUBLIC_READS, 'markets-snapshot'] }, 200)
    const status = await fetch(`${s.origin}/api/dev/v1/status`)
    assert.equal(status.status, 200)
    assert.deepEqual((await status.json()).backend.enabledReads, [...PUBLIC_READS, 'markets-snapshot'])
    reply = response({ ...fixtures[0].body, enabledReads: [...PUBLIC_READS.slice(1), 'markets-snapshot'] }, 200)
    assert.equal((await fetch(`${s.origin}/api/dev/v1/status`)).status, 502, 'a scope without a public read is incompatible')
  } finally { await s.close() }
})

test('markets-snapshot and pool-metrics POSTs go to the fixed destination and are validated both ways; a bad id list never leaves', async () => {
  const snapshot = readFixture('markets-snapshot.subset')
  const metrics = readFixture('pool-metrics.qualified')
  let calls = 0; let sent = []; let reply = () => response(snapshot, 200)
  const s = await server(async (url, options) => { calls++; sent.push({ url, body: options.body.toString() }); return reply(url) })
  try {
    const question = JSON.stringify({ poolIds: snapshot.requested })
    const answered = await post(s, question, '/api/read/v1/markets-snapshot')
    assert.equal(answered.status, 200)
    assert.deepEqual(await answered.json(), snapshot)
    assert.deepEqual(sent, [{ url: 'https://dev-read.domino.money/internal/read/v1/markets-snapshot', body: question }])
    for (const bad of [{ poolIds: Array(25).fill(snapshot.requested[0]) }, { poolIds: ['0x1234'] }, { poolIds: snapshot.requested, target: 'https://evil' }, { poolIds: snapshot.requested[0] }]) {
      assert.equal((await post(s, JSON.stringify(bad), '/api/read/v1/markets-snapshot')).status, 422, JSON.stringify(bad))
    }
    assert.equal(calls, 1, 'nothing refused reached the development reader')
    reply = () => response({ ...snapshot, schemaVersion: 999 }, 200)
    assert.equal((await post(s, question, '/api/read/v1/markets-snapshot')).status, 502, 'a reply outside the contract is refused')

    reply = () => response(metrics, 200)
    const metricsAnswer = await post(s, JSON.stringify({ poolId: metrics.poolId }), '/api/read/v1/pool-metrics')
    assert.equal(metricsAnswer.status, 200)
    assert.equal(sent.at(-1).url, 'https://dev-read.domino.money/internal/read/v1/pool-metrics')
    assert.equal((await post(s, JSON.stringify({ poolId: metrics.poolId }), '/api/read/v1/pool-positions')).status, 502, 'a pool-metrics body is no pool-positions answer')
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

// Added 2026-09-26: read-v5's featured pools list through the local lane, validated both ways by read-v5's runtime.
// Changed 2026-09-28 (featured-policy v2): read-v5 speaks rc.2 and still takes rc.1, as the read Worker does.
test('v5 is a fixed featured-pools namespace with its own version, an empty request and a validated list', async () => {
  const fixture = (kind, name) => readFileSync(resolve(import.meta.dirname, `../../api-contracts/read-v5/fixtures/${kind}/${name}.json`), 'utf8')
  let reply = fixture('valid', 'current'); let calls = 0; let sent; let version = '1.0.0-rc.2'
  const s = await server(async (url, options) => { calls++; sent = { url, options }; return new Response(reply, { headers: { ...headers, 'X-Domino-Read-Contract': version } }) })
  try {
    const valid = await post(s, '{}', '/api/read/v5/featured-pools')
    assert.equal(valid.status, 200); assert.equal(valid.headers.get('X-Domino-Read-Contract'), '1.0.0-rc.2')
    assert.deepEqual(await valid.json(), JSON.parse(reply))
    assert.equal(sent.url, 'https://dev-read.domino.money/internal/read/v5/featured-pools')
    assert.equal(sent.options.headers['X-Domino-Read-Contract'], '1.0.0-rc.2')
    assert.equal(sent.options.body.toString(), '{}')
    for (const body of ['{"poolIds":[]}', '{"limit":6}', '[]', 'null']) assert.equal((await post(s, body, '/api/read/v5/featured-pools')).status, 422, body)
    assert.equal((await post(s, '{}', '/api/read/v5/capabilities')).status, 404)
    assert.equal((await post(s, '{}', '/api/read/v5/featured-pools?limit=1')).status, 404)
    assert.equal(calls, 1)
    reply = fixture('invalid', 'hooked-pool')
    const refused = await post(s, '{}', '/api/read/v5/featured-pools')
    assert.equal(refused.status, 502); assert.deepEqual(await refused.json(), { error: 'upstream_invalid_response' })
    assert.equal(refused.headers.get('X-Domino-Read-Contract'), '1.0.0-rc.2')
    reply = JSON.stringify({ error: 'route_not_available' })
    const absent = await fetch(`${s.origin}/api/read/v5/featured-pools`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(absent.status, 502, 'a 200 that is an error body is not a list')
    assert.equal(calls, 3)
    // An rc.1 list, the VM's until rugged's step 2, passes in rc.1; a list that names another version than its header does not.
    reply = JSON.stringify({ ...JSON.parse(fixture('valid', 'current-policy-v1')), contractVersion: '1.0.0-rc.1' }); version = '1.0.0-rc.1'
    const older = await post(s, '{}', '/api/read/v5/featured-pools')
    assert.equal(older.status, 200); assert.equal(older.headers.get('X-Domino-Read-Contract'), '1.0.0-rc.1')
    assert.deepEqual(await older.json(), JSON.parse(reply))
    for (const [text, said] of [[fixture('valid', 'current'), '1.0.0-rc.1'], [reply, '1.0.0-rc.2'], [fixture('valid', 'current'), '1.0.0-rc.3']]) {
      reply = text; version = said
      const mismatch = await post(s, '{}', '/api/read/v5/featured-pools')
      assert.equal(mismatch.status, 502, said); assert.deepEqual(await mismatch.json(), { error: 'upstream_contract_mismatch' })
    }
  } finally { await s.close() }
})
