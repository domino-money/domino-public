/**
 * Fixed confirmation reads over a fake Rugged node. No wallet writes or external network.
 *
 * Changed on purpose 2026-10-14 (incident C4, the 429 on /api/chain/v1/confirmation of 2026-10-13): a question costs the
 * node one POST while its transaction is in no block and two once it is (it was three, every time); what is final is
 * kept at the edge and costs nothing; the finalized block is read once for everyone; the question's second shape names
 * its chain and gets its states in a 200; every refusal names the limit that made it.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { confirmationRequestOf, confirmationOnNode, CONFIRMATION_CHAINS } = require('../.test-build/app/functions/_lib/confirmation.js')
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js')
const local = require('../.test-build/app/functions/_lib/localRpc.js')
const edgeClient = require('../.test-build/app/src/lib/edge/chainRoutes.js')
const chainIdentity = require('../.test-build/app/src/config/chainIdentity.js')
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
/**
 * The fake node: a POST of one call or of a batch, answered in kind. `calls` is every call it was asked, `posts` the
 * methods each POST carried, `asked()` the POSTs past the transport's own chain id check; `state` may change between asks.
 */
function node({ tx = transaction(), included = receipt(), block = BLOCK, finalized = BLOCK, chainId = '0x1237', reply = null } = {}) {
  const calls = [], posts = [], state = { tx, included, block, finalized }
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body), all = Array.isArray(body) ? body : [body]
    posts.push(all.map(asked => asked.method))
    for (const asked of all) calls.push({ url, ...asked })
    for (const asked of all) { const overridden = await reply?.(asked); if (overridden) return overridden }
    const replies = all.map(asked => ({ jsonrpc: '2.0', id: asked.id, result: asked.method === 'eth_chainId' ? chainId : asked.method === 'eth_getTransactionByHash' ? state.tx
      : asked.method === 'eth_getTransactionReceipt' ? state.included : asked.params[0] === 'finalized' ? state.finalized : state.block }))
    return json(Array.isArray(body) ? replies : replies[0])
  }
  return { fetch, calls, posts, state, asked: () => posts.filter(post => post[0] !== 'eth_chainId') }
}
const request = (body, { method = 'POST', headers = {}, signal } = {}) => new Request(`${ORIGIN}/api/chain/v1/confirmation`, {
  method, headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, ...(signal ? { signal } : {}) })
/** A Map in place of the Workers cache; `kept` is what it holds, by URL. */
function memoryCache() {
  const kept = new Map()
  return { kept, match: async asked => { const hit = kept.get(asked.url); return hit ? new Response(hit.text, { headers: hit.headers }) : undefined },
    put: async (asked, response) => { kept.set(asked.url, { text: await response.text(), headers: [...response.headers] }) } }
}
/** One isolate over `fake`: a clock its waits move (`slept`), what it handed to waitUntil (`settle`), its log lines. */
function route(fake = node(), { env = ENV, cache = null } = {}) {
  const memory = routes.chainRouteMemory(), lines = [], slept = [], handed = [], clock = { time: 1_000_000 }
  const runtime = { upstream: fake.fetch, memory, cache, now: () => clock.time, sleep: async ms => { slept.push(ms); clock.time += ms }, log: line => lines.push(JSON.parse(line)) }
  return { lines, fake, clock, slept, memory, cache, routeLines: () => lines.filter(line => line.route),
    settle: async () => { while (handed.length) await Promise.all(handed.splice(0)) },
    ask: (body = { hash: HASH }, options = {}) => routes.answerChainRoute('confirmation', { request: request(body, options), env, waitUntil: work => handed.push(work) }, runtime) }
}
/** The question's second shape (2026-10-14): it names its chain. */
const second = (asked, chainId = 4663) => ({ v: 2, chainId, ...asked })
const timing = response => response.headers.get('Server-Timing')
const finalityReads = fake => fake.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized').length
const keptReceipts = edge => [...edge.cache.kept.keys()].filter(url => url.includes('/receipt/'))
const PAIR = ['eth_getTransactionByHash', 'eth_getTransactionReceipt']
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
  // The adapter's two imports: the route client (its POST faked here, its limits the real ones) and the registry's chain id.
  const dependencies = { ...edgeClient, postRoute: async (name, body, options) => { calls.push({ name, body, options }); return post(body, options) } }
  new Function('require', 'module', 'exports', 'Date', 'setTimeout', 'clearTimeout', code)(name => name.endsWith('/chainIdentity') ? chainIdentity : dependencies, mod, mod.exports,
    { now: () => now }, (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer }, timer => timers.delete(timer))
  return { reader: mod.exports.createConfirmationReads(), calls, timers, advance: ms => { now += ms } }
}
const good = (value = { v: 2, state: 'pending', transaction: null, receipt: null, block: null }) => ({ ok: true, value })

test('confirmation accepts only one lowercase hash or the fixed finality selector', () => {
  assert.deepEqual(confirmationRequestOf({ hash: HASH }), { hash: HASH })
  assert.deepEqual(confirmationRequestOf({ finality: true }), { finality: true })
  for (const body of [{}, { hash: HASH, finality: true }, { hash: HASH, method: 'eth_getLogs' }, { finality: 'true' },
    { hash: HASH.toUpperCase() }, { hash: `0x${'ab'.repeat(31)}` }, { hash: OWNER }, { jsonrpc: '2.0', method: 'eth_sendTransaction', params: [] }, { finality: true, url: ENV.LOCAL_RPC_URL }]) {
    assert.equal(confirmationRequestOf(body), null)
  }
})

// Added 2026-10-14 (incident C4): the question's second shape, beside the first for tabs opened before the deploy.
test('the second shape names its chain: exactly {v: 2, chainId, hash} or {v: 2, chainId, finality: true}, and nothing else', () => {
  assert.deepEqual(confirmationRequestOf({ v: 2, chainId: 4663, hash: HASH }), { v: 2, chainId: 4663, hash: HASH })
  assert.deepEqual(confirmationRequestOf({ v: 2, chainId: 8453, finality: true }), { v: 2, chainId: 8453, finality: true })
  for (const body of [{ v: 2, hash: HASH }, { v: 2, chainId: 4663 }, { v: 2, chainId: '4663', hash: HASH }, { v: 2, chainId: 0, hash: HASH }, { v: 2, chainId: -1, hash: HASH },
    { v: 2, chainId: 4663.5, hash: HASH }, { v: 2, chainId: 2 ** 53, hash: HASH }, { v: 3, chainId: 4663, hash: HASH }, { v: 1, chainId: 4663, hash: HASH }, { v: '2', chainId: 4663, hash: HASH },
    { v: 2, chainId: 4663, hash: HASH, finality: true }, { v: 2, chainId: 4663, hash: HASH.toUpperCase() }, { v: 2, chainId: 4663, hash: OWNER }, { v: 2, chainId: 4663, finality: 'true' },
    { v: 2, chainId: 4663, finality: false }, { v: 2, chainId: 4663, method: 'eth_getLogs' }, { v: 2, chainId: 4663, hash: HASH, url: ENV.LOCAL_RPC_URL }, { chainId: 4663, hash: HASH }, { v: 2, finality: true }]) {
    assert.equal(confirmationRequestOf(body), null, JSON.stringify(body))
  }
})

// Changed on purpose 2026-10-14 (incident C4): the transaction and its receipt are ONE POST (a JSON-RPC batch); they were
// two POSTs, one after the other. The calls are the same two, and the header's the same third.
test('pending receipts ask only for the transaction and receipt; included answers trim all unrelated RPC fields', async () => {
  const pending = node({ tx: null, included: null })
  const response = await confirmationOnNode(pending.fetch, { hash: HASH })
  assert.deepEqual(await response.json(), { v: 1, transaction: null, receipt: null, block: null })
  assert.deepEqual(pending.calls.map(call => [call.method, call.params]), [['eth_getTransactionByHash', [HASH]], ['eth_getTransactionReceipt', [HASH]]])
  assert.deepEqual(pending.posts, [PAIR], 'one POST carries both')
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
  assert.deepEqual(included.posts, [PAIR, ['eth_getBlockByNumber']], 'the header is a second POST, only once there is a receipt')
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
    assert.deepEqual(edge.slept, [], 'a rest longer than two seconds is never waited out inside the request')
  }
  // 2026-10-14: a wait of two seconds or less is waited out inside the question, once (a fake wait here), and then named.
  for (const [raw, expected] of [['999999', '300'], ['bad', '5'], ['-1', '5'], ['0', '1']]) {
    const answer = await confirmationOnNode(async () => json('private-node-details', 429, { 'Retry-After': raw }), { finality: true }, { sleep: async () => {} })
    assert.equal(answer.status, 429)
    assert.equal(answer.headers.get('Retry-After'), expected)
    assert.deepEqual(await answer.json(), { v: 1, error: 'rate_limited' })
  }
})

// Changed on purpose 2026-10-14 (incident C4): the two reads of a hash share one POST, so they share one bound, twice one
// call's (it was 262,144 each, in two POSTs); the header's and the finalized block's are what they were.
test('confirmation names its response bound at the node transport before parsing or trimming', async () => {
  const fake = node(), limits = []
  const fetch = async (url, init) => { limits.push(init.replyBytes); return fake.fetch(url, init) }
  await confirmationOnNode(fetch, { hash: HASH })
  await confirmationOnNode(fetch, { finality: true })
  assert.deepEqual(limits, [524_288, 262_144, 262_144])
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 0, result: receipt({ unused: 'x'.repeat(1_048_576) }) }))
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
    [{}, { v: 2, chainId: 4663, hash: HASH, method: 'eth_call' }, 400], [{}, { v: 2, hash: HASH }, 400],
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
    // Either shape of the question: a failure keeps its status and the routes' own error body.
    for (const body of [{ hash: HASH }, second({ hash: HASH })]) {
      const answer = await route(fake).ask(body)
      assert.equal(answer.status, 502)
      assert.deepEqual(await answer.json(), { v: 1, error: 'rpc_unavailable' })
    }
  }
  // One call of the pair answered with the node's error, the other with a result: still no answer.
  const half = node({ reply: null })
  half.fetch = (inner => async (url, init) => {
    const body = JSON.parse(init.body)
    if (!Array.isArray(body) || body[0].method !== 'eth_getTransactionByHash') return inner(url, init)
    return json([{ jsonrpc: '2.0', id: body[0].id, result: transaction() }, { jsonrpc: '2.0', id: body[1].id, error: { code: -32000, message: 'private-node-details' } }])
  })(half.fetch)
  const partial = await route(half).ask(second({ hash: HASH }))
  assert.deepEqual([partial.status, await partial.json()], [502, { v: 1, error: 'rpc_unavailable' }])
  const big = node({ included: receipt({ logs: Array(17).fill(log({ data: `0x${'00'.repeat(16384)}` })) }) })
  await assert.rejects(confirmationOnNode(big.fetch, { hash: HASH }), { message: 'invalid_confirmation' })
  const denied = await route(node({ chainId: '0x1' })).ask()
  assert.equal(denied.status, 503)
  assert.deepEqual(await denied.json(), { v: 1, error: 'source_unavailable' })
  const deniedSecond = await route(node({ chainId: '0x1' })).ask(second({ hash: HASH }))
  assert.deepEqual([deniedSecond.status, await deniedSecond.json()], [503, { v: 1, error: 'source_unavailable' }])
})

// Added 2026-10-14 (incident C4). Before: three POSTs per question whatever the transaction's state (the transaction,
// its receipt, the block's header one after the other), and the question asked again every two seconds.
test('a hash in no block costs the node one POST carrying both reads; in a block, one more for its header; each shape gets its own answer of the same read', async () => {
  const pending = route(node({ tx: null, included: null }))
  const first = await pending.ask(second({ hash: HASH }))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { v: 2, state: 'pending', transaction: null, receipt: null, block: null })
  assert.deepEqual(pending.fake.asked(), [PAIR])
  assert.match(timing(first), /^edge;desc="miss", node;dur=\d+;desc="2 posts"$/, 'the isolate’s own chain id check, once, and the one POST')
  const again = await pending.ask(second({ hash: HASH }))
  assert.match(timing(again), /^edge;desc="miss", node;dur=\d+;desc="1 posts"$/)
  const old = await pending.ask({ hash: HASH })
  assert.deepEqual(await old.json(), { v: 1, transaction: null, receipt: null, block: null })
  assert.match(timing(old), /desc="1 posts"$/)
  assert.deepEqual(pending.fake.asked(), [PAIR, PAIR, PAIR])
  // Known to the node, in no block yet: still pending, still one POST, and the transaction is there for the client's review check.
  const known = route(node({ included: null }))
  assert.deepEqual(await (await known.ask(second({ hash: HASH }))).json(), { v: 2, state: 'pending', transaction: transaction(), receipt: null, block: null })
  assert.deepEqual(known.fake.asked(), [PAIR])
  // In a block: the header is the second POST.
  const included = route(node())
  const answer = await included.ask(second({ hash: HASH }))
  assert.deepEqual(await answer.json(), { v: 2, state: 'included', transaction: transaction(), receipt: receipt(), block: BLOCK })
  assert.deepEqual(included.fake.asked(), [PAIR, ['eth_getBlockByNumber']])
  assert.match(timing(await included.ask(second({ hash: HASH }))), /^edge;desc="miss", node;dur=\d+;desc="2 posts"$/)
  assert.deepEqual(await (await included.ask({ hash: HASH })).json(), { v: 1, transaction: transaction(), receipt: receipt(), block: BLOCK })
  // A receipt whose block the node cannot name yet is not "included": the client would call it pending too.
  const headless = route(node({ block: null }))
  assert.deepEqual(await (await headless.ask(second({ hash: HASH }))).json(), { v: 2, state: 'pending', transaction: transaction(), receipt: receipt(), block: null })
  // Both shapes at once share one read of the node.
  let release
  const slow = node({ reply: asked => asked.method === 'eth_getTransactionReceipt' ? new Promise(done => { release = () => done(null) }) : null })
  const shared = route(slow)
  const both = [shared.ask(second({ hash: HASH })), shared.ask({ hash: HASH })]
  for (let i = 0; i < 200 && !release; i++) await new Promise(done => setTimeout(done, 2))
  await new Promise(done => setTimeout(done, 20))
  release()
  const [a, b] = await Promise.all(both)
  assert.deepEqual([(await a.json()).v, (await b.json()).v], [2, 1])
  assert.deepEqual(slow.asked(), [PAIR, ['eth_getBlockByNumber']], 'one read for the two questions')
  assert.ok(shared.routeLines().some(line => line.cache === 'coalesced' && line.posts === 0))
})

// Added 2026-10-14 (incident C4). Before: nothing was kept, so a receipt that could never change again cost the node
// three POSTs every time it was asked. The rule that makes a wrong "final" impossible: an answer is kept only when its
// block is at or below a finalized number the edge ALREADY held before it asked the node about the transaction.
test('a receipt whose block is at or below the kept finalized number is kept and costs the node nothing on the second ask, for either shape', async () => {
  const fake = node({ finalized: { number: '0x20', hash: OTHER } })
  const edge = route(fake, { cache: memoryCache() })
  assert.deepEqual(await (await edge.ask(second({ finality: true }))).json(), { v: 2, finalized: { number: '0x20', hash: OTHER } })
  const first = await edge.ask(second({ hash: HASH })), body = await first.json()
  assert.equal(body.state, 'included')
  assert.match(timing(first), /desc="2 posts"$/)
  const posts = fake.posts.length
  const again = await edge.ask(second({ hash: HASH }))
  assert.deepEqual(await again.json(), body)
  assert.equal(timing(again), 'edge;desc="hit", node;dur=0;desc="0 posts"')
  const old = await edge.ask({ hash: HASH })
  assert.deepEqual(await old.json(), { v: 1, transaction: body.transaction, receipt: body.receipt, block: body.block })
  assert.equal(timing(old), 'edge;desc="hit", node;dur=0;desc="0 posts"')
  // Whatever the node says later, and however long after: what is final never changes, so it is never asked again.
  fake.state.tx = null; fake.state.included = null
  edge.clock.time += 300 * 86400_000
  assert.deepEqual(await (await edge.ask(second({ hash: HASH }))).json(), body)
  assert.equal(fake.posts.length, posts, 'no POST for a final receipt')
  const [url] = keptReceipts(edge)
  assert.equal(keptReceipts(edge).length, 1)
  assert.ok(url.startsWith(`${ORIGIN}/api/chain/v1/cache/`) && url.endsWith(`/4663/receipt/${HASH}`), url)
  assert.equal(new Headers(edge.cache.kept.get(url).headers).get('Cache-Control'), 'max-age=31536000')
  assert.ok(edge.routeLines().slice(-1).every(line => line.outcome === 'answer' && line.cache === 'hit' && line.posts === 0))
  // A reverted transaction in a final block is as final, and kept the same; the number itself is at the boundary.
  const reverted = node({ included: receipt({ status: '0x0' }), finalized: BLOCK })
  const other = route(reverted, { cache: memoryCache() })
  await other.ask({ finality: true })
  await other.ask({ hash: HASH })
  const before = reverted.posts.length
  assert.equal((await (await other.ask(second({ hash: HASH }))).json()).receipt.status, '0x0')
  assert.equal(reverted.posts.length, before)
})

test('an answer that is not final is never kept: not a pending one, not one above the finalized number, not one with no number held, not one a later number would cover', async () => {
  // No finalized number held: nothing is kept, and each ask reads the node.
  const none = route(node(), { cache: memoryCache() })
  for (let i = 0; i < 3; i++) assert.equal((await (await none.ask(second({ hash: HASH }))).json()).state, 'included')
  assert.deepEqual(none.fake.asked(), [PAIR, ['eth_getBlockByNumber'], PAIR, ['eth_getBlockByNumber'], PAIR, ['eth_getBlockByNumber']])
  assert.deepEqual([...none.cache.kept.keys()], [], 'nothing kept at all')
  // The finalized number is below the receipt's block (0x10): not kept, however often it is asked.
  const below = route(node({ finalized: { number: '0xf', hash: OTHER } }), { cache: memoryCache() })
  await below.ask(second({ finality: true }))
  for (let i = 0; i < 2; i++) await below.ask(second({ hash: HASH }))
  assert.deepEqual(keptReceipts(below), [])
  assert.deepEqual(below.fake.asked().slice(1), [PAIR, ['eth_getBlockByNumber'], PAIR, ['eth_getBlockByNumber']])
  // Not in a block: never kept, so the next ask sees the block the moment the node does.
  const pending = node({ tx: null, included: null, finalized: { number: '0x20', hash: OTHER } })
  const waiting = route(pending, { cache: memoryCache() })
  await waiting.ask(second({ finality: true }))
  assert.equal((await (await waiting.ask(second({ hash: HASH }))).json()).state, 'pending')
  assert.deepEqual(keptReceipts(waiting), [])
  pending.state.tx = transaction(); pending.state.included = receipt()
  assert.equal((await (await waiting.ask(second({ hash: HASH }))).json()).state, 'included', 'a pending answer never delays the screen')
  // A finalized number that arrives while the transaction is being read does not vouch for that read: the read began
  // before it, and a block is only immutable for a read that began after it was final. The next ask keeps it.
  let nested = null
  const racing = node({ finalized: { number: '0x20', hash: OTHER }, reply: async asked => {
    if (asked.method === 'eth_getTransactionReceipt' && nested === null) { nested = false; await race.ask(second({ finality: true })); nested = true }
    return null
  } })
  const race = route(racing, { cache: memoryCache() })
  assert.equal((await (await race.ask(second({ hash: HASH }))).json()).state, 'included')
  assert.equal(nested, true, 'the finalized number was read and kept during the receipt read')
  assert.deepEqual(keptReceipts(race), [], 'and that read is not kept')
  await race.ask(second({ hash: HASH }))
  assert.equal(keptReceipts(race).length, 1, 'the next read began with the number in hand')
  // A header that names another block hash than the receipt's, a receipt the node cannot place, a missing transaction: never kept.
  for (const fake of [node({ block: { ...BLOCK, hash: OTHER }, finalized: { number: '0x20', hash: OTHER } }), node({ block: null, finalized: { number: '0x20', hash: OTHER } }),
    node({ tx: null, finalized: { number: '0x20', hash: OTHER } }), node({ finalized: null })]) {
    const edge = route(fake, { cache: memoryCache() })
    await edge.ask({ finality: true })
    await edge.ask({ hash: HASH })
    await edge.ask(second({ hash: HASH }))
    assert.deepEqual(keptReceipts(edge), [])
  }
  // Without an edge cache (a local server) nothing is kept and nothing breaks.
  const bare = route(node({ finalized: { number: '0x20', hash: OTHER } }))
  await bare.ask({ finality: true })
  assert.equal((await bare.ask(second({ hash: HASH }))).status, 200)
  assert.equal((await bare.ask(second({ hash: HASH }))).status, 200)
  assert.deepEqual(bare.fake.asked().slice(1), [PAIR, ['eth_getBlockByNumber'], PAIR, ['eth_getBlockByNumber']])
})

// Added 2026-10-14 (incident C4). Before: one POST per question, every 2 s per tab with anything pending.
test('the finalized block is read once for everyone: a hundred at once cost one POST; fresh for 15 s; then up to a minute old while one refresh runs', async () => {
  const fake = node({ finalized: { number: '0x20', hash: OTHER } })
  const edge = route(fake, { cache: memoryCache() })
  const ask = i => edge.ask(i % 2 ? second({ finality: true }) : { finality: true })
  const numberOf = async response => (await response.json()).finalized.number
  const cold = await Promise.all(Array.from({ length: 100 }, (_, i) => ask(i)))
  assert.ok(cold.every(response => response.status === 200))
  assert.equal(finalityReads(fake), 1, 'a hundred concurrent questions, one POST')
  // Added 2026-10-14 (C4 review): the entry's own lifetime is the longest it may be served, a minute, and no longer
  // (this cache ignores max-age, and the age check below does not depend on it, so the header itself is the contract).
  const finalityUrls = [...edge.cache.kept.keys()].filter(url => url.endsWith('/4663/finality'))
  assert.equal(finalityUrls.length, 1)
  assert.equal(new Headers(edge.cache.kept.get(finalityUrls[0]).headers).get('Cache-Control'), 'max-age=60')
  // Fresh for fifteen seconds: no POST at all.
  edge.clock.time += 14_999
  const fresh = await ask(1)
  assert.equal(await numberOf(fresh), '0x20')
  assert.equal(timing(fresh), 'edge;desc="hit", node;dur=0;desc="0 posts"')
  assert.equal(finalityReads(fake), 1)
  // Older than that, up to a minute: answered at once with what is kept, while ONE refresh reads the node.
  fake.state.finalized = { number: '0x30', hash: HASH }
  edge.clock.time += 2
  const stale = await Promise.all(Array.from({ length: 100 }, (_, i) => ask(i)))
  for (const response of stale) assert.equal(await numberOf(response), '0x20')
  await edge.settle()
  assert.equal(finalityReads(fake), 2, 'one refresh for the hundred')
  assert.equal(await numberOf(await ask(1)), '0x30', 'the refresh is what the next question gets')
  assert.equal(finalityReads(fake), 2)
  assert.equal(edge.memory.confirmation.refresh, null, 'the refresh cleared its own slot')
  // A refresh whose request was cut off (it never settles) is not waited on, and after its bound another is started.
  edge.clock.time += 20_000
  edge.memory.confirmation.refresh = { started: edge.clock.time }
  assert.equal(await numberOf(await ask(1)), '0x30')
  await edge.settle()
  assert.equal(finalityReads(fake), 2, 'one refresh at a time')
  edge.clock.time += 30_000
  edge.memory.confirmation.refresh = { started: edge.clock.time - 45_001 }
  fake.state.finalized = { number: '0x38', hash: HASH }
  assert.equal(await numberOf(await ask(1)), '0x30')
  await edge.settle()
  assert.equal(finalityReads(fake), 3, 'a dead refresh is replaced')
  // Past a minute nothing kept is served: the question reads the node itself, and keeps what it read.
  edge.clock.time += 60_001
  fake.state.finalized = { number: '0x40', hash: HASH }
  const late = await ask(1)
  assert.equal(await numberOf(late), '0x40')
  assert.match(timing(late), /^edge;desc="miss", node;dur=\d+;desc="1 posts"$/)
  assert.equal(finalityReads(fake), 4)
  // Four a minute at most, however many ask: 240 questions over a minute, one every quarter of a second.
  const minute = finalityReads(fake)
  for (let i = 0; i < 240; i++) { edge.clock.time += 250; await ask(i); await edge.settle() }
  assert.ok(finalityReads(fake) - minute <= 4, `${finalityReads(fake) - minute} finalized reads in a minute`)
  // A node with no finalized block yet: kept the same way, and nothing is final by it.
  const young = route(node({ finalized: null }), { cache: memoryCache() })
  assert.deepEqual(await (await young.ask(second({ finality: true }))).json(), { v: 2, finalized: null })
  assert.deepEqual(await (await young.ask({ finality: true })).json(), { v: 1, finalized: null })
  assert.equal(finalityReads(young.fake), 1)
})

// Added 2026-10-14 (incident C4). Before: the transport's rest went straight to the browser as a red 429, where the state
// and ledger routes wait a short one out inside the request.
// Rewritten on purpose 2026-10-14 (C4 review): the finalized block's question waited out a rest of two seconds too, but
// the page gives that question two seconds in all (src/lib/edge/confirmation.ts, and tabs opened before the deploy the
// same), so the wait ended after the page had gone. It now waits a rest of FINALITY_REST_WAIT_MS (a second) or less, and
// a longer one is its busy or its 429 at once; a receipt's question (ten seconds in the page) still waits two.
test('a rest of two seconds or less is waited out inside the question, once; a longer one is a 200 "busy" for the second shape and a 429 for the first, and names the limit', async () => {
  const { FINALITY_REST_WAIT_MS, REST_WAIT_MS } = require('../.test-build/app/functions/_lib/confirmation.js')
  assert.deepEqual([REST_WAIT_MS, FINALITY_REST_WAIT_MS], [2_000, 1_000])
  // The node says 429 once (no wait named): the isolate rests 2 s, a receipt's question waits them and asks again.
  for (const body of [second({ hash: HASH }), { hash: HASH }]) {
    let refusals = 1
    const fake = node({ reply: asked => asked.method !== 'eth_chainId' && refusals-- > 0 ? json('private-node-details', 429) : null })
    const edge = route(fake), response = await edge.ask(body)
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.deepEqual(edge.slept, [2_000])
    assert.equal(/limit;/.test(timing(response)), false, 'an answer names no limit')
    assert.deepEqual(edge.routeLines().map(line => [line.outcome, 'limiter' in line]), [['answer', false]])
    const value = await response.json()
    assert.deepEqual([value.transaction, value.receipt, value.block], [transaction(), receipt(), BLOCK])
  }
  // The finalized block's question does not wait those 2 s, which would outlast the page's own 2 s: its busy (or its
  // 429) at once, with the wait, and nothing asked twice.
  for (const [body, old] of [[second({ finality: true }), false], [{ finality: true }, true]]) {
    let refusals = 1
    const fake = node({ reply: asked => asked.method !== 'eth_chainId' && refusals-- > 0 ? json('private-node-details', 429) : null })
    const edge = route(fake), response = await edge.ask(body)
    assert.deepEqual(edge.slept, [], JSON.stringify(body))
    assert.equal(fake.asked().length, 1)
    if (old) assert.deepEqual([response.status, response.headers.get('Retry-After'), await response.json()], [429, '2', { v: 1, error: 'rate_limited' }])
    else assert.deepEqual([response.status, await response.json()], [200, { v: 2, state: 'busy', retryAfterMs: 2_000 }])
    assert.match(timing(response), /^edge;desc="miss", node;dur=\d+;desc="2 posts", limit;desc="rest"$/)
  }
  // A rest with a second or less to run is waited out by the finalized block's question too, and answered.
  for (const body of [second({ finality: true }), { finality: true }]) {
    const edge = route(node())
    edge.memory.node.trustedUntil = edge.clock.time + local.LOCAL_RPC_TRUST_MS
    edge.memory.node.restUntil = edge.clock.time + 1_000
    const response = await edge.ask(body)
    assert.deepEqual(edge.slept, [1_000], JSON.stringify(body))
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).finalized, BLOCK)
    assert.deepEqual(edge.fake.asked(), [['eth_getBlockByNumber']])
  }
  // The node keeps refusing: a receipt's question waits once, makes one more POST, then the isolate's longer rest (8 s)
  // is named, never waited. The finalized block's names the first rest (2 s) at once.
  for (const [body, old] of [[second({ hash: HASH }), false], [{ hash: HASH }, true], [second({ finality: true }), false], [{ finality: true }, true]]) {
    const finality = 'finality' in body
    const fake = node({ reply: asked => asked.method !== 'eth_chainId' ? json('private-node-details', 429) : null })
    const edge = route(fake), response = await edge.ask(body)
    const named = finality ? 2 : 8
    assert.deepEqual(edge.slept, finality ? [] : [2_000], 'waited out once, by a receipt’s question only')
    assert.equal(fake.asked().length, finality ? 1 : 2, 'the refused POST, and for a receipt the one after the rest')
    if (old) {
      assert.deepEqual([response.status, response.headers.get('Retry-After'), await response.json()], [429, String(named), { v: 1, error: 'rate_limited' }])
    } else {
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Retry-After'), null)
      assert.deepEqual(await response.json(), { v: 2, state: 'busy', retryAfterMs: named * 1000 })
    }
    assert.match(timing(response), new RegExp(`^edge;desc="miss", node;dur=\\d+;desc="${finality ? 2 : 3} posts", limit;desc="rest"$`))
    assert.deepEqual(edge.routeLines().map(line => [line.status, line.outcome, line.limiter]), [[old ? 429 : 200, 'busy', 'rest']])
    assert.equal(JSON.stringify(edge.lines).includes('private-node'), false)
    // While the isolate rests, the next question asks the node nothing and says the same.
    const posts = fake.posts.length
    const resting = await edge.ask(body)
    assert.equal(fake.posts.length, posts)
    assert.match(timing(resting), /^edge;desc="hit", node;dur=0;desc="0 posts", limit;desc="rest"$/)
    if (old) assert.deepEqual([resting.status, resting.headers.get('Retry-After')], [429, String(named)])
    else assert.deepEqual([resting.status, await resting.json()], [200, { v: 2, state: 'busy', retryAfterMs: named * 1000 }])
  }
  // The node names eight seconds itself: nothing is waited, nothing is asked twice.
  for (const [body, old] of [[second({ hash: HASH }), false], [{ hash: HASH }, true]]) {
    const fake = node({ reply: asked => asked.method !== 'eth_chainId' ? json('private-node-details', 429, { 'Retry-After': '8' }) : null })
    const edge = route(fake), response = await edge.ask(body)
    assert.deepEqual(edge.slept, [])
    assert.equal(fake.asked().length, 1)
    if (old) assert.deepEqual([response.status, response.headers.get('Retry-After'), await response.json()], [429, '8', { v: 1, error: 'rate_limited' }])
    else assert.deepEqual([response.status, await response.json()], [200, { v: 2, state: 'busy', retryAfterMs: 8_000 }])
    assert.match(timing(response), /, limit;desc="rest"$/)
  }
  // The isolate's own pace a second behind: named "pace", for both shapes (the finalized block's question, since the
  // C4 review, without the wait of 2 s that a receipt's makes).
  for (const [body, old] of [[second({ hash: HASH }), false], [{ hash: HASH }, true], [second({ finality: true }), false], [{ finality: true }, true]]) {
    const edge = route(node())
    edge.memory.node.trustedUntil = edge.clock.time + local.LOCAL_RPC_TRUST_MS
    edge.memory.node.tat = edge.clock.time + 600_000
    const response = await edge.ask(body)
    assert.equal(edge.fake.posts.length, 0, 'nothing reaches the node')
    assert.deepEqual(edge.slept, 'finality' in body ? [] : [2_000])
    assert.equal(response.status, old ? 429 : 200)
    assert.match(timing(response), /^edge;desc="hit", node;dur=0;desc="0 posts", limit;desc="pace"$/)
    assert.deepEqual(edge.routeLines().map(line => [line.outcome, line.limiter]), [['busy', 'pace']])
    if (!old) assert.deepEqual(await response.json(), { v: 2, state: 'busy', retryAfterMs: 2_000 })
  }
  // A question that joined a read which ended busy says the reader's limit.
  let release
  const slow = node({ reply: asked => asked.method === 'eth_getTransactionReceipt' ? new Promise(done => { release = () => done(json('private-node-details', 429, { 'Retry-After': '9' })) }) : null })
  const joined = route(slow)
  const both = [joined.ask(second({ hash: HASH })), joined.ask(second({ hash: HASH }))]
  for (let i = 0; i < 200 && !release; i++) await new Promise(done => setTimeout(done, 2))
  await new Promise(done => setTimeout(done, 20))
  release()
  for (const response of await Promise.all(both)) {
    assert.deepEqual(await response.json(), { v: 2, state: 'busy', retryAfterMs: 9_000 })
    assert.match(timing(response), /, limit;desc="rest"$/)
  }
  assert.deepEqual(joined.routeLines().map(line => [line.cache, line.outcome, line.limiter]).sort(), [['coalesced', 'busy', 'rest'], ['miss', 'busy', 'rest']])
})

// Added 2026-10-14 (C4 review): a rest short enough to wait out is still not waited for a question nobody waits for any
// more (its request already cut off): the edge would hold it for nothing. Its refusal at once, and nothing asked.
test('a rest is not waited out for a question whose visitor has gone: no sleep, its busy or its 429 at once', async () => {
  for (const [body, restMs, old] of [[second({ hash: HASH }), 2_000, false], [{ hash: HASH }, 2_000, true], [second({ finality: true }), 1_000, false], [{ finality: true }, 1_000, true]]) {
    for (const gone of [true, false]) {
      const edge = route(node())
      edge.memory.node.trustedUntil = edge.clock.time + local.LOCAL_RPC_TRUST_MS
      edge.memory.node.restUntil = edge.clock.time + restMs
      const visitor = new AbortController()
      if (gone) visitor.abort()
      const response = await edge.ask(body, { signal: visitor.signal })
      if (!gone) {
        // The same question with its visitor still there waits the rest out and is answered: the control.
        assert.deepEqual([edge.slept, response.status], [[restMs], 200], JSON.stringify(body))
        continue
      }
      assert.deepEqual(edge.slept, [], `${JSON.stringify(body)}: not held for a rest nobody waits for`)
      assert.equal(edge.fake.posts.length, 0, 'nothing reaches the node')
      if (old) assert.deepEqual([response.status, response.headers.get('Retry-After')], [429, String(restMs / 1000)])
      else assert.deepEqual([response.status, await response.json()], [200, { v: 2, state: 'busy', retryAfterMs: restMs }])
      assert.match(timing(response), /, limit;desc="rest"$/)
    }
  }
})

// Added 2026-10-14 (incident C4): one table says which chains this edge reads a receipt on. Any other is told so at once,
// and the page reads through the person's wallet there.
test('a chain this edge has no node for is "not_served" at once: no node read, no secret needed, and it still takes the visitor’s turn', async () => {
  // The table: the one chain the edge's node is on, which is the chain the page's adapter asks about.
  assert.deepEqual([...CONFIRMATION_CHAINS], [chainIdentity.ROBINHOOD_ID])
  assert.equal(chainIdentity.ROBINHOOD_ID, 4663)
  for (const env of [ENV, {}]) {
    const edge = route(node(), { env })
    for (const body of [second({ hash: HASH }, 8453), second({ finality: true }, 42161), second({ hash: HASH }, 1)]) {
      const response = await edge.ask(body)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { v: 2, state: 'not_served' })
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.equal(timing(response), 'edge;desc="none", node;dur=0;desc="0 posts"')
    }
    assert.equal(edge.fake.calls.length, 0)
    assert.ok(edge.routeLines().every(line => line.outcome === 'answer' && line.cache === 'none' && line.posts === 0 && !('limiter' in line)))
  }
  // Robinhood Chain is served: without the node's secret that is the calm 503 it always was.
  const off = await route(node(), { env: {} }).ask(second({ hash: HASH }))
  assert.deepEqual([off.status, await off.json()], [503, { v: 1, error: 'source_unavailable' }])
  const limited = route(node(), { env: {} })
  const visitor = { headers: { 'CF-Connecting-IP': '203.0.113.85' } }
  for (let i = 0; i < routes.VISITOR_CLASSES.confirm.burst; i++) assert.equal((await limited.ask(second({ hash: HASH }, 8453), visitor)).status, 200)
  const refused = await limited.ask(second({ hash: HASH }, 8453), visitor)
  assert.deepEqual([refused.status, await refused.json()], [429, { v: 1, error: 'rate_limited' }])
  assert.match(timing(refused), /, limit;desc="class"$/)
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

// Added 2026-10-14 (incident C4): the money client's own checks (this exact transaction, the canonical block, success)
// over the real route in the second shape, through the adapter: what the edge keeps or batches changes none of them.
test('the adapter over the real route: the transactor reads pending, included and finalized from the second shape, and a kept final receipt answers the same', async () => {
  const fake = node({ tx: null, included: null, finalized: { number: '0xf', hash: OTHER } })
  const edge = route(fake, { cache: memoryCache() })
  const post = async body => {
    const response = await edge.ask(body)
    return response.status === 200 ? { ok: true, value: await response.json() } : { ok: false, failure: 'unavailable', retryAfterMs: 0 }
  }
  const page = adapter(post)
  const wallet = { owner: OWNER, current: () => true, chainId: () => 4663, confirmation: page.reader, request: async method => { throw new Error(`Unexpected wallet read: ${method}`) } }
  const client = createTransactor(wallet, { chainId: 4663, l1FeeInReceipt: false }, () => 1000, () => {})
  assert.equal((await client.receipt(HASH, reviewed)).state, 'pending')
  fake.state.tx = transaction(); fake.state.included = receipt()
  assert.equal((await client.receipt(HASH, reviewed)).state, 'included')
  fake.state.finalized = { number: '0x20', hash: OTHER }
  page.advance(2_001); edge.clock.time += 60_001
  assert.equal((await client.receipt(HASH, reviewed)).state, 'finalized')
  // That read began before the edge held the new finalized number, so it was not kept; this one is.
  page.advance(2_001)
  assert.equal((await client.receipt(HASH, reviewed)).state, 'finalized')
  const posts = fake.posts.length
  page.advance(2_001)
  const kept = await client.receipt(HASH, reviewed)
  assert.equal(kept.state, 'finalized')
  assert.deepEqual([kept.blockHash, kept.blockNumber, kept.logs.length], [BLOCK.hash, 16n, 1])
  assert.equal(fake.posts.length, posts, 'the final receipt and the fresh finalized block cost the node nothing')
  assert.ok(page.calls.every(call => call.body.v === 2 && call.body.chainId === 4663), 'every question in the second shape')
  // A kept final receipt still fails the client's own review check when it is not the reviewed transaction.
  await assert.rejects(client.receipt(HASH, { ...reviewed, data: '0x9999' }), { message: 'transaction_does_not_match_review' })
})

// Rewritten on purpose 2026-10-14 (incident C4): the adapter asks in the second shape (it named no chain and read `v: 1`),
// and the case's last words now say where an outcome may be kept. The tab still keeps none: a pending answer must be
// asked again, and only the edge can tell a final receipt, which it keeps for everyone (the cases above).
test('the adapter asks in the second shape, coalesces receipts, caches finality briefly, and never caches a receipt outcome', async () => {
  let finish
  const client = adapter(body => body.finality ? good({ v: 2, finalized: BLOCK }) : new Promise(resolve => { finish = resolve }))
  const a = client.reader.read(HASH), b = client.reader.read(HASH)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].name, 'confirmation')
  assert.equal(JSON.stringify(client.calls[0].body), JSON.stringify({ v: 2, chainId: 4663, hash: HASH }))
  finish(good()); await Promise.all([a, b])
  assert.equal(client.timers.size, 0)
  const later = client.reader.read(HASH); assert.equal(client.calls.length, 2)
  finish(good({ v: 2, state: 'included', transaction: transaction(), receipt: receipt(), block: BLOCK }))
  assert.deepEqual(await later, { transaction: transaction(), receipt: receipt(), block: BLOCK })
  const once = client.reader.read(HASH); assert.equal(client.calls.length, 3, 'an included outcome is not kept in the tab either')
  finish(good()); assert.deepEqual(await once, { transaction: null, receipt: null, block: null })
  assert.deepEqual(await client.reader.finalized(), BLOCK)
  assert.equal(JSON.stringify(client.calls.at(-1).body), JSON.stringify({ v: 2, chainId: 4663, finality: true }))
  assert.deepEqual(await client.reader.finalized(), BLOCK)
  assert.equal(client.calls.filter(call => call.body.finality).length, 1)
  client.advance(2001); await client.reader.finalized()
  assert.equal(client.calls.filter(call => call.body.finality).length, 2)
  await assert.rejects(client.reader.read('invalid'), { message: 'invalid_confirmation_hash' })
})

/** A money client's own read (finance/v2/transact.ts receiptRpc): the foreground lane (C3, C3 review). */
const FG = { foreground: true }

// Rewritten on purpose 2026-10-14 (incident C3: waiting never locks): it required a refusal of one hash to refuse the next
// hash's read with no request (one "not before" for every receipt of the tab), which is how a background read made a
// just-sent step's read fail and the step lock. Each hash now rests on its own; the bound and the finality lane are kept.
// Rewritten on purpose again 2026-10-14 (C3 review: never more requests of the site's node than before): the background's
// reads rest as one lane again, as this case required before C3 (another queue read asks nothing during the wait); the
// money client's own reads are the ones that rest per hash.
test('finality backoff cannot erase inclusion or prevent a new receipt read, and receipt backoff is bounded: the background as one lane, the foreground per hash', async () => {
  const finalFail = adapter(body => body.finality ? { ok: false, retryAfterMs: 5000 } : good())
  await assert.rejects(finalFail.reader.finalized(), error => error.retryAfterMs === 5000)
  assert.deepEqual(await finalFail.reader.read(HASH), { transaction: null, receipt: null, block: null })
  await assert.rejects(finalFail.reader.finalized(), error => error.retryAfterMs === 5000)
  assert.equal(finalFail.calls.filter(call => call.body.finality).length, 1)
  const receiptFail = adapter(body => body.finality ? good({ v: 2, finalized: BLOCK }) : { ok: false, retryAfterMs: 7000 })
  await assert.rejects(receiptFail.reader.read(HASH), error => error.retryAfterMs === 7000)
  await assert.rejects(receiptFail.reader.read(OTHER), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.length, 1, 'the background asks nothing during its wait')
  // The money client's own reads are not rested by it; each of its hashes rests on its own.
  await assert.rejects(receiptFail.reader.read(HASH, FG), error => error.retryAfterMs === 7000)
  await assert.rejects(receiptFail.reader.read(HASH, FG), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.length, 2, 'that hash asks nothing during its own wait')
  await assert.rejects(receiptFail.reader.read(OTHER, FG), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.length, 3, 'another hash of the money client asks on its own')
  assert.deepEqual(await receiptFail.reader.finalized(), BLOCK)
  receiptFail.advance(7001)
  await assert.rejects(receiptFail.reader.read(HASH), error => error.retryAfterMs === 7000)
  assert.equal(receiptFail.calls.filter(call => call.body.hash).length, 4)
})

// Added 2026-10-14 (incident C4): "busy for a few seconds" is a state of a 200 answer, so the console stays clean; the
// adapter still waits exactly as it does after a refusal.
// Rewritten on purpose 2026-10-14 (incident C3): the wait was the whole receipt lane's (another hash asked nothing during
// it); it is now that question's alone, and another hash asks on its own.
// Rewritten on purpose again 2026-10-14 (C3 review): the background's wait is its whole lane's again, as before C3; the
// money client's own read asks once on its own, then rests on its hash.
test('a busy edge is a wait like a refusal’s: the adapter rests that lane for the wait it names and asks nothing of it meanwhile; a chain the edge does not read says so', async () => {
  const busy = adapter(body => good({ v: 2, state: 'busy', retryAfterMs: body.finality ? 3000 : 8000 }))
  await assert.rejects(busy.reader.read(HASH), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 8000)
  await assert.rejects(busy.reader.read(OTHER), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 8000)
  assert.equal(busy.calls.length, 1, 'no question of the background during the wait')
  await assert.rejects(busy.reader.read(HASH, FG), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 8000)
  await assert.rejects(busy.reader.read(HASH, FG), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 8000)
  assert.equal(busy.calls.length, 2, 'the money client’s read asks once, then rests on its hash')
  await assert.rejects(busy.reader.finalized(), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 3000)
  assert.equal(busy.calls.length, 3, 'the finalized block has a lane of its own')
  busy.advance(8001)
  await assert.rejects(busy.reader.read(HASH), error => error.retryAfterMs === 8000)
  assert.equal(busy.calls.filter(call => call.body.hash).length, 3)
  // A wait it cannot read is the rate refusal's own; one past the longest is cut to it.
  for (const [named, expected] of [[undefined, edgeClient.RATE_RETRY_MS], [-1, edgeClient.RATE_RETRY_MS], ['8000', edgeClient.RATE_RETRY_MS], [Number.NaN, edgeClient.RATE_RETRY_MS], [1e12, edgeClient.MAX_RETRY_MS], [1500, 1500]]) {
    await assert.rejects(adapter(() => good({ v: 2, state: 'busy', retryAfterMs: named })).reader.read(HASH), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === expected)
  }
  const elsewhere = adapter(() => good({ v: 2, state: 'not_served' }))
  await assert.rejects(elsewhere.reader.read(HASH), { message: 'confirmation_not_served' })
  await assert.rejects(elsewhere.reader.finalized(), { message: 'confirmation_not_served' })
})

// Added 2026-10-14 (C4 review, version skew): a tab with this page that meets an edge from before the second shape (a
// rollback, or the seconds a deploy takes to reach every data centre) is refused there with a 400, which read as a failed
// read with no wait. The tab asks that question once more in the first shape and keeps to it: one request more, once,
// and nothing more of the node (the old edge refuses the second shape before it asks the node anything).
test('a tab that meets an edge from before the second shape asks once more in the first shape and keeps to it', async () => {
  let included = false
  const oldEdge = (body) => {
    if ('v' in body) return { ok: false, failure: 'bad_request', retryAfterMs: 0 }
    if (body.finality) return good({ v: 1, finalized: BLOCK })
    return good(included ? { v: 1, transaction: transaction(), receipt: receipt(), block: BLOCK } : { v: 1, transaction: null, receipt: null, block: null })
  }
  const shapes = client => client.calls.map(call => JSON.stringify(call.body))
  const tab = adapter(oldEdge)
  assert.deepEqual(await tab.reader.read(HASH), { transaction: null, receipt: null, block: null })
  assert.deepEqual(shapes(tab), [JSON.stringify({ v: 2, chainId: 4663, hash: HASH }), JSON.stringify({ hash: HASH })])
  assert.equal(tab.calls[1].options.signal, tab.calls[0].options.signal, 'within the same question and its own time-out')
  included = true
  assert.deepEqual(await tab.reader.read(HASH), { transaction: transaction(), receipt: receipt(), block: BLOCK })
  assert.deepEqual(await tab.reader.finalized(), BLOCK)
  assert.deepEqual(shapes(tab).slice(2), [JSON.stringify({ hash: HASH }), JSON.stringify({ finality: true })], 'the tab keeps to the first shape')
  // The first question may be the finalized block's: the same, within its 2 s.
  const first = adapter(oldEdge)
  assert.deepEqual(await first.reader.finalized(), BLOCK)
  assert.deepEqual(shapes(first), [JSON.stringify({ v: 2, chainId: 4663, finality: true }), JSON.stringify({ finality: true })])
  // That edge's resting node is its 429, and the lane rests as it always did; its answers are checked as the second's.
  // Rewritten on purpose 2026-10-14 (incident C3): the rest is that hash's own (it was every receipt's); another asks.
  // Rewritten on purpose again 2026-10-14 (C3 review): the background's rest is its lane's again, as before C3; the money
  // client's own read of another hash asks on its own, in the first shape.
  let refusing = true
  const resting = adapter(body => ('v' in body ? { ok: false, failure: 'bad_request', retryAfterMs: 0 } : refusing ? { ok: false, failure: 'rate_limited', retryAfterMs: 7000 } : good({ v: 1, transaction: null })))
  await assert.rejects(resting.reader.read(HASH), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 7000)
  await assert.rejects(resting.reader.read(OTHER), error => error.retryAfterMs === 7000)
  assert.equal(resting.calls.length, 2, 'no question during the wait')
  await assert.rejects(resting.reader.read(OTHER, FG), error => error.retryAfterMs === 7000)
  assert.deepEqual(shapes(resting).slice(2), [JSON.stringify({ hash: OTHER })], 'the money client’s own read asks on its own, in the first shape')
  refusing = false; resting.advance(7001)
  await assert.rejects(resting.reader.read(HASH), { message: 'invalid_confirmation' })
  for (const value of [{ v: 2, state: 'pending', transaction: null, receipt: null, block: null }, { v: 1, error: 'rate_limited' }, { v: 1, finalized: BLOCK }]) {
    await assert.rejects(adapter(body => ('v' in body ? { ok: false, failure: 'bad_request', retryAfterMs: 0 } : good(value))).reader.read(HASH), { message: 'invalid_confirmation' }, JSON.stringify(value))
  }
  await assert.rejects(adapter(body => ('v' in body ? { ok: false, failure: 'bad_request', retryAfterMs: 0 } : good({ v: 1, transaction: null, receipt: null, block: null }))).reader.finalized(), { message: 'invalid_confirmation' })
  // An edge that refuses both shapes: one request more, once for the tab, never a loop. (2026-10-14, incident C3: a
  // failure that names no wait now rests its question a second, so the second read comes after it.)
  const refused = adapter(() => ({ ok: false, failure: 'bad_request', retryAfterMs: 0 }))
  await assert.rejects(refused.reader.read(HASH), { message: 'confirmation_unavailable' })
  refused.advance(1001)
  await assert.rejects(refused.reader.read(HASH), { message: 'confirmation_unavailable' })
  assert.deepEqual(shapes(refused), [JSON.stringify({ v: 2, chainId: 4663, hash: HASH }), JSON.stringify({ hash: HASH }), JSON.stringify({ hash: HASH })])
  // The edge of today answers the second shape: a tab never leaves it for any other failure.
  const today = adapter(() => ({ ok: false, failure: 'unavailable', retryAfterMs: 0 }))
  await assert.rejects(today.reader.read(HASH), { message: 'confirmation_unavailable' })
  today.advance(1001)
  await assert.rejects(today.reader.read(HASH), { message: 'confirmation_unavailable' })
  assert.ok(today.calls.every(call => call.body.v === 2))
  assert.equal(today.calls.length, 2)
})

test('the adapter validates its envelope, caps concurrent receipts, and aborts its finality timeout', async () => {
  // Rewritten on purpose 2026-10-14 (incident C4): the envelope is the second shape's; the first shape's answer is refused.
  for (const value of [null, [], { v: 1, transaction: null, receipt: null, block: null }, { v: 2 }, { v: 2, state: 'pending' }, { v: 2, state: 'included', transaction: null }, { v: 2, state: 'included', transaction: null, receipt: null },
    { v: 2, state: 'final', transaction: null, receipt: null, block: null }, { v: 2, transaction: null, receipt: null, block: null }, { v: 2, finalized: BLOCK }]) {
    await assert.rejects(adapter(() => good(value)).reader.read(HASH), { message: 'invalid_confirmation' })
  }
  for (const value of [null, [], { v: 1, finalized: BLOCK }, { v: 2 }, { v: 2, state: 'pending', transaction: null, receipt: null, block: null }]) {
    await assert.rejects(adapter(() => good(value)).reader.finalized(), { message: 'invalid_confirmation' })
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

// Added 2026-10-14 (incident C3: waiting never locks). The tab's "not before" time was one for every receipt: a refusal
// met by the background confirmation queue for an old receipt made a just-sent transaction's read fail with no request,
// and New position, Add, Change range or Withdraw locked with "Sent to your wallet…". Now each question rests on its own,
// a failure that names no wait backs off, the money client's own reads are a lane the background cannot rest, and after
// two missed reads the person's own wallet is asked (the owner's decision D2).
// Changed on purpose 2026-10-14 (C3 review: never more requests of the site's node than before): the hashes that rest on
// their own are the money client's (the foreground); the background queue's reads rest as one lane, as before C3, so the
// up to four reads it makes a pass cannot each meet the same outage. The backoff is that lane's.
test('each hash of the money client rests on its own, the background rests as one: one hash refused never refuses another foreground read, and a failure that names no wait backs off 1, 2, 4 … 60 s', async () => {
  const failing = new Set([HASH])
  const edge = adapter(body => body.hash && failing.has(body.hash) ? { ok: false, failure: 'unavailable', retryAfterMs: 0 } : good())
  const waits = []
  for (let i = 0; i < 8; i++) {
    await assert.rejects(edge.reader.read(HASH, FG), error => (waits.push(error.retryAfterMs), error.message === 'confirmation_unavailable'))
    // During the wait that hash asks nothing, and another hash is answered.
    await assert.rejects(edge.reader.read(HASH, FG), error => error.retryAfterMs === waits.at(-1))
    assert.deepEqual(await edge.reader.read(OTHER, FG), { transaction: null, receipt: null, block: null })
    edge.advance(waits.at(-1) + 1)
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
  assert.equal(edge.calls.filter(call => call.body.hash === HASH).length, 8, 'one question a wait, never one more')
  // A good answer ends the backoff: the next failure rests one second again.
  failing.delete(HASH)
  assert.deepEqual(await edge.reader.read(HASH, FG), { transaction: null, receipt: null, block: null })
  failing.add(HASH)
  await assert.rejects(edge.reader.read(HASH, FG), error => error.retryAfterMs === 1000)
  // The background: one failure rests every queue read, with the lane's own backoff; any good answer ends it.
  const queue = adapter(body => body.hash === HASH ? { ok: false, failure: 'unavailable', retryAfterMs: 0 } : good())
  await assert.rejects(queue.reader.read(HASH), error => error.retryAfterMs === 1000)
  await assert.rejects(queue.reader.read(OTHER), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 1000)
  assert.equal(queue.calls.length, 1, 'one request for the whole lane during its wait')
  queue.advance(1001)
  await assert.rejects(queue.reader.read(HASH), error => error.retryAfterMs === 2000)
  queue.advance(2001)
  assert.deepEqual(await queue.reader.read(OTHER), { transaction: null, receipt: null, block: null })
  await assert.rejects(queue.reader.read(HASH), error => error.retryAfterMs === 1000)
  assert.equal(queue.calls.length, 4)
  // A named wait longer than the backoff stands; a shorter one is lifted to it.
  const named = adapter(() => ({ ok: false, failure: 'rate_limited', retryAfterMs: 1500 }))
  await assert.rejects(named.reader.read(HASH), error => error.retryAfterMs === 1500)
  named.advance(1501)
  await assert.rejects(named.reader.read(HASH), error => error.retryAfterMs === 2000)
})

// Changed on purpose 2026-10-14 (C3 review): the lane is the caller's word (`foreground`), not the presence of a second
// source: with the owner's D2 switch off the money client's reads went back into the background. A foreground refusal
// rests the background too, and one hash asked in both lanes at once is one request, as when the lanes were one.
test('the money client’s own read is a lane of its own: a background refusal does not rest it, the cap on reads in flight is the background’s, and the lane is the caller’s word', async () => {
  let refuse = true
  const edge = adapter(() => refuse ? { ok: false, failure: 'rate_limited', retryAfterMs: 30_000 } : good())
  const second = async () => { throw new Error('the second source is not asked on a first miss') }
  await assert.rejects(edge.reader.read(HASH), error => error.retryAfterMs === 30_000)
  refuse = false
  assert.deepEqual(await edge.reader.read(HASH, { foreground: true, second }), { transaction: null, receipt: null, block: null }, 'the queue’s rest is not the money client’s')
  assert.equal(edge.calls.length, 2)
  await assert.rejects(edge.reader.read(HASH), error => error.retryAfterMs === 30_000, 'and the background still rests')
  // No second source (the owner's D2 switch off): still the foreground's.
  assert.deepEqual(await edge.reader.read(OTHER, FG), { transaction: null, receipt: null, block: null })
  assert.equal(edge.calls.length, 3)
  // What the node refused the money client's read, the queue does not ask meanwhile; another foreground hash still asks.
  const fore = adapter(body => body.hash === HASH ? { ok: false, failure: 'rate_limited', retryAfterMs: 20_000 } : good())
  await assert.rejects(fore.reader.read(HASH, FG), error => error.retryAfterMs === 20_000)
  await assert.rejects(fore.reader.read(OTHER), error => error.message === 'confirmation_unavailable' && error.retryAfterMs === 20_000)
  assert.deepEqual(await fore.reader.read(OTHER, FG), { transaction: null, receipt: null, block: null })
  assert.equal(fore.calls.length, 2)
  // One hash asked by the queue and by the money client at once: one request, one answer for both.
  let finish
  const both = adapter(() => new Promise(resolve => { finish = resolve }))
  const queued = both.reader.read(HASH), own = both.reader.read(HASH, FG)
  assert.equal(both.calls.length, 1)
  finish(good())
  assert.deepEqual(await Promise.all([queued, own]), [{ transaction: null, receipt: null, block: null }, { transaction: null, receipt: null, block: null }])
  // Thirty-two background reads hanging: the background is refused, the money client's read still asks.
  const held = adapter(body => body.hash === OTHER ? good() : new Promise(() => {}))
  for (let i = 0; i < 32; i++) void held.reader.read(`0x${i.toString(16).padStart(64, '0')}`).catch(() => undefined)
  await assert.rejects(held.reader.read(`0x${'99'.repeat(32)}`), { message: 'confirmation_busy' })
  assert.deepEqual(await held.reader.read(OTHER, { foreground: true, second }), { transaction: null, receipt: null, block: null })
  assert.equal(held.calls.length, 33)
})

test('after two missed reads in a row the second source answers in the same read; one miss never asks it; its failure is the read’s; the queue never asks it', async () => {
  let edgeUp = false
  const edge = adapter(() => edgeUp ? good({ v: 2, state: 'included', transaction: transaction(), receipt: receipt(), block: BLOCK }) : { ok: false, failure: 'unavailable', retryAfterMs: 0 })
  const asked = []
  let wallet = 'answers'
  const second = async () => {
    asked.push(wallet)
    if (wallet !== 'answers') throw new Error('wallet_wrong_chain')
    return { transaction: transaction(), receipt: receipt(), block: BLOCK }
  }
  await assert.rejects(edge.reader.read(HASH, { foreground: true, second }), { message: 'confirmation_unavailable' })
  assert.equal(asked.length, 0, 'one missed read never asks the wallet')
  // Second miss: the edge is still resting (no request), so the wallet answers in this same read.
  assert.deepEqual(await edge.reader.read(HASH, { foreground: true, second }), { transaction: transaction(), receipt: receipt(), block: BLOCK })
  assert.deepEqual([asked.length, edge.calls.length], [1, 1])
  // The wallet on another chain: that read fails with the wallet's word, and the caller asks again.
  wallet = 'elsewhere'
  await assert.rejects(edge.reader.read(HASH, { foreground: true, second }), { message: 'wallet_wrong_chain' })
  // Once the edge answers again, it is asked first and the count starts over.
  edgeUp = true; edge.advance(60_001); wallet = 'answers'
  assert.equal((await edge.reader.read(HASH, { foreground: true, second })).block, BLOCK)
  assert.equal(asked.length, 2, 'not asked while the edge answers')
  edgeUp = false; edge.advance(60_001)
  await assert.rejects(edge.reader.read(HASH, { foreground: true, second }), { message: 'confirmation_unavailable' })
  assert.equal(asked.length, 2)
  // The background queue's reads have no second source: they only miss.
  const queue = adapter(() => ({ ok: false, failure: 'unavailable', retryAfterMs: 0 }))
  for (let i = 0; i < 3; i++) { await assert.rejects(queue.reader.read(HASH), { message: 'confirmation_unavailable' }); queue.advance(60_001) }
})

test('the Robinhood transactor asks the person’s wallet, read-only, only after two missed reads; a wallet elsewhere is a failed read; its answer meets every check', async () => {
  let edgeUp = false
  const page = adapter(() => edgeUp ? good({ v: 2, state: 'pending', transaction: null, receipt: null, block: null }) : { ok: false, failure: 'unavailable', retryAfterMs: 0 })
  const calls = []
  let chainId = 4663, tx = transaction()
  const wallet = { owner: OWNER, current: () => true, chainId: () => chainId, confirmation: page.reader,
    request: async (method, params) => {
      calls.push(method)
      if (method === 'eth_accounts') return [OWNER]
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (method === 'eth_getTransactionByHash') return params[0] === HASH ? tx : null
      if (method === 'eth_getTransactionReceipt') return receipt()
      if (method === 'eth_getBlockByNumber' && params[0] === BLOCK.number) return BLOCK
      throw new Error(`Unexpected wallet call: ${method}`)
    } }
  const client = createTransactor(wallet, { chainId: 4663, l1FeeInReceipt: false }, () => 1000, () => {})
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'confirmation_unavailable' })
  assert.deepEqual(calls, [], 'one missed read never reaches the wallet')
  const found = await client.receipt(HASH, reviewed)
  assert.equal(found.state, 'included', 'the edge’s finalized block unavailable: included, never final')
  assert.deepEqual([found.blockHash, found.blockNumber], [BLOCK.hash, 16n])
  assert.deepEqual(calls, ['eth_accounts', 'eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'], 'reads only, this owner on this chain')
  // The wallet's answer is checked as the edge's: another transaction under that hash is refused.
  tx = transaction({ input: '0x9999' })
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'transaction_does_not_match_review' })
  // A wallet on another chain: the read fails (asked again by the caller), and nothing is asked of it.
  tx = transaction(); chainId = 8453; calls.length = 0
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'wallet_wrong_chain' })
  assert.deepEqual(calls, [])
  // The edge back: asked first, the wallet left alone.
  chainId = 4663; edgeUp = true; page.advance(60_001)
  assert.equal((await client.receipt(HASH, reviewed)).state, 'pending')
  assert.deepEqual(calls, [])
})

// Added 2026-10-14 (C3 review). The wallet's answer was joined to the site's node's finalized block: transaction, receipt
// and block hash from one node, the finalized height from another, and a release that waits for finality could run on
// that. It is at most "included" now. And the second source took the client's one-operation lock for up to 5 s: a
// settlement's read in the background met the person's press with "wallet_action_busy". It has its own port now.
test('the person’s wallet as second source: its answer is at most included, and it never takes nor meets the client’s one-operation lock', async () => {
  let edgeUp = false
  const page = adapter(body => body.finality ? good({ v: 2, finalized: { number: '0x20', hash: OTHER } })
    : edgeUp ? good({ v: 2, state: 'included', transaction: transaction(), receipt: receipt(), block: BLOCK }) : { ok: false, failure: 'unavailable', retryAfterMs: 0 })
  let hold = null, held = false
  const wallet = { owner: OWNER, current: () => true, chainId: () => 4663, confirmation: page.reader,
    request: async (method, params) => {
      if (method === 'eth_accounts') return [OWNER]
      if (method === 'eth_chainId') return '0x1237'
      if (method === 'eth_getTransactionByHash') { if (hold) { held = true; await hold } return params[0] === HASH ? transaction() : null }
      if (method === 'eth_getTransactionReceipt') return receipt()
      if (method === 'eth_getBlockByNumber' && params[0] === BLOCK.number) return BLOCK
      throw new Error(`Unexpected wallet call: ${method}`)
    } }
  const client = createTransactor(wallet, { chainId: 4663, l1FeeInReceipt: false }, () => 1000, () => {})
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'confirmation_unavailable' })
  // The person's press holds the client's lock (a send waiting in the wallet) while a settlement reads in the background.
  let release
  const pressed = client.bounded(() => new Promise(resolve => { release = resolve }))
  const read = await client.receipt(HASH, reviewed)
  assert.equal(read.state, 'included', 'the wallet’s answer with the node’s finalized block past it: included, never final')
  // The edge's own answer with that finalized block is final, as before.
  edgeUp = true; page.advance(60_001)
  assert.equal((await client.receipt(HASH, reviewed)).state, 'finalized')
  release('sent'); assert.equal(await pressed, 'sent')
  // And the other way: the wallet still reading for a settlement, the person's press goes through.
  edgeUp = false; page.advance(60_001)
  await assert.rejects(client.receipt(HASH, reviewed), { message: 'confirmation_unavailable' })
  let answer
  hold = new Promise(resolve => { answer = resolve })
  const background = client.receipt(HASH, reviewed)
  for (let i = 0; i < 50 && !held; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(held, true, 'the wallet is reading for the settlement')
  assert.equal(await client.bounded(async () => 'pressed'), 'pressed')
  answer()
  assert.equal((await background).state, 'included')
})
