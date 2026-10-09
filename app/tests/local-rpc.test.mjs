/**
 * Domino's own Robinhood Chain node from the edge (functions/_lib/localRpc.ts, RPC-SPEC §2.3 and §2.10): the secret's
 * exact shape, the chain id check, the allowlist of fixed reads, the log windows and their merged answers, the batch
 * and byte caps, the invocation's POST budget, the isolate's bucket, rests, downs and refusals, the time-out, and the
 * token in no answer, header, error or log line. Over a fake upstream; nothing reaches the network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { nodeLogError } from './support/log-limits.mjs';
import { SITE_WIDE } from '../../bridge/src/wide-gate-worker.mjs';

const require = createRequire(import.meta.url);
const local = require('../.test-build/app/functions/_lib/localRpc.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');
const fees = require('../.test-build/app/functions/_lib/fees.js');
// Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees replay's price path (feesPath.ts) is gone; the vault record's
// event is its module's own, and the ledger's two engine events are the ledger's.
const vaultRecord = require('../.test-build/app/functions/_lib/vaultRecord.js');
const ledger = require('../.test-build/app/functions/_lib/feesLedger.js');
const simulateRoute = require('../.test-build/app/functions/_lib/simulate.js');

/** A distinctive token, so a leak of it anywhere is found. */
const TOKEN = 'Zq7-leak-canary_0123456789abcdefXYZ';
const ENDPOINT = `https://rpc.domino.money/${TOKEN}/`;
const RPC = owned.RPC_URL;
const MULTICALL = owned.MULTICALL3;
const AGGREGATE = `0x${owned.SELECTOR.aggregate3}`;
const SETUP = owned.SETUP_CONTRACT;
const OWNER_TOPIC = `0x${'0'.repeat(24)}f6184f814543b88dd867c34ce6e9f56ab7d18c0a`;
const POOL = `0x${'ab'.repeat(32)}`;
const W = local.LOCAL_RPC_LOG_BLOCKS;
/** A pool's own history, which no route may ask Domino's node for (rugged97's rule 2, 2026-10-02). */
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const TOKEN_A = `0x${'01'.repeat(20)}`;
const TOKEN_B = `0x${'02'.repeat(20)}`;
const ID_WORD = `0x${'0'.repeat(63)}7`;

const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const hex = (n) => `0x${n.toString(16)}`;
const envelope = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const body = (value) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const logsFilter = (from, to, patch = {}) => ({ address: SETUP, fromBlock: hex(from), toBlock: hex(to), topics: [owned.SETUP_MINTED_TOPIC, null, OWNER_TOPIC], ...patch });

/**
 * A fake node: answers eth_chainId with `chainId`, and every other call with `answer(call)` ({ result } or { error });
 * `reply(posted)` may answer a whole POST instead (a Response). Records every POST.
 */
function node({ chainId = '0x1237', answer = () => ({ result: [] }), reply = null } = {}) {
  const posts = [];
  const upstream = async (url, init) => {
    const parsed = JSON.parse(init.body);
    const posted = { url, init, body: parsed, calls: Array.isArray(parsed) ? parsed : [parsed] };
    posts.push(posted);
    const own = reply?.(posted, posts.length);
    if (own) return own;
    const replies = posted.calls.map((call) => ({ jsonrpc: '2.0', id: call.id, ...(call.method === 'eth_chainId' ? { result: chainId } : answer(call)) }));
    return json(Array.isArray(parsed) ? replies : replies[0]);
  };
  return { upstream, posts, calls: () => posts.filter((post) => post.calls[0].method !== 'eth_chainId') };
}

/** A clock the bucket's waits move, and a transport over `fake` in an isolate of its own. */
function setup(fake, { purpose = 'owned', memory = local.localRpcMemory(), clock = { time: 1_000_000 }, timeoutMs, log = [] } = {}) {
  const now = () => clock.time;
  const slept = [];
  const sleep = async (ms) => {
    slept.push(ms);
    clock.time += ms;
  };
  const make = (more = {}) => local.createLocalRpc(ENDPOINT, { purpose, upstream: fake.upstream, now, sleep, memory, timeoutMs, log: (line) => log.push(line), ...more });
  return { rpc: make(), make, clock, memory, slept, log };
}

const refused = (promise) => assert.rejects(promise, (error) => error instanceof TypeError && error.message === 'local_rpc_refused_method');

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

test('the secret is exactly https://rpc.domino.money/ and one token-shaped segment; anything else is missing', () => {
  const ok = (value, expected) => assert.equal(local.localRpcEndpoint({ LOCAL_RPC_URL: value }), expected, value);
  ok(`https://rpc.domino.money/${TOKEN}/`, ENDPOINT);
  ok(`https://rpc.domino.money/${TOKEN}`, ENDPOINT, 'a trailing slash is added');
  ok('https://RPC.Domino.Money/abcdefghijklmnop', 'https://rpc.domino.money/abcdefghijklmnop/');
  ok('https://rpc.domino.money:443/abcdefghijklmnop/', 'https://rpc.domino.money/abcdefghijklmnop/');
  for (const value of [
    undefined,
    '',
    'http://rpc.domino.money/abcdefghijklmnop/',
    'https://rpc.domino.money/',
    'https://rpc.domino.money/short/',
    `https://rpc.domino.money/${'a'.repeat(257)}/`,
    'https://rpc.domino.money/abcdefghijklmnop/extra/',
    'https://rpc.domino.money/abcdefgh.ijklmnop/',
    'https://rpc.domino.money/abcdefghijklmnop/?x=1',
    'https://rpc.domino.money/abcdefghijklmnop/?',
    'https://rpc.domino.money/abcdefghijklmnop/#x',
    'https://rpc.domino.money:8443/abcdefghijklmnop/',
    // Split so the repository's credential check (scripts/check-repository.py) does not read it as one.
    'https://' + 'user:pass@rpc.domino.money/abcdefghijklmnop/',
    'https://evil.example/abcdefghijklmnop/',
    'https://rpc.domino.money.evil.example/abcdefghijklmnop/',
    'https://ws.domino.money/abcdefghijklmnop/',
    'https://rpc.mainnet.chain.robinhood.com',
    'not a url',
  ]) {
    assert.equal(local.localRpcEndpoint({ LOCAL_RPC_URL: value }), null, String(value));
  }
  assert.equal(local.localRpcEndpoint({}), null, 'no secret');
  assert.equal(local.LOCAL_RPC_HOST, 'rpc.domino.money');
});

// ---------------------------------------------------------------------------
// The chain id
// ---------------------------------------------------------------------------

test('the chain id is checked once per isolate and its life; another chain stops every read for that life', async () => {
  const fake = node({ answer: () => ({ result: '0x10' }) });
  const { make, clock, memory, log } = setup(fake);
  const ask = (rpc) => rpc.fetch(RPC, body(envelope('eth_blockNumber', [])));
  assert.equal(await (await ask(make())).json().then((reply) => reply.result), '0x10');
  await ask(make());
  assert.deepEqual(fake.posts.map((post) => post.calls[0].method), ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber'], 'one check for two invocations');
  clock.time += local.LOCAL_RPC_TRUST_MS;
  await ask(make());
  assert.equal(fake.posts.at(-2).calls[0].method, 'eth_chainId', 'asked again after its life');

  const other = node({ chainId: '0x1' });
  const wrong = setup(other);
  await assert.rejects(ask(wrong.rpc), { message: 'local_rpc_wrong_chain' });
  assert.equal(wrong.rpc.health(), 'wrong_chain');
  assert.deepEqual(wrong.log.map((line) => JSON.parse(line).event), ['local_rpc_wrong_chain']);
  await assert.rejects(ask(wrong.make()), { message: 'local_rpc_wrong_chain' });
  assert.equal(other.posts.length, 1, 'nothing is asked of a node on another chain');
  wrong.clock.time += local.LOCAL_RPC_TRUST_MS;
  assert.equal(wrong.make().health(), 'ok');
  assert.equal(memory.trustedUntil > 0, true);
  assert.equal(log.length, 0);
});

test('a check that fails is not trusted, and is asked again next time; concurrent invocations share one check', async () => {
  let refuse = true;
  const fake = node({ reply: (posted) => (refuse && posted.calls[0].method === 'eth_chainId' ? json({}, 429) : null) });
  const { make, clock } = setup(fake);
  const first = await make().fetch(RPC, body(envelope('eth_blockNumber', [])));
  assert.equal(first.status, 429, 'the node’s refusal, for the chain code to wait out');
  refuse = false;
  clock.time += 60_000;
  const rpc = make();
  const [a, b] = await Promise.all([rpc.fetch(RPC, body(envelope('eth_blockNumber', [], 1))), make().fetch(RPC, body(envelope('eth_blockNumber', [], 2)))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(fake.posts.filter((post) => post.calls[0].method === 'eth_chainId').length, 2, 'the refused check, then one shared check');
});

test('one caller dropping its read during the shared check does not fail the others’', async () => {
  let release;
  const held = new Promise((done) => (release = done));
  const fake = node({ answer: () => ({ result: '0x7' }), reply: (posted) => (posted.calls[0].method === 'eth_chainId' ? held.then(() => json({ jsonrpc: '2.0', id: 0, result: '0x1237' })) : null) });
  const { make } = setup(fake);
  const controller = new AbortController();
  const dropped = make().fetch(RPC, { ...body(envelope('eth_blockNumber', [], 1)), signal: controller.signal });
  const kept = make().fetch(RPC, body(envelope('eth_blockNumber', [], 2)));
  controller.abort(new DOMException('dropped', 'AbortError'));
  release();
  await assert.rejects(dropped, (error) => error.name === 'AbortError');
  assert.equal((await (await kept).json()).result, '0x7');
  assert.equal(fake.posts.filter((post) => post.calls[0].method === 'eth_chainId').length, 1);
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test('only the chain code’s fixed name is asked; any other URL is refused before anything is sent', async () => {
  const fake = node();
  const { rpc } = setup(fake);
  for (const url of [ENDPOINT, 'https://rpc.mainnet.chain.robinhood.com/', 'https://robinhood.drpc.org']) {
    await assert.rejects(rpc.fetch(url, body(envelope('eth_blockNumber', []))), { message: 'not the chain RPC' });
  }
  assert.equal(fake.posts.length, 0);
});

test('every envelope must be one of the fixed reads its purpose makes; one that is not refuses the whole call before anything is sent', async () => {
  const fake = node();
  const call = (data = `${AGGREGATE}${'00'.repeat(64)}`, block = 'latest') => envelope('eth_call', [{ to: MULTICALL, data }, block]);
  const cases = [
    ['owned', 'not JSON', '{"jsonrpc":'],
    ['owned', 'an empty batch', []],
    ['owned', 'a batch past 200', Array.from({ length: 201 }, (_, id) => envelope('eth_blockNumber', [], id))],
    ['owned', 'duplicate ids', [envelope('eth_blockNumber', [], 1), envelope('eth_blockNumber', [], 1)]],
    ['owned', 'an extra key', { ...envelope('eth_blockNumber', []), extra: 1 }],
    ['owned', 'another jsonrpc', { ...envelope('eth_blockNumber', []), jsonrpc: '1.0' }],
    ['owned', 'a string id', { ...envelope('eth_blockNumber', []), id: '1' }],
    ['owned', 'eth_blockNumber with params', envelope('eth_blockNumber', ['latest'])],
    ['owned', 'a write', envelope('eth_sendRawTransaction', ['0x00'])],
    ['owned', 'eth_chainId from the caller', envelope('eth_chainId', [])],
    ['owned', 'eth_getBalance', envelope('eth_getBalance', [SETUP, 'latest'])],
    ['owned', 'eth_getCode', envelope('eth_getCode', [SETUP, 'latest'])],
    ['owned', 'eth_estimateGas', envelope('eth_estimateGas', [{ to: MULTICALL, data: AGGREGATE }])],
    ['owned', 'eth_call to another contract', envelope('eth_call', [{ to: SETUP, data: AGGREGATE }, 'latest'])],
    ['owned', 'eth_call to Multicall3 checksummed', envelope('eth_call', [{ to: '0xcA11bde05977b3631167028862bE2a173976CA11', data: AGGREGATE }, 'latest'])],
    ['owned', 'eth_call of another selector', call('0x252dba42')],
    ['owned', 'eth_call with a from', envelope('eth_call', [{ from: SETUP, to: MULTICALL, data: AGGREGATE }, 'latest'])],
    ['owned', 'eth_call with a state override', envelope('eth_call', [{ to: MULTICALL, data: AGGREGATE }, 'latest', { [SETUP]: { code: '0x00' } }])],
    ['owned', 'eth_call at a tag', call(undefined, 'pending')],
    ['owned', 'eth_call at a padded number', call(undefined, '0x01')],
    ['owned', 'eth_call with odd data', call(`${AGGREGATE}0`)],
    ['owned', 'logs of an uppercase address', envelope('eth_getLogs', [logsFilter(1, 2, { address: SETUP.toUpperCase().replace('0X', '0x') })])],
    ['owned', 'logs of nine addresses', envelope('eth_getLogs', [logsFilter(1, 2, { address: Array.from({ length: 9 }, () => SETUP) })])],
    ['owned', 'logs backwards', envelope('eth_getLogs', [logsFilter(5, 4)])],
    ['owned', 'logs by block hash', envelope('eth_getLogs', [{ address: SETUP, blockHash: POOL, topics: [owned.SETUP_MINTED_TOPIC] }])],
    ['owned', 'logs with a blockHash too', envelope('eth_getLogs', [{ ...logsFilter(1, 2), blockHash: POOL }])],
    ['owned', 'logs with no topic0', envelope('eth_getLogs', [logsFilter(1, 2, { topics: [null, null, OWNER_TOPIC] })])],
    ['owned', 'logs of another event', envelope('eth_getLogs', [logsFilter(1, 2, { topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'] })])],
    ['owned', 'logs with an unknown event among allowed ones', envelope('eth_getLogs', [logsFilter(1, 2, { topics: [[SWAP, POOL]] })])],
    ['owned', 'logs with a malformed topic', envelope('eth_getLogs', [logsFilter(1, 2, { topics: [owned.SETUP_MINTED_TOPIC, '0x12'] })])],
    ['owned', 'logs with five topics', envelope('eth_getLogs', [logsFilter(1, 2, { topics: [owned.SETUP_MINTED_TOPIC, null, null, null, null] })])],
    ['owned', 'logs as a quantity tag', envelope('eth_getLogs', [logsFilter(1, 2, { toBlock: 'latest' })])],
    ['ledger', 'a header with transactions', envelope('eth_getBlockByNumber', ['0x10', true])],
    ['ledger', 'a header by tag', envelope('eth_getBlockByNumber', ['latest', false])],
    ['ledger', 'eth_blockNumber under ledger', envelope('eth_blockNumber', [])],
    // Swap is admitted only as an exact-pool, one-block opening anchor under ledger, never a history scan.
    ['ledger', 'a pool’s swaps across two blocks', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_001), topics: [SWAP, POOL] }])],
    ['owned', 'a Swap under another purpose', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, POOL] }])],
    ['ledger', 'a Swap at another contract', envelope('eth_getLogs', [{ address: TOKEN_A, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, POOL] }])],
    ['ledger', 'a Swap wildcard pool', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, null] }])],
    ['ledger', 'a Swap pool list', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, [POOL]] }])],
    ['ledger', 'a Swap address list', envelope('eth_getLogs', [{ address: [fees.POOL_MANAGER], fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, POOL] }])],
    ['ledger', 'a Swap event list', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [[SWAP], POOL] }])],
    ['ledger', 'a Swap narrowed to a sender omits later swaps', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, POOL, OWNER_TOPIC] }])],
    ['ledger', 'a pool’s Initialize', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [INITIALIZE, POOL] }])],
    ['ledger', 'the PoolManager’s ModifyLiquidity over two blocks', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_001), topics: [fees.TOPIC.ModifyLiquidity, POOL] }])],
    ['ledger', 'the PoolManager in a list, over two blocks', envelope('eth_getLogs', [{ address: [TOKEN_A, fees.POOL_MANAGER], fromBlock: hex(70_000_000), toBlock: hex(70_000_001), topics: [fees.TOPIC.Transfer] }])],
    ['state', 'logs under state', envelope('eth_getLogs', [logsFilter(1, 2)])],
    // Changed on purpose 2026-10-02 (review of the rules, finding 16): the record asks the factory (eth_call), never a block.
    ['record', 'a block under record', envelope('eth_getBlockByNumber', ['0x10', false])],
    ['owned', 'a simulation under owned', envelope('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: SETUP, to: SETUP, data: '0x', value: '0x0' }] }], validation: false }, 'latest'])],
  ];
  for (const [purpose, label, value] of cases) {
    const { rpc } = setup(fake, { purpose });
    await refused(rpc.fetch(RPC, { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value) })).catch((error) => assert.fail(`${purpose}: ${label}: ${error.message}`));
  }
  // Changed on purpose 2026-10-02 (review of the rules, finding 15): each call names its share of the gas, and none is to
  // Multicall3.
  const gas = (count) => hex(simulateRoute.simulateGas(count));
  const simulate = (patch = {}, calls = [{ from: SETUP, to: SETUP, data: '0x12', value: '0x0', gas: gas(1) }]) => envelope('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false, ...patch }, 'latest']);
  for (const [label, value] of [
    ['validation on', simulate({ validation: true })],
    ['state overrides', simulate({ blockStateCalls: [{ calls: [{ from: SETUP, to: SETUP, data: '0x', value: '0x0' }], stateOverrides: {} }] })],
    ['two blocks', simulate({ blockStateCalls: [{ calls: [{ from: SETUP, to: SETUP, data: '0x', value: '0x0' }] }, { calls: [] }] })],
    ['two senders', simulate({}, [{ from: SETUP, to: SETUP, data: '0x', value: '0x0', gas: gas(2) }, { from: MULTICALL, to: SETUP, data: '0x', value: '0x0', gas: gas(2) }])],
    // Changed on purpose 2026-10-02 (review finding 17): up to twelve calls (Create position's largest batch is ten).
    ['thirteen calls', simulate({}, Array.from({ length: 13 }, () => ({ from: SETUP, to: SETUP, data: '0x', value: '0x0', gas: gas(13) })))],
    ['no gas', simulate({}, [{ from: SETUP, to: SETUP, data: '0x', value: '0x0' }])],
    ['more gas than its share', simulate({}, Array.from({ length: 3 }, () => ({ from: SETUP, to: SETUP, data: '0x', value: '0x0', gas: gas(1) })))],
    ['a call to Multicall3', simulate({}, [{ from: SETUP, to: MULTICALL, data: '0x12', value: '0x0', gas: gas(1) }])],
    ['too much data', simulate({}, [{ from: SETUP, to: SETUP, data: `0x${'00'.repeat(16_385)}`, value: '0x0', gas: gas(1) }])],
    ['another block', envelope('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: SETUP, to: SETUP, data: '0x', value: '0x0', gas: gas(1) }] }], validation: false }, '0x10'])],
    ['a value past 256 bits', simulate({}, [{ from: SETUP, to: SETUP, data: '0x', value: `0x1${'0'.repeat(64)}`, gas: gas(1) }])],
  ]) {
    await refused(setup(fake, { purpose: 'simulate' }).rpc.fetch(RPC, body(value))).catch((error) => assert.fail(`simulate: ${label}: ${error.message}`));
  }
  assert.equal(fake.posts.length, 0, 'nothing was sent for any of them');

  // And what the chain code does send passes, each under the purpose that reads it.
  const passes = [
    ['owned', call()],
    ['owned', call(undefined, '0x4461f30')],
    ['owned', envelope('eth_getLogs', [logsFilter(69_249_061, 69_300_000)])],
    ['state', call()],
    ['automation', envelope('eth_blockNumber', [])],
    ['ledger', envelope('eth_getBlockByNumber', ['0x10', false])],
    ['ledger', call()],
    ['ledger', call(undefined, hex(70_000_000))],
    ['ledger', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [SWAP, POOL] }])],
    // The ledger's reads (functions/_lib/feesLedger.ts): one block of the PoolManager, an NFT's transfers, the holders'
    // token transfers with the PoolManager, and the engine's two events.
    ['ledger', envelope('eth_getLogs', [{ address: fees.POOL_MANAGER, fromBlock: hex(70_000_000), toBlock: hex(70_000_000), topics: [fees.TOPIC.ModifyLiquidity, null, `0x${'0'.repeat(24)}${'03'.repeat(20)}`] }])],
    ['ledger', envelope('eth_getLogs', [{ address: [TOKEN_A, TOKEN_B], fromBlock: hex(70_000_000), toBlock: hex(71_000_000), topics: [fees.TOPIC.Transfer, `0x${'0'.repeat(24)}${'03'.repeat(20)}`, [OWNER_TOPIC, OWNER_TOPIC]] }])],
    ['ledger', envelope('eth_getLogs', [{ address: ledger.ENGINE, fromBlock: hex(70_000_000), toBlock: hex(71_000_000), topics: [ledger.FEES_REALIZED, null, null, ID_WORD] }])],
    ['ledger', envelope('eth_getLogs', [{ address: ledger.ENGINE, fromBlock: hex(70_000_000), toBlock: hex(70_000_100), topics: [ledger.BUDGET_APPLIED, `0x${'0'.repeat(24)}${'5a'.repeat(20)}`] }])],
    ['record', envelope('eth_getLogs', [{ address: `0x${'5a'.repeat(20)}`, fromBlock: '0x1', toBlock: '0x2', topics: [vaultRecord.EXECUTION_COMPLETED] }])],
    ['simulate', simulate()],
    ['simulate', simulate({}, Array.from({ length: 12 }, () => ({ from: SETUP, to: SETUP, data: '0x12', value: '0x0', gas: gas(12) })))],
    // A deposit's value is wei: 2^53 wei is only about 0.009 ETH, so any 256-bit quantity passes.
    ['simulate', simulate({}, [{ from: SETUP, to: SETUP, data: '0x12', value: '0xde0b6b3a7640000', gas: gas(2) }, { from: SETUP, to: SETUP, data: '0x', value: `0x${'f'.repeat(64)}`, gas: gas(2) }])],
  ];
  for (const [purpose, value] of passes) {
    const response = await setup(node({ answer: (call) => ({ result: call.method === 'eth_getLogs' ? [] : '0x' }) }), { purpose }).rpc.fetch(RPC, body(value));
    assert.equal(response.status, 200, `${purpose}: ${value.method}`);
  }
});

// Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): six, and none a pool's own history (no Swap, Donate,
// Initialize or ProtocolFeeUpdated): the fees ledger reads a position's own events and the engine's.
test('the fixed V1 and V2 events a log read may name are the chain code’s own, and none is a pool’s history', () => {
  assert.deepEqual([...local.LOG_TOPICS].sort(), [fees.TOPIC.Transfer, fees.TOPIC.ModifyLiquidity, owned.SETUP_MINTED_TOPIC, vaultRecord.EXECUTION_COMPLETED, ledger.FEES_REALIZED, ledger.BUDGET_APPLIED, ledger.V2_ACTION, ledger.V2_STEP, ledger.V2_VAULT_CREATED, ledger.V2_COLLECTED, ledger.V2_COMPOUNDED].sort());
  assert.equal(new Set(local.LOG_TOPICS).size, 11);
  for (const topic of [SWAP, INITIALIZE]) assert.ok(!local.LOG_TOPICS.includes(topic));
  assert.deepEqual(local.PURPOSE_METHODS.simulate, ['eth_simulateV1']);
  for (const purpose of ['owned', 'state', 'ledger', 'automation', 'record', 'confirmation']) assert.ok(!local.PURPOSE_METHODS[purpose].includes('eth_simulateV1'), purpose);
  // rugged97's method list: no method outside it, and never a send.
  const all = new Set(Object.values(local.PURPOSE_METHODS).flat());
  for (const method of all) assert.ok(['eth_call', 'eth_getLogs', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_chainId', 'eth_simulateV1', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method), method);
  assert.deepEqual(local.PURPOSE_METHODS.confirmation, ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);
  for (const purpose of ['owned', 'state', 'ledger', 'automation', 'record', 'simulate']) {
    assert.ok(!local.PURPOSE_METHODS[purpose].includes('eth_getTransactionByHash'), purpose);
    assert.ok(!local.PURPOSE_METHODS[purpose].includes('eth_getTransactionReceipt'), purpose);
  }
  assert.ok(!all.has('eth_sendRawTransaction'));
  assert.deepEqual(local.EDGE_LOG_LIMITS, { one: 5_000_000, many: 5_000_000 });
});

// ---------------------------------------------------------------------------
// Log windows
// ---------------------------------------------------------------------------

/** A node whose logs are one per block in `blocks`, each naming its block; refuses a range wider than W as rugged's would. */
function logNode(blocks, more = {}) {
  return node({
    answer: (call) => {
      if (call.method !== 'eth_getLogs') return { result: '0x1' };
      const [filter] = call.params;
      const [from, to] = [Number(filter.fromBlock), Number(filter.toBlock)];
      if (to - from + 1 > W) return { error: { code: -32602, message: `range too wide ${from}..${to}` } };
      return { result: blocks.filter((block) => block >= from && block <= to).map((block) => ({ block: hex(block) })) };
    },
    ...more,
  });
}

test('a log range wider than one call is asked in windows, oldest first, in one POST, and answered once under the caller’s id in block order', async () => {
  const from = 70_000_000;
  const blocks = [from + 5, from + W + 7, from + 2 * W, from + 2 * W + 49_999];
  const fake = logNode(blocks);
  const { rpc } = setup(fake);
  const response = await rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(from, from + 2 * W + 49_999)], 41)));
  const reply = await response.json();
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 41, result: blocks.map((block) => ({ block: hex(block) })) });
  const [post] = fake.calls();
  assert.deepEqual(post.calls.map((call) => [call.id, Number(call.params[0].fromBlock) - from, Number(call.params[0].toBlock) - from]), [[0, 0, W - 1], [1, W, 2 * W - 1], [2, 2 * W, 2 * W + 49_999]], 'internal ids, oldest first');
  for (const call of post.calls) assert.deepEqual(Object.keys(call.params[0]), ['address', 'fromBlock', 'toBlock', 'topics'], 'the same filter');
  assert.equal(fake.calls().length, 1);
  for (const call of post.calls) assert.equal(nodeLogError(call.params[0]), null, 'within the node’s rules');
  assert.deepEqual(rpc.spent().posts, 2, 'the check and the one POST');
  assert.equal(rpc.spent().items, 3);
});

test('a window’s error is the logical call’s, its first in window order, trimmed; its later windows are not asked', async () => {
  const from = 70_000_000;
  const long = 'x'.repeat(500);
  const fake = node({
    answer: (call) => {
      const start = Number(call.params[0].fromBlock);
      if (start === from + W) return { error: { code: -32005, message: `query returned more than 10000 results ${long}`, data: { secret: 'never' } } };
      if (start === from + 2 * W) return { error: { code: -32000, message: 'later' } };
      return { result: [] };
    },
  });
  const { rpc } = setup(fake);
  const reply = await (await rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(from, from + 3 * W - 1)], 7)))).json();
  assert.deepEqual(Object.keys(reply.error).sort(), ['code', 'message'], 'its data is dropped');
  assert.equal(reply.error.code, -32005);
  assert.equal(reply.error.message.length, 200);
  assert.equal(owned.classifyRpcError(reply.error.code, reply.error.message), 'range', 'the chain code still splits it');

  // A batch of several logical calls, larger than one POST: a failed call's windows in later POSTs are dropped.
  const many = node({ answer: (call) => (call.method !== 'eth_getLogs' ? { result: '0x10' } : Number(call.params[0].fromBlock) === from ? { error: { code: -32000, message: 'first window fails' } } : { result: [] }) });
  const batch = setup(many).rpc;
  const asked = [envelope('eth_getLogs', [logsFilter(from, from + 60 * W - 1)], 1), envelope('eth_blockNumber', [], 2)];
  const replies = await (await batch.fetch(RPC, body(asked))).json();
  assert.deepEqual(replies.map((one) => one.id).sort(), [1, 2]);
  assert.equal(replies.find((one) => one.id === 1).error.message, 'first window fails');
  assert.equal(replies.find((one) => one.id === 2).result, '0x10', 'the other call answered');
  const sent = many.calls().flatMap((post) => post.calls);
  assert.equal(sent.length, 51, 'the first POST’s fifty windows and the other call; the failed call’s last ten never sent');
});

test('a mixed batch keeps every caller id, one answer each; calls go fifty to a POST', async () => {
  const from = 70_000_000;
  const fake = logNode([from + 1, from + 54 * W]);
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the ledger's reads, in place of the replay's.
  const { rpc } = setup(fake, { purpose: 'ledger' });
  const asked = [
    envelope('eth_getBlockByNumber', ['0x10', false], 9),
    envelope('eth_getLogs', [{ address: [TOKEN_A, TOKEN_B], fromBlock: hex(from), toBlock: hex(from + 55 * W - 1), topics: [fees.TOPIC.Transfer, POOL] }], 3),
    envelope('eth_call', [{ to: MULTICALL, data: owned.encodeAggregate3([{ target: SETUP, data: owned.SELECTOR.ownerNonce }]) }, 'latest'], 4),
  ];
  const replies = await (await rpc.fetch(RPC, body(asked))).json();
  assert.deepEqual(replies.map((reply) => reply.id), [9, 3, 4]);
  assert.deepEqual(replies[1].result, [{ block: hex(from + 1) }, { block: hex(from + 54 * W) }]);
  assert.deepEqual(fake.calls().map((post) => post.calls.length), [50, 7]);
  assert.ok(fake.calls().every((post) => Array.isArray(post.body)));
  // One call alone goes as one envelope.
  const single = node({ answer: () => ({ result: '0x5' }) });
  await setup(single).rpc.fetch(RPC, body(envelope('eth_blockNumber', [], 5)));
  assert.equal(Array.isArray(single.calls()[0].body), false);
});

test('a reply past the byte cap, per POST or merged, is a range too large for logs and a 502 for anything else', async () => {
  const from = 70_000_000;
  const half = 'y'.repeat(4.5 * 1024 * 1024);
  // Each POST under the cap (the first window and the 51st, in two POSTs), the logical call's windows merged past it.
  const bigAt = new Set([hex(from), hex(from + 50 * W)]);
  const merged = node({ answer: (call) => ({ result: bigAt.has(call.params[0].fromBlock) ? [{ data: half }] : [] }) });
  const reply = await (await setup(merged).rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(from, from + 51 * W - 1)], 2)))).json();
  assert.equal(merged.calls().length, 2, 'two POSTs, each within the cap');
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 2, error: { code: -32005, message: 'response size exceeded' } });
  assert.equal(owned.classifyRpcError(reply.error.code, reply.error.message), 'range');
  // One POST's reply past the cap: logs get the same refusal.
  const big = 'z'.repeat(local.LOCAL_RPC_REPLY_BYTES + 10);
  const huge = node({ answer: (call) => (call.method === 'eth_getLogs' ? { result: [{ data: big }] } : { result: '0x1' }) });
  const capped = await (await setup(huge).rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(from, from + 10)], 3)))).json();
  assert.deepEqual(capped.error, { code: -32005, message: 'response size exceeded' });
  // Anything else past it: a 502, which the chain code takes as fatal.
  const calls = node({ answer: () => ({ result: big }) });
  assert.equal((await setup(calls).rpc.fetch(RPC, body(envelope('eth_call', [{ to: MULTICALL, data: owned.encodeAggregate3([{ target: SETUP, data: owned.SELECTOR.ownerNonce }]) }, 'latest'])))).status, 502);
});

test('an invocation makes at most forty POSTs; the next call is refused as the budget, the check included', async () => {
  const fake = node({ answer: () => ({ result: '0x1' }) });
  const { rpc, clock } = setup(fake);
  for (let i = 0; i < local.LOCAL_RPC_POSTS_PER_INVOCATION - 1; i++) {
    assert.equal((await rpc.fetch(RPC, body(envelope('eth_blockNumber', [], i)))).status, 200, `call ${i}`);
    clock.time += 1_000;
  }
  await assert.rejects(rpc.fetch(RPC, body(envelope('eth_blockNumber', []))), { message: 'local_rpc_budget' });
  assert.equal(fake.posts.length, 40);
  assert.equal(local.LOCAL_RPC_POSTS_PER_INVOCATION, 40);
});

test('a request body past its cap is refused before anything is sent', async () => {
  const fake = node();
  const huge = `${AGGREGATE}${'00'.repeat(local.LOCAL_RPC_REQUEST_BYTES / 2)}`;
  await refused(setup(fake).rpc.fetch(RPC, body(envelope('eth_call', [{ to: MULTICALL, data: huge }, 'latest']))));
  assert.equal(fake.posts.length, 0);
});

// ---------------------------------------------------------------------------
// Pace, rests, downs, refusals
// ---------------------------------------------------------------------------

// Changed on purpose 2026-10-02 (rugged97's answer to Q3: the site's token allows 1,000 a second for the whole site): a
// burst of twenty and fifty a second per isolate, where it was ten and five a second.
test('the isolate’s bucket: a burst of twenty, then fifty a second within a wait of a second, then a 429 that names two seconds', async () => {
  const fake = node({ answer: () => ({ result: '0x1' }) });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  const { make, slept } = setup(fake, { memory, clock });
  // Eighty invocations at the same moment (each one POST): the clock moves only by the bucket's own waits.
  const started = clock.time;
  const statuses = [];
  for (let i = 0; i < 80; i++) {
    const response = await make().fetch(RPC, body(envelope('eth_blockNumber', [], i)));
    statuses.push(response.status);
    if (response.status === 429) assert.equal(response.headers.get('Retry-After'), '2');
    clock.time = started;
  }
  assert.deepEqual(local.LOCAL_RPC_RATE, { perSecond: 50, burst: 20, waitMs: 1_000 });
  assert.deepEqual(statuses.slice(0, 70), Array(70).fill(200), 'twenty at once, fifty more within a second of waiting');
  assert.deepEqual(statuses.slice(70), Array(10).fill(429));
  assert.deepEqual(slept, Array.from({ length: 50 }, (_, i) => 20 * (i + 1)));
  assert.equal(fake.posts.length, 70);
});

test('the node’s 429 or 503 rests every POST of the isolate, staged ×4 to 30 s, as long as it asked within that; a reply ends it', async () => {
  let answer = 'rest';
  let retryAfter = null;
  const fake = node({ reply: (posted) => (posted.calls[0].method !== 'eth_chainId' && answer !== 'ok' ? json({ error: 'busy' }, answer === 'rest' ? 429 : 503, retryAfter ? { 'Retry-After': retryAfter } : {}) : null) });
  const { make, clock, log } = setup(fake);
  const ask = async () => {
    const response = await make().fetch(RPC, body(envelope('eth_blockNumber', [])));
    return [response.status, response.headers.get('Retry-After')];
  };
  assert.deepEqual(await ask(), [429, '2']);
  const posts = fake.posts.length;
  assert.deepEqual(await ask(), [429, '2'], 'during the rest, at once');
  clock.time += 1_000;
  assert.deepEqual(await ask(), [429, '1']);
  assert.equal(fake.posts.length, posts, 'nothing asked during the rest');
  clock.time += 1_000;
  answer = 'unavailable';
  assert.deepEqual(await ask(), [429, '8'], 'a 503 the same, staged ×4');
  clock.time += 8_000;
  assert.deepEqual(await ask(), [429, '30']);
  clock.time += 30_000;
  assert.deepEqual(await ask(), [429, '30'], 'at most 30 s');
  clock.time += 30_000;
  answer = 'ok';
  assert.deepEqual(await ask(), [200, null]);
  answer = 'rest';
  retryAfter = '7';
  assert.deepEqual(await ask(), [429, '7'], 'the node’s own wait, when longer than the staged one');
  clock.time += 7_000;
  retryAfter = '3600';
  assert.deepEqual(await ask(), [429, '30'], 'bounded to 30 s');
  assert.ok(log.every((line) => JSON.parse(line).event === 'local_rpc_rest'));
  // The chain code reads the 429 as a rate limit, and waits.
  await assert.rejects(owned.paced({ fetch: make().fetch, sleep: async () => {}, now: () => clock.time }, { calls: 0, started: clock.time, logBytes: 0 }, 'eth_blockNumber', []), (error) => error.kind === 'rate');
});

test('a refused token (401, 403, 404) is a 502 and lets the node alone for a minute; a 3xx is a 502 and never followed', async () => {
  for (const status of [401, 403, 404]) {
    const fake = node({ reply: (posted) => (posted.calls[0].method === 'eth_chainId' ? null : new Response('no', { status })) });
    const { make, clock, log } = setup(fake);
    assert.equal((await make().fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 502);
    const rpc = make();
    assert.equal(rpc.health(), 'refused');
    assert.equal((await rpc.fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 502);
    assert.equal(fake.posts.length, 2, `${status}: nothing asked while refused`);
    assert.deepEqual(log.map((line) => JSON.parse(line)), [{ service: 'chain-routes', event: 'local_rpc_refused', status }]);
    clock.time += local.LOCAL_RPC_REFUSED_MS;
    assert.equal(make().health(), 'ok');
  }
  const moved = node({ reply: (posted) => (posted.calls[0].method === 'eth_chainId' ? null : new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })) });
  const { rpc } = setup(moved);
  assert.equal((await rpc.fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 502);
  assert.equal(rpc.health(), 'ok');
  assert.equal(moved.posts.at(-1).init.redirect, 'manual');
});

test('a node out of reach (a network error, 502, 504, 520 to 530) is down: 15 s, doubling to 5 min, every POST rejected at once meanwhile', async () => {
  for (const failure of ['network', 502, 504, 520, 530]) {
    let down = true;
    const fake = node({ reply: (posted) => (down && posted.calls[0].method !== 'eth_chainId' ? (failure === 'network' ? Promise.reject(new TypeError('fetch failed')) : new Response('', { status: failure })) : null) });
    const { make, clock, memory } = setup(fake);
    await assert.rejects(make().fetch(RPC, body(envelope('eth_blockNumber', []))), { message: 'local_rpc_down' });
    assert.equal(make().health(), 'down', String(failure));
    await assert.rejects(make().fetch(RPC, body(envelope('eth_blockNumber', []))), { message: 'local_rpc_down' });
    assert.equal(fake.posts.length, 2, `${failure}: nothing asked while down`);
    clock.time += 15_000;
    await assert.rejects(make().fetch(RPC, body(envelope('eth_blockNumber', []))), { message: 'local_rpc_down' });
    assert.equal(memory.downMs, 30_000, 'doubled');
    for (let i = 0; i < 6; i++) {
      clock.time += memory.downMs;
      // Still trusted: a chain id check the node answers is a reply, which would end the doubling.
      memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
      await make().fetch(RPC, body(envelope('eth_blockNumber', []))).catch(() => undefined);
    }
    assert.equal(memory.downMs, local.LOCAL_RPC_DOWN.maxMs, 'at most five minutes');
    clock.time += memory.downMs;
    down = false;
    assert.equal((await make().fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 200);
    assert.equal(memory.downMs, 0, 'a reply ends it');
  }
  // The chain code reads it as a failure to reach the RPC.
  const out = node({ reply: () => Promise.reject(new TypeError('fetch failed')) });
  await assert.rejects(owned.paced({ fetch: setup(out).rpc.fetch, sleep: async () => {}, now: () => 0 }, { calls: 0, started: 0, logBytes: 0 }, 'eth_blockNumber', []), (error) => error.kind === 'fatal');
});

// Changed on purpose 2026-10-02 (rugged97's rule 7): a log range too slow was split and asked again; it stops now.
test('its own time-out is a TimeoutError, which stops the chain code’s read, a log range’s too; the caller’s drop is the caller’s', async () => {
  const hanging = node({
    reply: (posted) =>
      posted.calls[0].method === 'eth_chainId'
        ? null
        : new Promise((_, reject) => posted.init.signal.addEventListener('abort', () => reject(posted.init.signal.reason ?? new DOMException('aborted', 'AbortError')))),
  });
  const { rpc, make, clock, log } = setup(hanging, { timeoutMs: 20 });
  await assert.rejects(rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_010)]))), (error) => error.name === 'TimeoutError');
  assert.equal(rpc.health(), 'ok', 'a slow reply is not a node away');
  // Changed on purpose 2026-10-02 (review of the rules, finding 6): it comes before the node's own 30 s, so it rests every
  // POST of the isolate, staged as a 429 is; nothing is sent meanwhile.
  assert.deepEqual(log.map((line) => JSON.parse(line).event), ['local_rpc_rest']);
  const posts = hanging.posts.length;
  const resting = await make().fetch(RPC, body(envelope('eth_blockNumber', [])));
  assert.deepEqual([resting.status, resting.headers.get('Retry-After')], [429, '2']);
  assert.equal(hanging.posts.length, posts);
  clock.time += 2_000;
  await assert.rejects(make().fetch(RPC, body(envelope('eth_blockNumber', []))), (error) => error.name === 'TimeoutError');
  assert.equal(JSON.parse(log.at(-1)).ms, 8_000, 'a second in a row rests longer');
  const budget = { calls: 0, started: 0, logBytes: 0 };
  await assert.rejects(owned.paced({ fetch: setup(hanging, { timeoutMs: 20 }).rpc.fetch, sleep: async () => {}, now: () => 0 }, budget, 'eth_getLogs', [logsFilter(70_000_000, 70_000_010)]), (error) => error.kind === 'fatal' && error.message === 'rpc_timeout');
  assert.equal(budget.calls, 1, 'never split and asked again');
  const rt = { deps: { fetch: setup(hanging, { timeoutMs: 20 }).rpc.fetch, sleep: async () => {}, now: () => 0 }, cache: null };
  await assert.rejects(fees.post(rt, fees.newBudget(rt), envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_010)]), true), (error) => error instanceof fees.RelayError && error.kind === 'fatal' && error.message === 'rpc_timeout');
  const controller = new AbortController();
  const asking = setup(hanging, { timeoutMs: 60_000 }).rpc.fetch(RPC, { ...body(envelope('eth_blockNumber', [])), signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('dropped', 'AbortError')), 10);
  await assert.rejects(asking, (error) => error.name === 'AbortError');
});

test('what goes upstream: a POST to the configured node with JSON and the site’s own user agent, nothing from the browser, never redirected', async () => {
  const fake = node({ answer: () => ({ result: '0x1' }) });
  await setup(fake).rpc.fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'x=1', 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://domino.money' }, body: JSON.stringify(envelope('eth_blockNumber', [])) });
  for (const post of fake.posts) {
    assert.equal(post.url, ENDPOINT);
    assert.equal(post.init.method, 'POST');
    assert.deepEqual(post.init.headers, { 'Content-Type': 'application/json', 'User-Agent': 'DominoChainRoutes/1' });
    assert.equal(post.init.redirect, 'manual');
    assert.ok(post.init.signal instanceof AbortSignal);
  }
});

// ---------------------------------------------------------------------------
// The token, nowhere
// ---------------------------------------------------------------------------

test('the token is in no answer, header, error or log line, whatever the node does', async () => {
  const seen = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const name of Object.keys(original)) console[name] = (...args) => seen.push(args.map(String).join(' '));
  try {
    const outcomes = [
      node({ answer: () => ({ result: '0x1' }) }),
      node({ chainId: '0x1' }),
      node({ reply: (posted) => (posted.calls[0].method === 'eth_chainId' ? null : json({ error: ENDPOINT }, 429, { 'Retry-After': ENDPOINT })) }),
      node({ reply: () => new Response(ENDPOINT, { status: 401 }) }),
      node({ reply: () => new Response(ENDPOINT, { status: 530 }) }),
      node({ reply: () => Promise.reject(new TypeError(`connect ECONNREFUSED ${ENDPOINT}`)) }),
      node({ reply: () => new Response(`not json ${ENDPOINT}`, { status: 200 }) }),
      node({ reply: () => new Response(null, { status: 307, headers: { Location: ENDPOINT } }) }),
      node({ answer: () => ({ error: { code: -32000, message: `upstream ${ENDPOINT} failed`, data: ENDPOINT } }) }),
    ];
    for (const fake of outcomes) {
      for (const method of ['eth_blockNumber', 'eth_getLogs']) {
        const rpc = local.createLocalRpc(ENDPOINT, { purpose: 'owned', upstream: fake.upstream, memory: local.localRpcMemory() });
        const value = method === 'eth_getLogs' ? envelope(method, [logsFilter(70_000_000, 70_300_000)]) : envelope(method, []);
        try {
          const response = await rpc.fetch(RPC, body(value));
          seen.push(String(response.status), ...[...response.headers].flat(), await response.text());
        } catch (error) {
          seen.push(String(error?.name), String(error?.message), String(error?.stack));
        }
        seen.push(JSON.stringify(rpc.spent()), rpc.health());
      }
    }
  } finally {
    Object.assign(console, original);
  }
  const all = seen.join('\n');
  assert.ok(seen.length > 50);
  // Only the node's own error message carries it back, and the chain code never shows one: the transport hands it on
  // as the node said it, trimmed, as a JSON-RPC error. Everything the transport itself writes is free of it.
  const own = all.split('\n').filter((line) => !line.includes('upstream ') && !line.includes('"error":{"code":-32000'));
  assert.equal(own.some((line) => line.includes(TOKEN)), false, own.filter((line) => line.includes(TOKEN)).join('\n'));
});

// ---------------------------------------------------------------------------
// 2026-10-02: the review of the RPC switch (its findings 3 and 11)
// ---------------------------------------------------------------------------

// Finding 3: a visitor who leaves during the isolate's chain id check has its request's tasks cancelled (Cloudflare),
// so that check would never settle: it is handed to waitUntil, and no later invocation waits on it past its life.
test('a shared chain id check that never settles (its request cut off) holds no later invocation: handed to waitUntil, then let go and asked again', async () => {
  let checks = 0;
  const fake = node({
    answer: () => ({ result: '0x7' }),
    // The first check's request is gone: its reply never comes, whatever its signal says.
    reply: (posted) => (posted.calls[0].method === 'eth_chainId' && ++checks === 1 ? new Promise(() => {}) : null),
  });
  const { make } = setup(fake, { timeoutMs: 20 });
  const kept = [];
  const lost = make({ keepAlive: (work) => kept.push(work) }).fetch(RPC, body(envelope('eth_blockNumber', [], 1)));
  void lost.catch(() => undefined);
  assert.equal(kept.length, 1, 'the check is handed to the invocation’s waitUntil');
  const started = Date.now();
  const later = await make().fetch(RPC, body(envelope('eth_blockNumber', [], 2)));
  assert.equal((await later.json()).result, '0x7', 'a later invocation still answers');
  assert.ok(Date.now() - started < 5_000, 'once the dead check’s life (its time-out and as long again) is over');
  assert.equal(checks, 2, 'it asked a check of its own');
  // And the next one finds the node trusted: no check at all.
  await make().fetch(RPC, body(envelope('eth_blockNumber', [], 3)));
  assert.equal(checks, 2);
});

/** A reply streamed in 16 KiB chunks, as many as `total` bytes; how much of it was pulled, and whether it was cancelled. */
function streamed(total) {
  const chunk = new TextEncoder().encode('y'.repeat(16 * 1024));
  const seen = { pulled: 0, cancelled: false };
  const response = () => {
    const prefix = new TextEncoder().encode('[{"jsonrpc":"2.0","id":0,"result":[{"data":"');
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            seen.pulled += prefix.byteLength;
            return controller.enqueue(prefix);
          }
          if (seen.pulled >= total) return controller.close();
          seen.pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { seen, response };
}

// Finding 11: the caller's own limit on a reply (a probe's 64 KiB, a part's 256 KiB, a day's 2 MiB) reaches the node read.
test('the caller’s reply limit stops the node read at it: the rest is never read, no further window is sent, and the chain code reads its own cut read', async () => {
  const big = streamed(1024 * 1024);
  const fake = node({ reply: (posted) => (posted.calls[0].method === 'eth_getLogs' ? big.response() : null) });
  const { rpc } = setup(fake, { purpose: 'ledger' });
  // 120 windows: three POSTs of fifty, if nothing stopped them. Changed on purpose 2026-10-02: a holder's token transfers
  // (the ledger's widest read), in place of a pool's swaps, and a limit of 64 KiB of the test's own.
  const filter = { address: [TOKEN_A, TOKEN_B], fromBlock: hex(70_000_000), toBlock: hex(70_000_000 + 120 * W - 1), topics: [fees.TOPIC.Transfer, POOL] };
  const limit = 64 * 1024;
  const reply = await rpc.fetch(RPC, { ...body(envelope('eth_getLogs', [filter], 1)), replyBytes: limit });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get(owned.REPLY_CUT), '1');
  assert.equal(await reply.text(), '', 'no body: past the limit');
  assert.equal(fake.calls().length, 1, 'the later windows were never sent');
  assert.ok(big.seen.cancelled, 'the node’s reply was cancelled');
  assert.ok(big.seen.pulled <= limit + local.REPLY_SLACK_BYTES * 50 + 64 * 1024, `${big.seen.pulled} bytes read of the node, near the limit, not a megabyte`);
  // Through the chain code: the same failure its own cut read gave, and the answer charged the limit.
  const again = streamed(1024 * 1024);
  const through = node({ reply: (posted) => (posted.calls[0].method === 'eth_getLogs' ? again.response() : null) });
  const transport = setup(through, { purpose: 'ledger' }).rpc;
  const rt = { deps: { fetch: transport.fetch, sleep: async () => {}, now: () => 0 }, cache: null };
  const budget = fees.newBudget(rt);
  await assert.rejects(fees.post(rt, budget, envelope('eth_getLogs', [filter], 1), true, limit), (error) => error instanceof fees.RelayError && error.kind === 'bytes' && error.message === 'attempt_cap');
  assert.equal(budget.bytes, limit);
  assert.ok(again.seen.pulled < 256 * 1024);
  // A reply within the limit is answered whole, as before.
  const small = node({ answer: () => ({ result: [] }) });
  const whole = await setup(small, { purpose: 'ledger' }).rpc.fetch(RPC, { ...body(envelope('eth_getLogs', [filter], 1)), replyBytes: limit });
  assert.equal(whole.headers.get(owned.REPLY_CUT), null);
  assert.deepEqual(await whole.json(), { jsonrpc: '2.0', id: 1, result: [] });
  assert.equal(small.calls().length, 3, 'every window asked');
  // Without a limit (a caller that names none), the transport's own cap alone, as before.
  const free = streamed(256 * 1024);
  const unlimited = node({ reply: (posted) => (posted.calls[0].method === 'eth_getLogs' ? free.response() : null) });
  const plain = await setup(unlimited, { purpose: 'ledger' }).rpc.fetch(RPC, body(envelope('eth_getLogs', [{ ...filter, toBlock: hex(70_000_010) }], 1)));
  assert.equal(plain.headers.get(owned.REPLY_CUT), null);
  assert.ok(free.seen.pulled >= 256 * 1024, 'read whole');
});

// 2026-10-02 (RPC fix round 2): the visitor's node bill moved from the route's door to the POSTs themselves; (round 2.2)
// the question's reserve is asked for by the transport, before each call that would reach the node.
test('a visitor’s spent share: the reserve asked before each call, a refused one refused at once before the check, nothing sent; each POST that goes is billed', async () => {
  const fake = node({ answer: () => ({ result: '0x10' }) });
  const { make } = setup(fake);
  // A call the allowlist refuses never asks for the reserve.
  let asked = 0;
  const shaped = make({ reserve: () => (asked++, true) });
  await assert.rejects(shaped.fetch(RPC, body(envelope('eth_sendRawTransaction', ['0x00']))));
  assert.equal(asked, 0);
  const spent = make({ reserve: () => false, onPost: () => assert.fail('nothing billed') });
  assert.equal(spent.refused(), false);
  await assert.rejects(spent.fetch(RPC, body(envelope('eth_blockNumber', []))), (error) => error instanceof TypeError && error.message === 'local_rpc_visitor_spent');
  assert.equal(spent.refused(), true);
  assert.equal(fake.posts.length, 0, 'not even the chain id check');
  assert.equal(spent.health(), 'ok', 'the node is not taken for away');
  // The chain code takes it as a failure it does not wait out (owned.ts and fees.ts: an unreachable node), not a 429.
  const rt = { deps: { fetch: spent.fetch, sleep: async () => assert.fail('no wait'), now: () => 0 }, cache: null };
  const budget = fees.newBudget(rt);
  await assert.rejects(fees.paced(rt, budget, () => fees.post(rt, budget, envelope('eth_blockNumber', []), false)), (error) => error instanceof fees.RelayError && error.kind === 'fatal');
  // An invocation with a share left: each POST that goes is billed once, the chain id check's included.
  let billed = 0;
  const paying = make({ reserve: () => (asked++, true), onPost: () => (billed += 1) });
  await paying.fetch(RPC, body(envelope('eth_blockNumber', [])));
  await paying.fetch(RPC, body([envelope('eth_blockNumber', [], 1), envelope('eth_blockNumber', [], 2)]));
  assert.equal(asked, 2, 'asked before each call');
  assert.equal(billed, paying.spent().posts);
  assert.equal(billed, fake.posts.length);
  assert.equal(paying.refused(), false);
});

// ---------------------------------------------------------------------------
// 2026-10-02: rugged97's rules for the site's token (C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md)
// ---------------------------------------------------------------------------

// Rule 3: never a log below block 69,249,061.
test('no log is read below the floor: a range that ends below it is answered empty with no call, one that starts below it starts there', async () => {
  const floor = local.LOCAL_RPC_LOG_FLOOR;
  assert.equal(floor, 69_249_061);
  assert.equal(floor, owned.SETUP_DEPLOY_BLOCK);
  // Wholly below: answered at once, [] under the caller's id; not even the chain id check, no reserve asked.
  const quiet = node();
  let asked = 0;
  const below = setup(quiet).make({ reserve: () => (asked++, true) });
  const reply = await (await below.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(9_506, floor - 1)], 4)))).json();
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 4, result: [] });
  assert.equal(quiet.posts.length, 0);
  assert.equal(asked, 0);
  assert.equal(below.spent().posts, 0);
  // Straddling: the windows start at the floor, never below it.
  const fake = logNode([floor - 10, floor, floor + 5]);
  const { rpc } = setup(fake);
  const straddle = await (await rpc.fetch(RPC, body(envelope('eth_getLogs', [logsFilter(0, floor + 100)], 5)))).json();
  assert.deepEqual(straddle.result, [{ block: hex(floor) }, { block: hex(floor + 5) }]);
  const sent = fake.calls().flatMap((post) => post.calls);
  assert.deepEqual(sent.map((call) => [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)]), [[floor, floor + 100]]);
  // In a batch: the call below the floor is answered empty, the others as asked, each under its own id.
  const mixed = logNode([floor + 1]);
  const replies = await (await setup(mixed).rpc.fetch(RPC, body([envelope('eth_getLogs', [logsFilter(1, 2)], 1), envelope('eth_getLogs', [logsFilter(floor, floor + 1)], 2), envelope('eth_blockNumber', [], 3)]))).json();
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 1, result: [] }, { jsonrpc: '2.0', id: 2, result: [{ block: hex(floor + 1) }] }, { jsonrpc: '2.0', id: 3, result: '0x1' }]);
  assert.ok(mixed.calls().flatMap((post) => post.calls).every((call) => call.method !== 'eth_getLogs' || Number(call.params[0].fromBlock) >= floor));
});

// Rule 5: at most 50 calls in one multicall.
test('a multicall carries at most fifty calls: fifty pass, fifty-one are refused before anything is sent', async () => {
  const calls = (n) => Array.from({ length: n }, () => ({ target: SETUP, data: owned.SELECTOR.ownerNonce + '0'.repeat(64) }));
  const fake = node({ answer: () => ({ result: '0x' }) });
  assert.equal((await setup(fake).rpc.fetch(RPC, body(envelope('eth_call', [{ to: MULTICALL, data: owned.encodeAggregate3(calls(50)) }, 'latest'])))).status, 200);
  const sentBefore = fake.posts.length;
  await refused(setup(fake).rpc.fetch(RPC, body(envelope('eth_call', [{ to: MULTICALL, data: owned.encodeAggregate3(calls(51)) }, 'latest']))));
  await refused(setup(fake).rpc.fetch(RPC, body(envelope('eth_call', [{ to: MULTICALL, data: AGGREGATE }, 'latest']))));
  assert.equal(fake.posts.length, sentBefore, 'nothing sent for either');
  assert.equal(local.LOCAL_RPC_BATCH_ITEMS, 50);
});

// Rule 7: the node cuts a call at 30 s (-32002); the same work is never asked again at once.
test('the node’s own time-out (-32002) rests every POST of the isolate for thirty seconds: a 429 for the chain code, nothing split or asked again', async () => {
  const fake = node({ answer: (call) => (call.method === 'eth_getLogs' ? { error: { code: -32002, message: 'request timed out' } } : { result: '0x1' }) });
  const { make, clock, log } = setup(fake);
  const response = await make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_400_000)], 1)));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '30');
  const posts = fake.posts.length;
  assert.equal((await make().fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 429, 'every POST rests');
  assert.equal(fake.posts.length, posts, 'nothing asked during the rest');
  assert.deepEqual(log.map((line) => JSON.parse(line).event), ['local_rpc_rest']);
  // The chain code waits it out as a rate limit within its deadline: never a range to split.
  assert.equal(owned.classifyRpcError(-32002, 'request timed out'), 'fatal');
  assert.equal(owned.classifyRpcError(-32000, 'log query timed out'), 'fatal');
  assert.equal(owned.classifyRpcError(-32005, 'query returned more than 10000 results'), 'range');
  clock.time += 30_000;
  assert.equal((await make().fetch(RPC, body(envelope('eth_blockNumber', [])))).status, 200, 'the rest over, the node is asked again');
});

// Rule 1: wide scans at most 10 a second and 4 at once for the whole site, about one core of the node. Changed on purpose
// 2026-10-02 (review of the rules, findings 2, 3, 12 and 13): paid for in blocks, once per call, before its first POST.
test('a wide scan pays its blocks from the isolate’s bucket: thirty million at once, then ten million a second within a wait of five; a longer wait is a 429 before anything is sent; a read of a few thousand blocks never waits', async () => {
  assert.deepEqual(local.LOCAL_RPC_WIDE, { blocks: 1_000_000, blocksPerSecond: 10_000_000, burstBlocks: 30_000_000, waitMs: 5_000 });
  const fake = node({ answer: (call) => (call.method === 'eth_getLogs' ? { result: [] } : { result: '0x1' }) });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  const { make, slept } = setup(fake, { memory, clock });
  const scan = (blocks, id) => make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_000 + blocks - 1)], id)));
  const started = clock.time;
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    const response = await scan(10_000_000, i);
    statuses.push([response.status, response.headers.get('Retry-After')]);
    clock.time = started;
  }
  assert.deepEqual(statuses, [...Array(8).fill([200, null]), [429, '6']], 'three at once, five more within five seconds');
  assert.deepEqual(slept, [1_000, 2_000, 3_000, 4_000, 5_000]);
  assert.equal(fake.calls().length, 8, 'the refused one sent nothing');
  // A call wider than the burst waits for a full bucket only, then owes the rest: the next waits for it.
  clock.time = started + 60_000;
  const full = slept.length;
  assert.equal((await scan(60_000_000, 10)).status, 200);
  assert.equal(slept.length, full, 'a full bucket: at once');
  assert.equal((await scan(10_000_000, 11)).status, 200);
  assert.deepEqual(slept.slice(full), [4_000], 'six seconds owed, less the two the burst holds for ten million');
  // An incremental read (a kept block, its tail) is never a wide scan.
  clock.time = started + 200_000;
  const before = slept.length;
  for (let i = 0; i < 5; i++) assert.equal((await make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(73_000_000, 73_018_000)], i)))).status, 200);
  assert.equal(slept.length, before, 'no wait');
});

test('a wide call takes one turn for all of its windows, before its first POST, however many POSTs carry them', async () => {
  const fake = node({ answer: (call) => (call.method === 'eth_getLogs' ? { result: [] } : { result: '0x1' }) });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  const { make, slept } = setup(fake, { memory, clock });
  // 120 windows, three POSTs: one turn, taken once.
  const response = await make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_000 + 120 * W - 1)], 1)));
  assert.equal(response.status, 200);
  assert.deepEqual(fake.calls().map((post) => post.calls.length), [50, 50, 20]);
  assert.deepEqual(slept, [], 'no wait between its POSTs');
  assert.equal(memory.wideTat, clock.time + (120 * W) / (local.LOCAL_RPC_WIDE.blocksPerSecond / 1000), 'every block paid for, once');
  // The next wide call owes them: refused at once, before anything is sent.
  const posts = fake.posts.length;
  assert.equal((await make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 79_999_999)], 2)))).status, 429);
  assert.equal(fake.posts.length, posts);
});

test('a 429 in the middle of a call keeps what the node answered: the chain code’s paced retry asks only the windows still missing', async () => {
  let refuse = true;
  const fake = node({
    reply: (posted) => (refuse && posted.calls[0].method === 'eth_getLogs' && posted.calls.length < 50 ? json({ error: 'busy' }, 503) : null),
    answer: (call) => (call.method === 'eth_getLogs' ? { result: [{ block: call.params[0].fromBlock }] } : { result: '0x1' }),
  });
  const { rpc, clock } = setup(fake, { purpose: 'ledger' });
  // Sixty small reads in one batch (not a wide scan): two POSTs, the second refused once by nginx's 503.
  const filters = Array.from({ length: 60 }, (_, i) => logsFilter(70_000_000 + 1_000 * i, 70_000_000 + 1_000 * i + 99));
  const rt = {
    deps: {
      fetch: rpc.fetch,
      sleep: async (ms) => {
        clock.time += ms;
        refuse = false;
      },
      now: () => clock.time,
    },
    cache: null,
  };
  const results = await fees.logsBatch(rt, fees.newBudget(rt), filters);
  assert.deepEqual(results.map((logs) => logs[0].block), filters.map((filter) => filter.fromBlock), 'every read answered, in order');
  assert.deepEqual(fake.calls().map((post) => post.calls.length), [50, 10, 10], 'the first POST’s fifty windows were never asked again');
});

test('one wide scan at a time per isolate: the next waits for the one on its way; one refused while it runs takes nothing from the bucket and lets no other run beside it; a scan that never ends holds none past its life', async () => {
  let release = () => {};
  let hold = true;
  const fake = node({
    reply: (posted) => (hold && posted.calls[0].method === 'eth_getLogs' ? new Promise((done) => { release = () => done(json(Array.isArray(posted.body) ? posted.calls.map((call) => ({ jsonrpc: '2.0', id: call.id, result: [] })) : { jsonrpc: '2.0', id: posted.body.id, result: [] })); }) : null),
    answer: () => ({ result: [] }),
  });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  const { make } = setup(fake, { memory, clock, timeoutMs: 60_000 });
  const wide = (id) => make().fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 72_999_999)], id)));
  const first = wide(1);
  await new Promise((done) => setTimeout(done, 20));
  hold = false;
  const second = wide(2);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(fake.calls().length, 1, 'the second waits for the first');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(fake.calls().length, 2, 'then goes');
  // The third holds on past the wait: the fourth is refused, its blocks never taken, and the fifth waits for the third,
  // not for the refusal.
  hold = true;
  const third = wide(3);
  await new Promise((done) => setTimeout(done, 20));
  hold = false;
  const tat = memory.wideTat;
  const refused = await wide(4);
  assert.equal(refused.status, 429);
  assert.equal(memory.wideTat, tat, 'the bucket untouched');
  const fifth = wide(5);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(fake.calls().length, 3, 'nothing beside the third');
  release();
  assert.equal((await third).status, 200);
  assert.equal((await fifth).status, 200);
  // A wide call that never ends: past its life (its time-out and a margin) it holds no turn.
  hold = true;
  void wide(6).catch(() => undefined);
  await new Promise((done) => setTimeout(done, 20));
  hold = false;
  clock.time += 70_000;
  assert.equal((await wide(7)).status, 200, 'the turn after its life is free');
});

// ---------------------------------------------------------------------------
// 2026-10-02 (review of rugged97's rules, finding 2): the site-wide gate (functions/_lib/wideGate.ts), when bound
// ---------------------------------------------------------------------------

const wideGate = require('../.test-build/app/functions/_lib/wideGate.js');

/** A Durable Object namespace whose one object answers `answer(path, body)`; every POST it got in `asked`. */
function gateNamespace(answer) {
  const asked = [];
  return {
    asked,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        asked.push({ object: id.name, path, body });
        return answer(path, body);
      },
    }),
  };
}

test('the site’s gate, when the deployment binds it: asked once per wide call, after the isolate’s turn, with its blocks; its wait waited, its refusal a 429 before anything is sent; its turn given back when the call ends', async () => {
  wideGate.resetSiteGate();
  const fake = node({ answer: (call) => (call.method === 'eth_getLogs' ? { result: [] } : { result: '0x1' }) });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  let grant = { ok: true, lease: '7', waitMs: 300 };
  const namespace = gateNamespace((path) => Response.json(path === '/take' ? grant : { ok: true }));
  const carried = [];
  const gate = wideGate.siteGateOf(namespace, (work) => carried.push(work), () => clock.time);
  const { make, slept } = setup(fake, { memory, clock });
  const scan = (id) => make({ siteGate: gate }).fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 79_999_999)], id)));
  assert.equal((await scan(1)).status, 200);
  await Promise.all(carried);
  assert.deepEqual(namespace.asked, [
    { object: 'site', path: '/take', body: { blocks: 10_000_000, waitMs: 5_000 } },
    { object: 'site', path: '/release', body: { lease: '7' } },
  ]);
  assert.deepEqual(slept, [300], 'the gate’s wait');
  assert.equal(carried.length, 1, 'the release rides the invocation’s waitUntil');
  // A read of a few thousand blocks never asks it.
  await make({ siteGate: gate }).fetch(RPC, body(envelope('eth_getLogs', [logsFilter(73_000_000, 73_018_000)], 2)));
  assert.equal(namespace.asked.length, 2);
  // Refused: a 429 that names its wait, nothing sent, the isolate's own turn given back.
  grant = { ok: false, retryAfterMs: 2_000 };
  clock.time += 60_000;
  const posts = fake.posts.length;
  const refused = await scan(3);
  assert.deepEqual([refused.status, refused.headers.get('Retry-After')], [429, '2']);
  assert.equal(fake.posts.length, posts);
  assert.equal(memory.wideBusy, null, 'the isolate’s turn given back');
});

test('a site gate that cannot be asked (away, or an answer of another shape) lets each scan go on the isolate’s own pace, and is let alone a minute', async () => {
  wideGate.resetSiteGate();
  assert.equal(wideGate.siteGateOf(undefined), null, 'not bound: the isolate’s own pace, as before');
  assert.equal(wideGate.siteGateOf({ get: () => null }), null);
  const clock = { time: 1_000 };
  const events = [];
  let calls = 0;
  const away = { idFromName: () => 'site', get: () => ({ fetch: async () => { calls += 1; throw new Error('gone'); } }) };
  const gate = wideGate.siteGateOf(away, undefined, () => clock.time, (event) => events.push(event));
  const alone = await gate.take(10_000_000, 5_000);
  assert.equal(alone.waitMs, 0);
  assert.equal(typeof alone.release, 'function');
  assert.deepEqual(events, ['wide_gate_away']);
  await gate.take(10_000_000, 5_000);
  assert.equal(calls, 1, 'not asked again within the minute');
  clock.time += wideGate.SITE_GATE_REST_MS;
  await gate.take(10_000_000, 5_000);
  assert.equal(calls, 2);
  for (const odd of [{ ok: true, lease: 'x', waitMs: 1 }, { ok: true, lease: '1', waitMs: 99_999 }, { ok: false }, { ok: 'yes' }, []]) {
    wideGate.resetSiteGate();
    const answer = await wideGate.siteGateOf(gateNamespace(() => Response.json(odd)), undefined, () => clock.time).take(10_000_000, 5_000);
    assert.equal(answer.waitMs, 0, JSON.stringify(odd));
  }
  wideGate.resetSiteGate();
  const status = await wideGate.siteGateOf(gateNamespace(() => new Response('no', { status: 500 })), undefined, () => clock.time).take(1, 1);
  assert.equal(status.waitMs, 0, 'a 500: alone');
  wideGate.resetSiteGate();
});

// ---------------------------------------------------------------------------
// 2026-10-02 (review of rugged97's rules, round 4): the time-outs and the rest agree; a wide call ends within its life
// ---------------------------------------------------------------------------

/** A node that answers the chain id, and holds every other POST until its signal ends it. */
const holding = () =>
  node({
    reply: (posted) =>
      posted.calls[0].method === 'eth_chainId'
        ? null
        : new Promise((_, reject) => posted.init.signal.addEventListener('abort', () => reject(posted.init.signal.reason ?? new DOMException('aborted', 'AbortError')))),
  });

test('the chain code’s own per-call time-out, ending a POST at the node, is our time-out too: the isolate rests, staged; a visitor’s drop rests nothing', async () => {
  const hanging = holding();
  // The transport's own time-out a minute away: the caller's signal (owned.ts, fees.ts: 10 s from its call, before this
  // POST's own 10 s) ends the POST first. It was taken as the caller's drop, and nothing rested.
  const { make, clock, log } = setup(hanging, { timeoutMs: 60_000 });
  await assert.rejects(make().fetch(RPC, { ...body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_010)])), signal: AbortSignal.timeout(30) }), (error) => error.name === 'TimeoutError');
  assert.deepEqual(log.map((line) => JSON.parse(line).event), ['local_rpc_rest']);
  assert.equal(JSON.parse(log[0]).ms, local.LOCAL_RPC_REST.firstMs);
  const posts = hanging.posts.length;
  const resting = await make().fetch(RPC, body(envelope('eth_blockNumber', [])));
  assert.deepEqual([resting.status, resting.headers.get('Retry-After')], [429, '2'], 'every POST of the isolate rests');
  assert.equal(hanging.posts.length, posts, 'nothing sent during the rest');
  // A visitor's drop (the simulation's request signal, an AbortError): the caller's, no rest.
  clock.time += local.LOCAL_RPC_REST.firstMs;
  const controller = new AbortController();
  const dropped = make().fetch(RPC, { ...body(envelope('eth_blockNumber', [])), signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('dropped', 'AbortError')), 10);
  await assert.rejects(dropped, (error) => error.name === 'AbortError');
  assert.equal(log.length, 1, 'no rest for a drop');
  assert.equal((await make().fetch(RPC, { ...body(envelope('eth_blockNumber', [])), signal: AbortSignal.timeout(30) }).catch((error) => error)).name, 'TimeoutError');
  assert.equal(JSON.parse(log.at(-1)).ms, 4 * local.LOCAL_RPC_REST.firstMs, 'a second time-out in a row rests longer, as ours does');
});

test('a wide call ends within its turn’s life: all its POSTs within one time-out from its turn, so it holds its turn and the site’s lease until it settles', async () => {
  // The gate's lease outlives any wide call (one POST time-out from its turn) with the same margin as the isolate's turn.
  assert.ok(SITE_WIDE.leaseMs >= local.LOCAL_RPC_POST_TIMEOUT_MS + 2_000, 'the site gate’s lease outlives a wide call');
  wideGate.resetSiteGate();
  const events = [];
  // Each POST answered after 60 ms: under one POST's time-out (100 ms), but two of them are not.
  const fake = node({
    reply: (posted) =>
      posted.calls[0].method === 'eth_getLogs'
        ? new Promise((done, fail) => {
            events.push('post');
            const timer = setTimeout(() => {
              events.push('answered');
              done(json(posted.calls.map((call) => ({ jsonrpc: '2.0', id: call.id, result: [] }))));
            }, 60);
            posted.init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              events.push('cut');
              fail(posted.init.signal.reason);
            });
          })
        : null,
  });
  const memory = local.localRpcMemory();
  const clock = { time: 1_000_000 };
  memory.trustedUntil = clock.time + local.LOCAL_RPC_TRUST_MS;
  const namespace = gateNamespace((path) => {
    events.push(path);
    return Response.json(path === '/take' ? { ok: true, lease: '9', waitMs: 0 } : { ok: true });
  });
  const carried = [];
  const gate = wideGate.siteGateOf(namespace, (work) => carried.push(work), () => clock.time);
  const { make, log } = setup(fake, { memory, clock, timeoutMs: 100 });
  // 120 windows, three POSTs: it was each POST under its own time-out, so the call ran past its turn's life.
  const wide = make({ siteGate: gate }).fetch(RPC, body(envelope('eth_getLogs', [logsFilter(70_000_000, 70_000_000 + 120 * W - 1)], 1)));
  await assert.rejects(wide, (error) => error.name === 'TimeoutError');
  await Promise.all(carried);
  assert.deepEqual(events, ['/take', 'post', 'answered', 'post', 'cut', '/release'], 'the second POST cut at the call’s time-out, the third never sent, the lease given back only then');
  assert.equal(memory.wideBusy, null, 'the isolate’s turn given back as the call settled');
  assert.deepEqual(log.map((line) => JSON.parse(line).event), ['local_rpc_rest'], 'a POST it cut is our time-out: the isolate rests');
  wideGate.resetSiteGate();
});
