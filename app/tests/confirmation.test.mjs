/** Fixed confirmation reads over a fake Rugged node. No wallet writes or external network. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { confirmationRequestOf, confirmationOnNode } = require('../.test-build/app/functions/_lib/confirmation.js')
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js')
const local = require('../.test-build/app/functions/_lib/localRpc.js')
const edgeClient = require('../.test-build/app/src/lib/edge/chainRoutes.js')
const { createTransactor, receiptRpc } = require('../.test-build/app/src/finance/v2/transact.js')
const { RPC_URL } = require('../.test-build/app/functions/_lib/owned.js')

const ORIGIN = 'https://domino.money', HASH = `0x${'ab'.repeat(32)}`, OTHER = `0x${'cd'.repeat(32)}`
const OWNER = `0x${'01'.repeat(20)}`, TO = `0x${'02'.repeat(20)}`, BLOCK = { number: '0x10', hash: `0x${'ef'.repeat(32)}` }
const ENV = { LOCAL_RPC_URL: 'https://rpc.domino.money/confirmation-test-token-0123456789/' }
const json = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const transaction = (extra = {}) => ({ hash: HASH, from: OWNER, to: TO, input: '0x1234', value: '0x0', nonce: '0x7', chainId: '0x1237', ...extra })
const log = (extra = {}) => ({ address: TO, topics: [OTHER], data: '0x00', logIndex: '0x0', ...extra })
const receipt = (extra = {}) => ({ transactionHash: HASH, from: OWNER, blockNumber: BLOCK.number, blockHash: BLOCK.hash,
  status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0xa', logs: [log()], ...extra })
function node({ tx = transaction(), included = receipt(), block = BLOCK, finalized = BLOCK, chainId = '0x1237', reply = null } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const asked = JSON.parse(init.body); calls.push({ url, ...asked })
    const overridden = reply?.(asked)
    if (overridden) return overridden
    const result = asked.method === 'eth_chainId' ? chainId : asked.method === 'eth_getTransactionByHash' ? tx
      : asked.method === 'eth_getTransactionReceipt' ? included : asked.params[0] === 'finalized' ? finalized : block
    return json({ jsonrpc: '2.0', id: asked.id, result })
  }
  return { fetch, calls }
}
const request = (body, { method = 'POST', headers = {} } = {}) => new Request(`${ORIGIN}/api/chain/v1/confirmation`, {
  method, headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined })
function route(fake = node(), { env = ENV } = {}) {
  const memory = routes.chainRouteMemory(), lines = []
  const runtime = { upstream: fake.fetch, memory, cache: null, now: () => 1_000_000, sleep: async () => {}, log: line => lines.push(JSON.parse(line)) }
  return { lines, fake, ask: (body = { hash: HASH }, options = {}) => routes.answerChainRoute('confirmation', { request: request(body, options), env }, runtime) }
}
const reviewed = { from: OWNER, to: TO, data: '0x1234', value: '0x0', nonce: '0x7', chainId: '0x1237' }
function confirmedTransactor(answer, finalized = async () => BLOCK) {
  const calls = []
  const wallet = { owner: OWNER, current: () => true, chainId: () => 4663,
    confirmation: { read: async hash => (assert.equal(hash, HASH), answer), finalized },
    request: async (method) => { calls.push(method); if (method === 'eth_accounts') return [OWNER]; if (method === 'eth_chainId') return '0x1237'; throw new Error(`Unexpected wallet read: ${method}`) } }
  return { calls, wallet, client: createTransactor(wallet, { chainId: 4663, l1FeeInReceipt: false }, () => 1000, () => {}) }
}

// The frontend adapter has a clock and a fake closed POST. Its timeout and backoff are tested without real waits.
function adapter(post) {
  const ts = require('typescript'), code = ts.transpileModule(readFileSync(new URL('../src/lib/edge/confirmation.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  let now = 1000
  const timers = new Set(), calls = [], mod = { exports: {} }
  const dependencies = { postRoute: async (name, body, options) => { calls.push({ name, body, options }); return post(body, options) } }
  new Function('require', 'module', 'exports', 'Date', 'setTimeout', 'clearTimeout', code)(() => dependencies, mod, mod.exports,
    { now: () => now }, (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer }, timer => timers.delete(timer))
  return { reader: mod.exports.createConfirmationReads(), calls, timers, advance: ms => { now += ms } }
}
const good = (value = { v: 1, transaction: null, receipt: null, block: null }) => ({ ok: true, value })

test('confirmation accepts only one lowercase hash or the fixed finality selector', () => {
  assert.deepEqual(confirmationRequestOf({ hash: HASH }), { hash: HASH })
  assert.deepEqual(confirmationRequestOf({ finality: true }), { finality: true })
  for (const body of [{}, { hash: HASH, finality: true }, { hash: HASH, method: 'eth_getLogs' }, { finality: 'true' },
    { hash: HASH.toUpperCase() }, { hash: `0x${'ab'.repeat(31)}` }, { hash: OWNER }, { jsonrpc: '2.0', method: 'eth_sendTransaction', params: [] }, { finality: true, url: ENV.LOCAL_RPC_URL }]) {
    assert.equal(confirmationRequestOf(body), null)
  }
})

test('pending receipts ask only for the transaction and receipt; included answers trim all unrelated RPC fields', async () => {
  const pending = node({ tx: null, included: null })
  const response = await confirmationOnNode(pending.fetch, { hash: HASH })
  assert.deepEqual(await response.json(), { v: 1, transaction: null, receipt: null, block: null })
  assert.deepEqual(pending.calls.map(call => [call.method, call.params]), [['eth_getTransactionByHash', [HASH]], ['eth_getTransactionReceipt', [HASH]]])
  assert.ok(pending.calls.every(call => call.url === RPC_URL))
  const included = node({ tx: transaction({ extra: 'discarded' }), included: receipt({ extra: 'discarded', logs: [log({ extra: 'discarded' })] }), block: { ...BLOCK, transactions: ['discarded'] } })
  const own = await confirmationOnNode(included.fetch, { hash: HASH })
  const body = await own.json()
  assert.equal(body.transaction.extra, undefined)
  assert.equal(body.receipt.extra, undefined)
  assert.equal(body.receipt.logs[0].extra, undefined)
  assert.deepEqual(body.block, BLOCK)
  assert.equal(own.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(included.calls.map(call => call.method), ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'])
})

test('finality reads one fixed header, never a transaction list or a caller-supplied block selector', async () => {
  const fake = node({ finalized: { ...BLOCK, transactions: ['discarded'] } })
  assert.deepEqual(await (await confirmationOnNode(fake.fetch, { finality: true })).json(), { v: 1, finalized: BLOCK })
  assert.deepEqual(fake.calls.map(call => [call.method, call.params]), [['eth_getBlockByNumber', ['finalized', false]]])
  assert.deepEqual(await (await confirmationOnNode(node({ finalized: null }).fetch, { finality: true })).json(), { v: 1, finalized: null })
})

test('upstream rate refusals preserve their wait through the route without private bodies or headers', async () => {
  for (const [body, method] of [[{ hash: HASH }, 'eth_getTransactionByHash'], [{ hash: HASH }, 'eth_getTransactionReceipt'],
    [{ hash: HASH }, 'eth_getBlockByNumber'], [{ finality: true }, 'eth_getBlockByNumber']]) {
    const fake = node({ reply: asked => asked.method === method ? json('private-node-details', 429,
      { 'Retry-After': '7', 'Set-Cookie': 'private-node-cookie', 'X-Upstream-Token': 'private-node-header' }) : null })
    const edge = route(fake), response = await edge.ask(body)
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '7')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Set-Cookie'), null)
    assert.equal(response.headers.get('X-Upstream-Token'), null)
    assert.deepEqual(await response.json(), { v: 1, error: 'rate_limited' })
    const posts = fake.calls.length
    const resting = await edge.ask(body)
    assert.equal(resting.status, 429)
    assert.equal(resting.headers.get('Retry-After'), '7')
    assert.equal(fake.calls.length, posts, 'the existing node transport rests rather than querying again')
    assert.ok(edge.lines.every(line => !JSON.stringify(line).includes('private-node')))
  }
  for (const [raw, expected] of [['999999', '300'], ['bad', '5'], ['-1', '5'], ['0', '1']]) {
    const answer = await confirmationOnNode(async () => json('private-node-details', 429, { 'Retry-After': raw }), { finality: true })
    assert.equal(answer.status, 429)
    assert.equal(answer.headers.get('Retry-After'), expected)
    assert.deepEqual(await answer.json(), { v: 1, error: 'rate_limited' })
  }
})

test('confirmation names its response bound at the node transport before parsing or trimming', async () => {
  const fake = node(), limits = []
  const fetch = async (url, init) => { limits.push(init.replyBytes); return fake.fetch(url, init) }
  await confirmationOnNode(fetch, { hash: HASH })
  await confirmationOnNode(fetch, { finality: true })
  assert.deepEqual(limits, [262_144, 262_144, 262_144, 262_144])
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 0, result: receipt({ unused: 'x'.repeat(524_288) }) }))
  let at = 0, cancelled = false
  const oversized = node({ reply: asked => asked.method === 'eth_getTransactionReceipt' ? new Response(new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(at, at + 32_768)); at += 32_768
    },
    cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'application/json' } }) : null })
  const cut = await route(oversized).ask()
  assert.equal(cut.status, 502)
  assert.deepEqual(await cut.json(), { v: 1, error: 'rpc_unavailable' })
  assert.equal(cancelled, true)
  assert.ok(at < bytes.length, 'the transport cancels a chunked body before buffering the full oversized result')
  assert.equal(oversized.calls.filter(call => call.method === 'eth_getBlockByNumber').length, 0, 'a cut receipt cannot trigger its canonical block read')
})

test('the route preserves method, origin, content, body and visitor rate gates before any node read', async () => {
  const edge = route()
  const cases = [
    [{ method: 'GET' }, undefined, 405], [{ headers: { Origin: 'https://evil.example' } }, { hash: HASH }, 403],
    [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, { hash: HASH }, 403], [{ headers: { 'Content-Type': 'text/plain' } }, { hash: HASH }, 415],
    [{}, 'x'.repeat(257), 400], [{}, '{', 400], [{}, [], 400], [{}, { hash: HASH, method: 'eth_call' }, 400],
  ]
  for (const [options, body, status] of cases) {
    const answer = await edge.ask(body, options)
    assert.equal(answer.status, status)
    assert.deepEqual(await answer.json(), { v: 1, error: 'bad_request' })
    assert.equal(answer.headers.get('Cache-Control'), 'no-store')
    if (status === 405) assert.equal(answer.headers.get('Allow'), 'POST')
  }
  assert.equal(edge.fake.calls.length, 0)
  const absent = route(node(), { env: {} })
  for (let i = 0; i < routes.VISITOR_CLASSES.state.burst; i++) assert.equal((await absent.ask({ hash: HASH }, { headers: { 'CF-Connecting-IP': '203.0.113.84' } })).status, 503)
  const limited = await absent.ask({ hash: HASH }, { headers: { 'CF-Connecting-IP': '203.0.113.84' } })
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), { v: 1, error: 'rate_limited' })
  assert.equal(limited.headers.get('Retry-After'), '1')
  assert.equal(absent.fake.calls.length, 0)
})

test('the local transport allows only receipt-purpose hash reads and fixed canonical/finalized headers', async () => {
  const envelope = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params })
  const send = (rpc, body) => rpc.fetch(RPC_URL, { method: 'POST', body: JSON.stringify(body) })
  for (const [method, params] of [['eth_getTransactionByHash', [HASH]], ['eth_getTransactionReceipt', [HASH]], ['eth_getBlockByNumber', ['0x10', false]], ['eth_getBlockByNumber', ['finalized', false]]]) {
    const fake = node(), rpc = local.createLocalRpc(ENV.LOCAL_RPC_URL, { purpose: 'confirmation', upstream: fake.fetch, memory: local.localRpcMemory() })
    assert.equal((await send(rpc, envelope(method, params))).status, 200)
  }
  for (const [method, params] of [['eth_getTransactionByHash', [OWNER]], ['eth_getTransactionReceipt', [HASH, true]], ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getBlockByNumber', ['safe', false]], ['eth_getBlockByNumber', ['finalized', true]], ['eth_getLogs', [{}]], ['eth_sendRawTransaction', ['0x00']], ['eth_call', [{}, 'latest']]]) {
    const fake = node(), rpc = local.createLocalRpc(ENV.LOCAL_RPC_URL, { purpose: 'confirmation', upstream: fake.fetch, memory: local.localRpcMemory() })
    await assert.rejects(send(rpc, envelope(method, params)), { message: 'local_rpc_refused_method' })
    assert.equal(fake.calls.length, 0)
  }
  const fake = node(), ledger = local.createLocalRpc(ENV.LOCAL_RPC_URL, { purpose: 'ledger', upstream: fake.fetch, memory: local.localRpcMemory() })
  await assert.rejects(send(ledger, envelope('eth_getBlockByNumber', ['finalized', false])), { message: 'local_rpc_refused_method' })
})

test('malformed RPC fields, removed logs and oversized results fail closed without raw upstream errors', async () => {
  const invalid = [node({ tx: transaction({ hash: OTHER }) }), node({ tx: transaction({ from: 'not-an-address' }) }),
    node({ tx: transaction({ input: `0x${'00'.repeat(32769)}` }) }), node({ included: receipt({ transactionHash: OTHER }) }),
    node({ included: receipt({ status: '0x2' }) }), node({ included: receipt({ logs: [log({ removed: true })] }) }),
    node({ included: receipt({ logs: [log({ topics: Array(5).fill(OTHER) })] }) }), node({ included: receipt({ logs: Array(513).fill(log()) }) }),
    node({ block: { number: 'latest', hash: BLOCK.hash } }), node({ reply: asked => json({ jsonrpc: '2.0', id: asked.id, error: { message: 'private-node-details' } }) })]
  for (const fake of invalid) {
    const answer = await route(fake).ask()
    assert.equal(answer.status, 502)
    assert.deepEqual(await answer.json(), { v: 1, error: 'rpc_unavailable' })
  }
  const big = node({ included: receipt({ logs: Array(17).fill(log({ data: `0x${'00'.repeat(16384)}` })) }) })
  await assert.rejects(confirmationOnNode(big.fetch, { hash: HASH }), { message: 'invalid_confirmation' })
  const denied = await route(node({ chainId: '0x1' })).ask()
  assert.equal(denied.status, 503)
  assert.deepEqual(await denied.json(), { v: 1, error: 'source_unavailable' })
})

test('the consumer route rejects oversized or malformed confirmation replies and respects bounded Retry-After', async () => {
  const ask = response => edgeClient.postRoute('confirmation', { hash: HASH }, { fetch: async () => response })
  assert.equal((await ask(json({ v: 1, pad: 'x'.repeat(edgeClient.REPLY_BYTES.confirmation) }))).ok, false)
  assert.equal((await ask(json('{'))).ok, false)
  assert.deepEqual(await ask(json({ v: 1, error: 'rate_limited' }, 429, { 'Retry-After': '7' })), { ok: false, failure: 'rate_limited', retryAfterMs: 7000 })
  assert.equal((await ask(json({ v: 1, error: 'rpc_unavailable' }, 502, { 'Retry-After': '999999' }))).retryAfterMs, edgeClient.MAX_RETRY_MS)
})

test('the Robinhood transactor keeps exact review and canonicality checks while receipt reads avoid the wallet provider', async () => {
  for (const [answer, finalized, expected] of [
    [{ transaction: null, receipt: null, block: null }, async () => BLOCK, 'pending'],
    [{ transaction: transaction(), receipt: null, block: null }, async () => BLOCK, 'pending'],
    [{ transaction: transaction(), receipt: receipt(), block: null }, async () => BLOCK, 'pending'],
    [{ transaction: transaction(), receipt: receipt(), block: { ...BLOCK, hash: OTHER } }, async () => BLOCK, 'reorged'],
    [{ transaction: transaction(), receipt: receipt(), block: BLOCK }, async () => ({ number: '0xf', hash: OTHER }), 'included'],
    [{ transaction: transaction(), receipt: receipt(), block: BLOCK }, async () => { throw new Error('finality-offline') }, 'included'],
    [{ transaction: transaction(), receipt: receipt(), block: BLOCK }, async () => BLOCK, 'finalized'],
    [{ transaction: transaction(), receipt: receipt({ status: '0x0' }), block: BLOCK }, async () => BLOCK, 'reverted'],
  ]) {
    const { client, calls } = confirmedTransactor(answer, finalized)
    assert.equal((await client.receipt(HASH, reviewed)).state, expected)
    assert.deepEqual(calls, [], 'the reviewed receipt remains readable after the wallet disconnects or changes networks')
  }
  const { client } = confirmedTransactor({ transaction: transaction({ input: '0x9999' }), receipt: receipt(), block: BLOCK })
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'transaction_does_not_match_review' })
  const { wallet } = confirmedTransactor({ transaction: transaction(), receipt: receipt(), block: BLOCK })
  const fallback = async () => { throw new Error('fallback must not run') }
  const read = await receiptRpc(wallet, { chainId: 4663 }, HASH, fallback)
  await assert.rejects(read('eth_getTransactionReceipt', [OTHER]), { message: 'invalid_confirmation_read' })
  await assert.rejects(read('eth_getBlockByNumber', ['latest', false]), { message: 'invalid_confirmation_read' })
  assert.equal(await receiptRpc(wallet, { chainId: 8453 }, HASH, fallback), fallback, 'other admitted chains preserve their existing reader')
})

test('the adapter coalesces receipts, caches finality briefly, and never caches a receipt outcome', async () => {
  let finish
  const client = adapter(body => body.finality ? good({ v: 1, finalized: BLOCK }) : new Promise(resolve => { finish = resolve }))
  const a = client.reader.read(HASH), b = client.reader.read(HASH)
  assert.equal(client.calls.length, 1)
  finish(good()); await Promise.all([a, b])
  assert.equal(client.timers.size, 0)
  const later = client.reader.read(HASH); assert.equal(client.calls.length, 2)
  finish(good()); await later
  assert.deepEqual(await client.reader.finalized(), BLOCK)
  assert.deepEqual(await client.reader.finalized(), BLOCK)
  assert.equal(client.calls.filter(call => call.body.finality).length, 1)
  client.advance(2001); await client.reader.finalized()
  assert.equal(client.calls.filter(call => call.body.finality).length, 2)
  await assert.rejects(client.reader.read('invalid'), { message: 'invalid_confirmation_hash' })
})

test('finality backoff cannot erase inclusion or prevent a new receipt read, and receipt backoff is bounded', async () => {
  const finalFail = adapter(body => body.finality ? { ok: false, retryAfterMs: 5000 } : good())
  await assert.rejects(finalFail.reader.finalized(), error => error.retryAfterMs === 5000)
  assert.deepEqual(await finalFail.reader.read(HASH), { transaction: null, receipt: null, block: null })
  await assert.rejects(finalFail.reader.finalized(), error => error.retryAfterMs === 5000)
  assert.equal(finalFail.calls.filter(call => call.body.finality).length, 1)
  const receiptFail = adapter(body => body.finality ? good({ v: 1, finalized: BLOCK }) : { ok: false, retryAfterMs: 7000 })
  await assert.rejects(receiptFail.reader.read(HASH), error => error.retryAfterMs === 7000)
  await assert.rejects(receiptFail.reader.read(OTHER), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.length, 1)
  assert.deepEqual(await receiptFail.reader.finalized(), BLOCK)
  receiptFail.advance(7001)
  await assert.rejects(receiptFail.reader.read(HASH), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.filter(call => call.body.hash).length, 2)
})

test('the adapter validates its envelope, caps concurrent receipts, and aborts its finality timeout', async () => {
  for (const value of [null, [], { v: 2 }, { v: 1 }, { v: 1, transaction: null }, { v: 1, transaction: null, receipt: null }]) {
    await assert.rejects(adapter(() => good(value)).reader.read(HASH), { message: 'invalid_confirmation' })
  }
  const held = adapter(() => new Promise(() => {})), pending = []
  for (let i = 0; i < 32; i++) pending.push(held.reader.read(`0x${i.toString(16).padStart(64, '0')}`))
  await assert.rejects(held.reader.read(OTHER), { message: 'confirmation_busy' })
  assert.equal(held.calls.length, 32)
  assert.ok([...held.timers].every(timer => timer.ms === 10000))
  const timed = adapter((_body, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, retryAfterMs: 0 }))))
  const finality = timed.reader.finalized()
  const timer = [...timed.timers][0]
  assert.equal(timer.ms, 2000)
  timer.fn()
  await assert.rejects(finality, { message: 'confirmation_unavailable' })
  assert.equal(timed.calls[0].options.signal.aborted, true)
  assert.equal(timed.timers.size, 0)
})
