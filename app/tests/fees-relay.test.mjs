/**
 * A position NFT's state at one block (functions/_lib/fees.ts, functions/api/fees/v1/state.ts; DESIGN-V2 §15.1–§15.2):
 * request validation, the /state reads and their exact unclaimed figure, the cache and its failures, all on a fake RPC
 * that answers only what the read may ask; and the site's two fees routes behind the real beta gate.
 *
 * Added 2026-09-24 (P6, fees data). Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): the /logs route,
 * its units of a pool's history and their tests are gone with the fees replay; the ledger route has its own suite
 * (tests/fees-ledger.test.mjs).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';
import { erc20Abi, fakeChain, fees, memoryCache, multicallAbi, owned, positionManagerAbi, stateViewAbi, topicOf, word } from './support/fees/fake-chain.mjs';
import { loadCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');
const { forward } = require('../.test-build/app/functions/_lib/bridge.js');

const ORIGIN = 'https://domino.money';

const post = (path, body, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const runtime = (chain, cache = null) => ({ deps: chain.deps, cache });
const askState = (chain, body, cache = null) => fees.answerState(post('/api/fees/v1/state', body), runtime(chain, cache));

test.beforeEach(() => fees.resetRelayMemory());

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('requests are exact: POST, same origin, JSON, small, known keys, decimal ids', async () => {
  const chain = fakeChain();
  const refused = async (request, status, handler = fees.answerState) => {
    const said = request.method === 'POST' ? await request.clone().text() : request.method;
    const response = await handler(request, runtime(chain));
    assert.equal(response.status, status, said.slice(0, 80));
    assert.deepEqual(await response.json(), { v: 1, error: 'bad_request' });
  };
  await refused(new Request(`${ORIGIN}/api/fees/v1/state`), 405);
  await refused(post('/api/fees/v1/state', { tokenIds: ['1'] }, { Origin: 'https://evil.example' }), 403);
  await refused(post('/api/fees/v1/state', { tokenIds: ['1'] }, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await refused(post('/api/fees/v1/state', { tokenIds: ['1'] }, { 'Content-Type': 'text/plain' }), 415);
  for (const body of ['nope', [], { tokenIds: ['01'] }, { tokenIds: [1] }, { tokenIds: ['1'.repeat(79)] }, { tokenIds: ['1'], automation: false }]) await refused(post('/api/fees/v1/state', body), 400);
  // Changed on purpose 2026-10-01 (the RPC switch's integration): "fresh": true is a question of its own now (right after
  // the owner's action); only true, as "automation", and no other key.
  for (const body of [{ tokenIds: [] }, { tokenIds: Array.from({ length: 9 }, (_, i) => String(i + 1)) }, { tokenIds: ['1', '1'] }, { tokenIds: ['0x1'] }, { tokenIds: ['1'], fresh: false }, { tokenIds: ['1'], stale: true }, { ids: ['1'] }]) {
    await refused(post('/api/fees/v1/state', body), 400, fees.answerState);
  }
  await refused(post('/api/fees/v1/state', `{"tokenIds":["${'1'.repeat(600)}"]}`), 400, fees.answerState);
  assert.deepEqual(chain.log, [], 'nothing refused reached the chain');
});

// ---------------------------------------------------------------------------
// /state
// ---------------------------------------------------------------------------

/** A chain whose views answer the recorded /state position of one fixture, at `head` − 2. */
function stateChain(position, { timestamp = 1_790_000_000, head = 71_500_000, overrides = {} } = {}) {
  const key = position.poolKey;
  const info = (BigInt(position.poolId) >> 56n) << 56n | (BigInt.asUintN(24, BigInt(position.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(position.tickLower)) << 8n);
  const tokens = Object.fromEntries(position.currencies.map((c) => [c.address, c]));
  return fakeChain({
    head,
    views: (target, data) => {
      const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
      if (overrides[target]) {
        const hit = overrides[target](data);
        if (hit) return hit;
      }
      if (target === owned.MULTICALL3) return ok(multicallAbi, 'getCurrentBlockTimestamp', BigInt(timestamp));
      if (target === owned.POSITION_MANAGER) {
        const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data });
        if (args[0] !== BigInt(position.tokenId)) return functionName === 'ownerOf' ? { success: false, returnData: '0x' } : functionName === 'getPositionLiquidity' ? ok(positionManagerAbi, functionName, 0n) : ok(positionManagerAbi, functionName, [{ currency0: '0x0000000000000000000000000000000000000000', currency1: '0x0000000000000000000000000000000000000000', fee: 0, tickSpacing: 0, hooks: '0x0000000000000000000000000000000000000000' }, 0n]);
        if (functionName === 'ownerOf') return ok(positionManagerAbi, functionName, position.owner);
        if (functionName === 'getPositionLiquidity') return ok(positionManagerAbi, functionName, BigInt(position.liquidity));
        return ok(positionManagerAbi, functionName, [key, info]);
      }
      if (target === fees.STATE_VIEW) {
        const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
        assert.equal(args[0], position.poolId);
        if (functionName === 'getSlot0') return ok(stateViewAbi, functionName, [BigInt(position.sqrtPriceX96), position.tick, 4097000, key.fee]);
        if (functionName === 'getFeeGrowthInside') {
          assert.deepEqual([args[1], args[2]], [position.tickLower, position.tickUpper]);
          return ok(stateViewAbi, functionName, [BigInt(position.feeGrowthInside0X128), BigInt(position.feeGrowthInside1X128)]);
        }
        assert.deepEqual([args[1].toLowerCase(), args[2], args[3]], [owned.POSITION_MANAGER, position.tickLower, position.tickUpper], 'the PositionManager’s position');
        assert.equal(args[4], topicOf(position.tokenId), 'salt = the token id');
        return ok(stateViewAbi, functionName, [BigInt(position.liquidity), BigInt(position.feeGrowthInside0LastX128), BigInt(position.feeGrowthInside1LastX128)]);
      }
      const token = tokens[target];
      assert.ok(token, `a call to ${target}`);
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
      return functionName === 'symbol' ? ok(erc20Abi, 'symbol', token.symbol) : ok(erc20Abi, 'decimals', token.decimals);
    },
  });
}

// Changed on purpose 2026-10-01 (fees item A21): two calls, where it was three: the first aggregate3 runs at 'latest' and
// says its block (ArbSys.arbBlockNumber), the second reads that block; every figure is still from one block.
test('/state reads each position at the head in two RPC calls, both at one block, and computes v4’s own unclaimed figure', async () => {
  for (const id of ['3136705', '2310187', '3165100']) {
    fees.resetRelayMemory();
    const fixture = loadCase(id);
    const [position] = fixture.state.positions;
    const chain = stateChain(position, { timestamp: fixture.state.timestamp, head: fixture.state.block });
    const response = await askState(chain, { tokenIds: [id] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    // 2026-09-25: /state also names the pool's protocol fee (slot0: 1,000 pips each way on this chain), for the price path.
    const withFee = { ...fixture.state, positions: fixture.state.positions.map((p) => (p.ok ? { ...p, protocolFee: 4_097_000 } : p)) };
    assert.deepEqual(await response.json(), withFee, `${id}: the recorded answer, rebuilt from the same chain values`);
    assert.deepEqual(chain.log.map((call) => call.method), ['eth_call', 'eth_call']);
    assert.deepEqual(chain.log.map((call) => call.params[1]), ['latest', `0x${fixture.state.block.toString(16)}`]);
    assert.deepEqual(chain.callBlocks, [fixture.state.block, fixture.state.block], 'both reads at one block');
  }
});

// 2026-10-01 (fees item A21; the live trace on a Vivo line that evening): the first call ran at 'latest' on one node and
// the second, at that block, met a node behind it. It is asked once more a moment later, and answered at the same block.
test('/state asks its second call once more when the node it meets does not have that block yet', async () => {
  const fixture = loadCase('3136705');
  const [position] = fixture.state.positions;
  for (const message of ['unsupported block number 71500000', 'header not found']) {
    fees.resetRelayMemory();
    const chain = stateChain(position, { timestamp: fixture.state.timestamp, head: fixture.state.block });
    const fetch = chain.deps.fetch;
    let behind = 0;
    chain.deps.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_call' && body.params[1] !== 'latest' && behind++ === 0) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, init);
    };
    const response = await askState(chain, { tokenIds: [position.tokenId] });
    assert.equal(response.status, 200, message);
    assert.equal((await response.json()).positions[0].ok, true, message);
    assert.equal(behind, 2, `${message}: the second call asked once more`);
    assert.deepEqual(chain.callBlocks.slice(-1), [fixture.state.block], `${message}: at the same block`);
  }
});

test('/state names what it cannot read: not found, a hooked pool, a bytes32 or unclean symbol, odd decimals, native ETH', async () => {
  const [position] = loadCase('3136705').state.positions;
  const hooked = { ...position, tokenId: '7', poolKey: { ...position.poolKey, hooks: '0x0000000000000000000000000000000000004444' } };
  const chain = stateChain(position, {
    overrides: {
      [owned.POSITION_MANAGER]: (data) => {
        const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data });
        if (args[0] !== 7n) return null;
        if (functionName === 'ownerOf') return { success: true, returnData: encodeFunctionResult({ abi: positionManagerAbi, functionName, result: position.owner }) };
        if (functionName === 'getPositionLiquidity') return { success: true, returnData: encodeFunctionResult({ abi: positionManagerAbi, functionName, result: 5n }) };
        return { success: true, returnData: encodeFunctionResult({ abi: positionManagerAbi, functionName, result: [hooked.poolKey, 0n] }) };
      },
      [position.currencies[0].address]: (data) => (decodeFunctionData({ abi: erc20Abi, data }).functionName === 'symbol' ? { success: true, returnData: `0x${Buffer.from('USDG').toString('hex').padEnd(64, '0')}` } : null),
      [position.currencies[1].address]: (data) => (decodeFunctionData({ abi: erc20Abi, data }).functionName === 'symbol' ? { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'U\u0007FG' }) } : { success: true, returnData: `0x${word(256)}` }),
    },
  });
  const answer = await (await askState(chain, { tokenIds: [position.tokenId, '7', '999'] })).json();
  assert.deepEqual(answer.positions.map((p) => [p.tokenId, p.ok, p.reason]), [['7', false, 'hooked_pool'], ['999', false, 'not_found'], [position.tokenId, true, undefined]], 'ascending ids');
  const read = answer.positions[2];
  assert.deepEqual(read.currencies.map((c) => [c.symbol, c.decimals]), [['USDG', 6], [null, null]], 'a bytes32 symbol reads; a control character or decimals past 255 do not');

  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'W\u2028ETH' })), null);
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'W\u2029ETH' })), null);
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'W\u0085ETH' })), null, 'a C1 control');
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'USD\u202eG' })), null, 'a bidirectional control (audit I2)');
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'US\u200dDG' })), null, 'a zero-width joiner (audit I2)');
  assert.equal(fees.decodeSymbol(`0x${word(32)}${word(100)}${'61'.repeat(100).padEnd(256, '0')}`), null, 'a symbol over 64 bytes');
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'été' })), 'été');
});

test('/state is kept 5 s per id set and a failure 5 s; a rate limit is waited out, then answered 429 with Retry-After', async () => {
  const fixture = loadCase('3136705');
  const [position] = fixture.state.positions;
  const chain = stateChain(position, { head: fixture.state.block, timestamp: fixture.state.timestamp });
  const { cache, stored } = memoryCache();
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  const calls = chain.log.length;
  chain.deps.time += 4_000;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.equal(chain.log.length, calls, 'kept');
  assert.deepEqual([...stored.keys()].map((url) => url.replace(/[0-9a-f]{64}/, '<sha256>')), [`${ORIGIN}/api/fees/v1/cache/c1/state/<sha256>/0`]);
  chain.deps.time += 2_000;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.ok(chain.log.length > calls, 'read again after 5 s');

  fees.resetRelayMemory();
  const limited = fakeChain({ script: { eth_call: Array.from({ length: 4 }, () => new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } })) } });
  const refused = await askState(limited, { tokenIds: ['1'] });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { v: 1, error: 'rate_limited' });
  assert.ok(Number(refused.headers.get('Retry-After')) >= 1);
  assert.deepEqual(limited.slept, [1500, 3000, 4500], 'owned.ts’s back-off: BACKOFF_MS × attempt, RATE_ATTEMPTS tries');

  fees.resetRelayMemory();
  const broken = fakeChain({ script: { eth_call: [{ error: { code: -32000, message: 'internal error' } }] } });
  const brokenCache = memoryCache();
  assert.equal((await askState(broken, { tokenIds: ['1'] }, brokenCache.cache)).status, 502);
  const before = broken.log.length;
  assert.equal((await askState(broken, { tokenIds: ['1'] }, brokenCache.cache)).status, 502, 'a failure is kept');
  assert.equal(broken.log.length, before);
  broken.deps.time += 5_000;
  await askState(broken, { tokenIds: ['1'] }, brokenCache.cache);
  assert.ok(broken.log.length > before, 'and forgotten after 5 s: the chain is asked again');
});

test('SEND_GZIP stays off until the preview measurement; the answer is plain JSON either way', async () => {
  assert.equal(fees.SEND_GZIP, false);
  const response = fees.answer('{"v":1}'.padEnd(4096, ' '), post('/api/fees/v1/state', {}, { 'Accept-Encoding': 'gzip' }));
  assert.equal(response.headers.get('Content-Encoding'), null);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
});

// ---------------------------------------------------------------------------
// The routes behind the gate
// ---------------------------------------------------------------------------

const GATE = { BETA_PASSWORD: 'fees-suite-beta-password-0001', BETA_COOKIE_KEY: 'Vb3sQ7mLx2Kp9TcN4dWy8ZhJ1gFa6ReU5oYiXwErTzC' };

async function betaCookie() {
  const response = await gate({
    request: new Request(`${ORIGIN}${LOGIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: `password=${encodeURIComponent(GATE.BETA_PASSWORD)}` }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  return response.headers.get('Set-Cookie').split(';')[0];
}

// Changed on purpose (2026-10-01, platform workstream, D8): the two routes were retired (the page read the chain itself
// since 2026-09-25). Changed on purpose again the same day (RPC-SPEC §2.5.2, §2.5.3, the owner's rule: the site reads
// nothing from a public RPC): they are back, answered from Domino's own node (functions/_lib/chainRoutes.ts), and the
// page asks them. Behind the gate, with no cookie past it; without the node's secret, a calm 503 that reads nothing.
// Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the second is the ledger route, in place of /logs.
test('the two routes answer behind the gate, from Domino’s own node: no cookie goes on, and without the node’s secret a calm 503 reads nothing', async () => {
  const routes = {
    '/api/fees/v1/state': require('../.test-build/app/functions/api/fees/v1/state.js'),
    '/api/fees/v2/ledger': require('../.test-build/app/functions/api/fees/v2/ledger.js'),
  };
  const original = globalThis.fetch;
  const log = console.log;
  globalThis.fetch = async () => assert.fail('nothing may reach the chain from the edge without its secret');
  console.log = () => {};
  try {
    for (const [path, body] of [['/api/fees/v1/state', { tokenIds: ['1'] }], ['/api/fees/v2/ledger', { tokenIds: ['1'] }]]) {
      const refused = await gate({ request: post(path, body), env: GATE, next: async () => assert.fail('the gate let an unauthenticated request through') });
      assert.equal(refused.status, 401);
      const admitted = post(path, body, { Cookie: await betaCookie() });
      const handed = [];
      const answered = await gate({ request: admitted, env: GATE, next: async (passed) => (handed.push(passed), routes[path].onRequest({ request: passed ?? admitted, env: {} })) });
      assert.equal(handed[0]?.headers.get('Cookie'), null, `${path}: no cookie past the gate`);
      assert.equal(answered.status, 503, path);
      assert.equal(answered.headers.get('Retry-After'), '300');
      assert.equal(answered.headers.get('Cache-Control'), 'no-store', `${path}: a chain route may be compressed on the way`);
      assert.equal(answered.headers.get('Content-Security-Policy'), API_CSP);
      assert.deepEqual(await answered.json(), { v: 1, error: 'source_unavailable' });
    }
    // Their paths are no bridge family's: the forwarder alone still answers them with a 404; the retired logs route too.
    assert.equal((await forward(post('/api/fees/v2/ledger', { tokenIds: ['1'] }), {})).status, 404);
    assert.equal((await forward(post('/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' }), {})).status, 404);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});
