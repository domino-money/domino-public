/**
 * The fees relay (functions/_lib/fees.ts, functions/api/fees/v1/{state,logs}.ts;
 * DESIGN-V2 §15.1–§15.3): request validation, the /state reads and their exact
 * unclaimed figure, the /logs units with head binding, validation before
 * caching, the day → hour fallback, the header grid, the caps with `next`,
 * in-flight de-duplication and the cache keys, all on a fake RPC that answers
 * only what the relay may ask. The route runs behind the real beta gate.
 *
 * Added 2026-09-24 (P6, fees data).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';
import { addressTopic, erc20Abi, fakeChain, fees, memoryCache, multicallAbi, owned, positionManagerAbi, rpcLog, stateViewAbi, swapLog, topicOf, word } from './support/fees/fake-chain.mjs';
import { loadCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const stateRoute = require('../.test-build/app/functions/api/fees/v1/state.js');
const logsRoute = require('../.test-build/app/functions/api/fees/v1/logs.js');
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');

const ORIGIN = 'https://domino.money';
const POOL = '0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03';
const DAY = fees.DAY_SPAN;
const HOUR = fees.HOUR_SPAN;

const post = (path, body, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const runtime = (chain, cache = null) => ({ deps: chain.deps, cache });
const askLogs = (chain, body, cache = null) => fees.answerLogs(post('/api/fees/v1/logs', body), runtime(chain, cache));
const askState = (chain, body, cache = null) => fees.answerState(post('/api/fees/v1/state', body), runtime(chain, cache));

test.beforeEach(() => fees.resetRelayMemory());

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('requests are exact: POST, same origin, JSON, small, known keys, safe numbers, decimal ids, lowercase 0x hashes', async () => {
  const chain = fakeChain();
  const refused = async (request, status, handler = fees.answerLogs) => {
    const said = request.method === 'POST' ? await request.clone().text() : request.method;
    const response = await handler(request, runtime(chain));
    assert.equal(response.status, status, said.slice(0, 80));
    assert.deepEqual(await response.json(), { v: 1, error: 'bad_request' });
  };
  await refused(new Request(`${ORIGIN}/api/fees/v1/logs`), 405);
  await refused(post('/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' }, { Origin: 'https://evil.example' }), 403);
  await refused(post('/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' }, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await refused(post('/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' }, { 'Content-Type': 'text/plain' }), 415);
  await refused(post('/api/fees/v1/logs', `{"kind":"headers","blocks":[${'36000,'.repeat(200)}0]}`), 400);
  for (const body of [
    'nope',
    [],
    { kind: 'transfer' },
    { kind: 'transfer', tokenId: '01' },
    { kind: 'transfer', tokenId: 1 },
    { kind: 'transfer', tokenId: '1'.repeat(79) },
    { kind: 'transfer', tokenId: '1', extra: true },
    { kind: 'initialize', poolId: POOL.toUpperCase() },
    { kind: 'initialize', poolId: POOL.slice(0, 64) },
    { kind: 'pool', poolId: POOL, epoch: -1 },
    { kind: 'pool', poolId: POOL, epoch: 1.5 },
    { kind: 'pool', poolId: POOL, epoch: 19, until: '71000000' },
    { kind: 'swaps', poolId: POOL, day: 82, count: 0 },
    { kind: 'swaps', poolId: POOL, day: 82, count: 8 },
    { kind: 'swaps', poolId: POOL, day: 2 ** 53, count: 1 },
    { kind: 'swapBefore', poolId: POOL, block: 0 },
    // 2026-09-25: a floor at or past the block; a probe backwards or wider than PROBE_SPAN; a transfer from a negative block.
    { kind: 'swapBefore', poolId: POOL, block: 5, since: 5 },
    { kind: 'probe', poolId: POOL, from: 10, to: 9 },
    { kind: 'probe', poolId: POOL, from: 0, to: 36_000 },
    { kind: 'probe', poolId: POOL, from: 0 },
    { kind: 'pool', poolId: POOL, epoch: 19, parts: false },
    { kind: 'transfer', tokenId: '1', since: -1 },
    // 2026-09-27: a transfer window backwards, or to a block that is not one.
    { kind: 'transfer', tokenId: '1', since: 10, until: 9 },
    { kind: 'transfer', tokenId: '1', until: '9' },
    { kind: 'transfer', tokenId: '1', until: -1 },
    { kind: 'headers', blocks: [] },
    { kind: 'headers', blocks: Array.from({ length: 51 }, (_, i) => i * HOUR) },
    { kind: 'headers', blocks: [HOUR, HOUR] },
    { kind: 'headers', blocks: [HOUR + 1, HOUR + 2] },
    { kind: 'eth_call', to: POOL },
  ]) {
    await refused(post('/api/fees/v1/logs', body), 400);
  }
  for (const body of [{ tokenIds: [] }, { tokenIds: Array.from({ length: 9 }, (_, i) => String(i + 1)) }, { tokenIds: ['1', '1'] }, { tokenIds: ['0x1'] }, { tokenIds: ['1'], fresh: true }, { ids: ['1'] }]) {
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

test('/state reads each position at head − 2 in three RPC calls and computes v4’s own unclaimed figure', async () => {
  for (const id of ['3136705', '2310187', '3165100']) {
    fees.resetRelayMemory();
    const fixture = loadCase(id);
    const [position] = fixture.state.positions;
    const chain = stateChain(position, { timestamp: fixture.state.timestamp, head: fixture.state.block + 2 });
    const response = await askState(chain, { tokenIds: [id] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    // 2026-09-25: /state also names the pool's protocol fee (slot0: 1,000 pips each way on this chain), for the price path.
    const withFee = { ...fixture.state, positions: fixture.state.positions.map((p) => (p.ok ? { ...p, protocolFee: 4_097_000 } : p)) };
    assert.deepEqual(await response.json(), withFee, `${id}: the recorded answer, rebuilt from the same chain values`);
    assert.deepEqual(chain.log.map((call) => call.method), ['eth_blockNumber', 'eth_call', 'eth_call']);
    assert.deepEqual(chain.callBlocks, [fixture.state.block, fixture.state.block], 'both reads pinned to head − 2');
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
  assert.equal(fees.decodeSymbol(`0x${word(32)}${word(100)}${'61'.repeat(100).padEnd(256, '0')}`), null, 'a symbol over 64 bytes');
  assert.equal(fees.decodeSymbol(encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'été' })), 'été');
});

test('/state is kept 10 s per id set and a failure 5 s; a rate limit is waited out, then answered 429 with Retry-After', async () => {
  const fixture = loadCase('3136705');
  const [position] = fixture.state.positions;
  const chain = stateChain(position, { head: fixture.state.block + 2, timestamp: fixture.state.timestamp });
  const { cache, stored } = memoryCache();
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  const calls = chain.log.length;
  chain.deps.time += 9_000;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.equal(chain.log.length, calls, 'kept');
  assert.deepEqual([...stored.keys()].map((url) => url.replace(/[0-9a-f]{64}/, '<sha256>')), [`${ORIGIN}/api/fees/v1/cache/c1/state/<sha256>/0`]);
  chain.deps.time += 2_000;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.ok(chain.log.length > calls, 'read again after 10 s');

  fees.resetRelayMemory();
  const limited = fakeChain({ script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } })) } });
  const refused = await askState(limited, { tokenIds: ['1'] });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { v: 1, error: 'rate_limited' });
  assert.ok(Number(refused.headers.get('Retry-After')) >= 1);
  assert.deepEqual(limited.slept, [1500, 3000, 4500], 'owned.ts’s back-off: BACKOFF_MS × attempt, RATE_ATTEMPTS tries');

  fees.resetRelayMemory();
  const broken = fakeChain({ script: { eth_blockNumber: [{ error: { code: -32000, message: 'internal error' } }] } });
  const brokenCache = memoryCache();
  assert.equal((await askState(broken, { tokenIds: ['1'] }, brokenCache.cache)).status, 502);
  const before = broken.log.length;
  assert.equal((await askState(broken, { tokenIds: ['1'] }, brokenCache.cache)).status, 502, 'a failure is kept');
  assert.equal(broken.log.length, before);
  broken.deps.time += 5_000;
  await askState(broken, { tokenIds: ['1'] }, brokenCache.cache);
  assert.ok(broken.log.length > before, 'and forgotten after 5 s: the chain is asked again');
});

// ---------------------------------------------------------------------------
// /logs
// ---------------------------------------------------------------------------

const TOKEN = '3136705';
const transferLog = (block, from, to) => rpcLog({ address: owned.POSITION_MANAGER, topics: [fees.TOPIC.Transfer, addressTopic(from), addressTopic(to), topicOf(TOKEN)], block });
const modifyLog = (block, index = 0) => rpcLog({ topics: [fees.TOPIC.ModifyLiquidity, POOL, addressTopic(owned.POSITION_MANAGER)], data: `0x${[337200, 345200, 10n ** 12n, BigInt(TOKEN)].map(word).join('')}`, block, index });

test('transfer, initialize and pool epochs: fixed filters, compact logs, the head cut at `until`, behind when the node lags', async () => {
  const zero = '0x0000000000000000000000000000000000000000';
  const owner = '0x706627e3e75b0603c4b6f9a1ebbfc635da712747';
  const init = rpcLog({ topics: [fees.TOPIC.Initialize, POOL, addressTopic('0x5fc5360d0400a0fd4f2af552add042d716f1d168'), addressTopic('0x7777777777777777777777777777777777777777')], data: `0x${[40000, 400, 0, 1n << 96n, 0].map(word).join('')}`, block: 57_898_668 });
  const chain = fakeChain({ head: 71_500_000, logs: [transferLog(70_126_907, zero, owner), init, modifyLog(70_126_907, 3), modifyLog(71_499_990, 1)] });
  const transfer = await (await askLogs(chain, { kind: 'transfer', tokenId: TOKEN })).json();
  assert.deepEqual(chain.log[1].params[0], { address: owned.POSITION_MANAGER, fromBlock: numberToHex(9506), toBlock: numberToHex(71_500_000), topics: [fees.TOPIC.Transfer, null, null, topicOf(TOKEN)] });
  assert.deepEqual(transfer, { v: 1, kind: 'transfer', head: 71_500_000, units: [{ unit: null, from: 9506, to: 71_500_000, final: false, logs: [[70_126_907, 0, 5, `0x${'11'.repeat(32)}`, [addressTopic(zero), addressTopic(owner), topicOf(TOKEN)], '0x']] }], next: null });

  const initialized = await (await askLogs(chain, { kind: 'initialize', poolId: POOL })).json();
  assert.equal(initialized.units[0].final, true, 'found and deep enough: final');
  assert.equal(initialized.units[0].logs[0][2], 0);

  const epoch = Math.floor(71_499_990 / fees.EPOCH_SPAN);
  const cut = await (await askLogs(chain, { kind: 'pool', poolId: POOL, epoch, until: 71_499_000 })).json();
  assert.deepEqual(cut.units.map((u) => [u.unit, u.from, u.to, u.final, u.logs.map((log) => log[0])]), [[epoch, epoch * fees.EPOCH_SPAN, 71_499_000, false, [70_126_907]]], 'nothing past `until`');
  const filter = chain.log.at(-1).params[0];
  assert.deepEqual(filter.topics, [[fees.TOPIC.Initialize, fees.TOPIC.ModifyLiquidity, fees.TOPIC.ProtocolFeeUpdated], POOL]);
  assert.equal(filter.address, fees.POOL_MANAGER);

  const lagging = await (await askLogs(chain, { kind: 'pool', poolId: POOL, epoch, until: 71_500_001 })).json();
  assert.deepEqual(lagging, { v: 1, kind: 'pool', behind: true });
});

// 2026-09-27 (review): headBlock's two rules, shared by the relay's routes and the replay worker. A request that names
// the blocks it reads up to (a probe, a pool epoch or swap days `until`, a transfer `until`, a Swap before a block,
// headers) is served by any head read at or past them, however long ago; one that names none (a pool's Initialize, a
// transfer to the head, /state) reads the head again once a second has passed, or a new pool or mint would be missed.
test('the head: a request that names its blocks reuses a head read at or past them, however old; one that names none reads it again after a second', async () => {
  const fixture = loadCase('3136705');
  const [position] = fixture.state.positions;
  const head = fixture.state.block + 2;
  const state = fixture.state.block;
  const hour = Math.floor(state / HOUR) * HOUR;
  const chain = stateChain(position, { head, timestamp: fixture.state.timestamp });
  Object.assign(chain.headers, { [hour]: fixture.state.timestamp - 3_600, [state]: fixture.state.timestamp });
  const heads = () => chain.log.filter((call) => call.method === 'eth_blockNumber').length;
  /** What one request cost in eth_blockNumber calls, and the head its answer names. */
  const ask = async (body) => {
    const before = heads();
    const response = await askLogs(chain, body);
    assert.equal(response.status, 200, JSON.stringify(body));
    const answer = await response.json();
    assert.equal(answer.behind, undefined, JSON.stringify(body));
    return { calls: heads() - before, head: answer.head };
  };
  assert.deepEqual(await ask({ kind: 'initialize', poolId: POOL }), { calls: 1, head });
  // Within the second, one that names no block is served by that head.
  chain.deps.time += 500;
  assert.deepEqual(await ask({ kind: 'transfer', tokenId: TOKEN, since: state - 5_000 }), { calls: 0, head });

  // A minute later the chain has moved on; every request that names blocks at or below the head read is served by it.
  chain.deps.time += 60_000;
  chain.head = head + 5_000;
  for (const body of [
    { kind: 'probe', poolId: POOL, from: state - 1_000, to: state },
    { kind: 'pool', poolId: POOL, epoch: Math.floor(state / fees.EPOCH_SPAN), until: state },
    { kind: 'swaps', poolId: POOL, day: Math.floor(state / DAY), count: 1, until: state },
    { kind: 'transfer', tokenId: TOKEN, since: state - 5_000, until: state },
    { kind: 'transfer', tokenId: TOKEN, since: state - 5_000, until: head },
    { kind: 'swapBefore', poolId: POOL, block: state, since: state - 10_000 },
    { kind: 'headers', blocks: [hour, state] },
  ]) {
    assert.deepEqual(await ask(body), { calls: 0, head }, `${body.kind} ${JSON.stringify(body).slice(-40)}`);
  }
  // One that names no block reads the head again: an Initialize, a transfer to the head, /state.
  assert.deepEqual(await ask({ kind: 'initialize', poolId: POOL }), { calls: 1, head: head + 5_000 });
  chain.deps.time += 1_001;
  chain.head = head + 6_000;
  assert.deepEqual(await ask({ kind: 'transfer', tokenId: TOKEN, since: state - 5_000 }), { calls: 1, head: head + 6_000 });
  chain.deps.time += 1_001;
  chain.head = head + 7_000;
  const before = heads();
  const read = await (await askState(chain, { tokenIds: [position.tokenId] })).json();
  assert.deepEqual([heads() - before, read.block], [1, head + 7_000 - 2], '/state at the new head − 2');
  // A named block past the head read reads it again at once, however fresh that head is.
  chain.head = head + 9_000;
  assert.deepEqual(await ask({ kind: 'probe', poolId: POOL, from: head + 7_000, to: head + 8_000 }), { calls: 1, head: head + 9_000 });
  assert.deepEqual(await ask({ kind: 'transfer', tokenId: TOKEN, since: head + 7_000, until: head + 9_000 }), { calls: 0, head: head + 9_000 });
  chain.head = head + 10_000;
  assert.deepEqual(await ask({ kind: 'pool', poolId: POOL, epoch: Math.floor(state / fees.EPOCH_SPAN), until: head + 9_500 }), { calls: 1, head: head + 10_000 });
});

test('every log is validated before it is used or kept: a foreign topic, a removed log or a block out of range fails the answer and nothing is kept', async () => {
  const other = '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6';
  const cases = [
    { ...swapLog(POOL, 70_000_100), topics: [fees.TOPIC.Swap, other, addressTopic('0x1111111111111111111111111111111111111111')] },
    { ...swapLog(POOL, 70_000_100), removed: true },
    { ...swapLog(POOL, 70_000_100), data: '0x1234' },
    { ...swapLog(POOL, 70_000_100), address: '0x0000000000000000000000000000000000000001' },
    { ...swapLog(POOL, 70_000_100), topics: [fees.TOPIC.Swap, POOL] },
  ];
  for (const bad of cases) {
    fees.resetRelayMemory();
    // The fake filters on its own copy; the relay sees the tampered log whatever its topics say.
    const chain = fakeChain({ head: 71_500_000 });
    chain.logs = [];
    const { cache, stored } = memoryCache();
    const original = chain.deps.fetch;
    chain.deps.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [bad] }));
      return original(url, init);
    };
    const response = await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 81, count: 1 }, cache);
    assert.equal(response.status, 502, JSON.stringify(bad).slice(0, 80));
    assert.deepEqual([...stored.keys()].filter((url) => !url.includes('/fail/')), [], 'nothing kept but the brief failure');
  }
});

test('swap days: a final day is kept for a year, the head day 10 s and only for the block it was cut at', async () => {
  const head = 71_500_000;
  const chain = fakeChain({ head, logs: [swapLog(POOL, 70_000_100), swapLog(POOL, 71_490_000)] });
  const { cache, stored } = memoryCache();
  const first = await (await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 81, count: 2, until: 71_495_000 }, cache)).json();
  assert.deepEqual(first.units.map((u) => [u.unit, u.from, u.to, u.final, u.logs.length]), [[81, 81 * DAY, 82 * DAY - 1, true, 1], [82, 82 * DAY, 71_495_000, false, 1]]);
  assert.equal(first.next, null);
  const kept = stored.get(`${ORIGIN}/api/fees/v1/cache/c1/swaps/${POOL}/81`);
  assert.match(kept.headers.get('Cache-Control'), /max-age=31536000/);
  assert.match(stored.get(`${ORIGIN}/api/fees/v1/cache/c1/swaps/${POOL}/82`).headers.get('Cache-Control'), /max-age=10$/);
  const calls = chain.log.filter((c) => c.method === 'eth_getLogs').length;
  // The same question within 10 s, and an earlier cut: both from the cache.
  const again = await (await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 81, count: 2, until: 71_480_000 }, cache)).json();
  assert.deepEqual(again.units.map((u) => [u.unit, u.to, u.logs.length]), [[81, 82 * DAY - 1, 1], [82, 71_480_000, 0]]);
  assert.equal(chain.log.filter((c) => c.method === 'eth_getLogs').length, calls);
  // A later cut is read again.
  await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 82, count: 1, until: 71_499_000 }, cache);
  assert.equal(chain.log.filter((c) => c.method === 'eth_getLogs').length, calls + 1);
  // Past 10 s, the head day is read again even for the same cut; the final day never.
  chain.deps.time += 11_000;
  await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 81, count: 2, until: 71_499_000 }, cache);
  const asked = chain.log.filter((c) => c.method === 'eth_getLogs').map((c) => Number(c.params[0].fromBlock));
  assert.deepEqual(asked.slice(calls + 1), [82 * DAY]);
});

test('a busy day falls back to its hours, each kept on its own; the answer stops at its caps and says where to go on', async () => {
  const head = 71_500_000;
  const day = 80;
  // 30 swaps in each of the day's first 3 hours: 90 in the day, over a 40-log limit; each hour under it.
  const logs = [];
  for (let hour = 0; hour < 3; hour++) for (let i = 0; i < 30; i++) logs.push(swapLog(POOL, day * DAY + hour * HOUR + i * 10, i));
  const chain = fakeChain({ head, logs, logLimit: 40 });
  const { cache, stored } = memoryCache();
  const answer = await (await askLogs(chain, { kind: 'swaps', poolId: POOL, day, count: 1 }, cache)).json();
  assert.deepEqual(answer.units.map((u) => [u.unit, u.logs.length, u.final]), [[day, 90, true]]);
  const ranges = chain.log.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(c.params[0].fromBlock) - day * DAY, Number(c.params[0].toBlock) - day * DAY]);
  assert.deepEqual(ranges[0], [0, DAY - 1], 'the whole day first');
  assert.deepEqual(ranges.slice(1), Array.from({ length: 24 }, (_, h) => [h * HOUR, h * HOUR + HOUR - 1]), 'then its 24 hours');
  assert.ok(stored.has(`${ORIGIN}/api/fees/v1/cache/c1/swapsBusy/${POOL}/${day}`));
  assert.ok(stored.has(`${ORIGIN}/api/fees/v1/cache/c1/swapsHour/${POOL}/${day * 24 + 2}`));
  // Kept: the next answer needs no RPC call but the head.
  fees.resetRelayMemory();
  const before = chain.log.length;
  await askLogs(chain, { kind: 'swaps', poolId: POOL, day, count: 1 }, cache);
  assert.deepEqual(chain.log.slice(before).map((c) => c.method), ['eth_blockNumber']);

  // The call cap: more days than one answer's calls can read; the complete days come back with `next`.
  fees.resetRelayMemory();
  const many = [];
  for (let d = 70; d < 77; d++) for (let hour = 0; hour < 2; hour++) for (let i = 0; i < 25; i++) many.push(swapLog(POOL, d * DAY + hour * HOUR + i, i));
  const capped = fakeChain({ head, logs: many, logLimit: 40 });
  const partial = await (await askLogs(capped, { kind: 'swaps', poolId: POOL, day: 70, count: 7 }, memoryCache().cache)).json();
  assert.equal(partial.units.length, 1, 'one busy day costs 25 calls; the second cannot finish within 32');
  assert.equal(partial.next, 71);
  assert.ok(capped.log.length <= fees.MAX_RPC_CALLS);
});

test('the byte cap: a day that does not fit is left for the next answer, with its complete hours kept', async () => {
  const head = 71_500_000;
  const big = (block, index) => ({ ...swapLog(POOL, block, index), padding: 'x'.repeat(20_000) });
  const logs = [];
  // Day 60: 300 swaps of ~20 kB each (≈ 6 MB); day 61 the same: together over the 8 MB an answer may read.
  for (const d of [60, 61]) for (let i = 0; i < 300; i++) logs.push(big(d * DAY + i * 2000, 0));
  const chain = fakeChain({ head, logs });
  const { cache } = memoryCache();
  const first = await (await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 60, count: 2 }, cache)).json();
  assert.deepEqual(first.units.map((u) => [u.unit, u.logs.length]), [[60, 300]]);
  assert.equal(first.next, 61);
  fees.resetRelayMemory();
  const second = await (await askLogs(chain, { kind: 'swaps', poolId: POOL, day: 61, count: 1 }, cache)).json();
  assert.deepEqual(second.units.map((u) => [u.unit, u.logs.length]), [[61, 300]], 'the next answer finishes it');
});

test('headers: batched, on the hourly grid (plus one recent block), kept once final; a block past the head is behind', async () => {
  const head = 71_500_000;
  const headers = { [70 * HOUR]: 1000, [71 * HOUR]: 4600, [head - 10]: 9999 };
  const chain = fakeChain({ head, headers });
  const { cache, stored } = memoryCache();
  const answer = await (await askLogs(chain, { kind: 'headers', blocks: [70 * HOUR, 71 * HOUR, head - 10] }, cache)).json();
  assert.deepEqual(answer, { v: 1, kind: 'headers', head, headers: [[70 * HOUR, 1000], [71 * HOUR, 4600], [head - 10, 9999]] });
  const batch = chain.log.filter((c) => c.method === 'eth_getBlockByNumber');
  assert.equal(batch.length, 3);
  assert.ok(stored.has(`${ORIGIN}/api/fees/v1/cache/c1/header/0/${70 * HOUR}`));
  assert.ok(!stored.has(`${ORIGIN}/api/fees/v1/cache/c1/header/0/${head - 10}`), 'the recent block is not kept');
  const again = await (await askLogs(chain, { kind: 'headers', blocks: [70 * HOUR] }, cache)).json();
  assert.deepEqual(again.headers, [[70 * HOUR, 1000]]);
  assert.equal(chain.log.filter((c) => c.method === 'eth_getBlockByNumber').length, 3, 'kept');
  assert.deepEqual(await (await askLogs(chain, { kind: 'headers', blocks: [1987 * HOUR] }, cache)).json(), { v: 1, kind: 'headers', behind: true });
  const old = await askLogs(chain, { kind: 'headers', blocks: [head - fees.SAFE_DEPTH - 1] }, cache);
  assert.equal(old.status, 400, 'an old block off the grid would defeat the cache');
});

test('swapBefore: windows of 3,000 blocks growing ×4, at most 8, the last reaching block 0; kept once final', async () => {
  const head = 71_500_000;
  const target = 70_000_000;
  const chain = fakeChain({ head, logs: [swapLog(POOL, target - 20_000, 4), swapLog(POOL, target - 20_000, 9), swapLog(POOL, target + 5)] });
  const { cache } = memoryCache();
  const found = await (await askLogs(chain, { kind: 'swapBefore', poolId: POOL, block: target }, cache)).json();
  assert.equal(found.log[0], target - 20_000);
  assert.equal(found.log[1], 9, 'the last one');
  const windows = chain.log.filter((c) => c.method === 'eth_getLogs').map((c) => [target - Number(c.params[0].toBlock), target - Number(c.params[0].fromBlock)]);
  assert.deepEqual(windows, [[1, 3000], [3001, 15000], [15001, 63000]]);
  const none = fakeChain({ head });
  const empty = await (await askLogs(none, { kind: 'swapBefore', poolId: POOL, block: target }, memoryCache().cache)).json();
  assert.equal(empty.log, null);
  const all = none.log.filter((c) => c.method === 'eth_getLogs');
  assert.equal(all.length, 8);
  assert.equal(Number(all.at(-1).params[0].fromBlock), 0, 'the last window reaches the chain’s start');
});

// 2026-09-25: the page's replay reads the chain from the visitor's own address, under the RPC's limit. Its cheap bound, the
// probe, is one read of every log of the pool in at most PROBE_SPAN blocks, refused as too large past PROBE_BYTES; and the
// two scans of the whole chain a replay made are bounded: swapBefore stops at the pool's Initialize (since), and a
// transfer read starts at since.
test('probe: every log of the pool in at most PROBE_SPAN blocks, too large past PROBE_BYTES; swapBefore stops at since; transfer starts at since', async () => {
  const head = 71_500_000;
  const chain = fakeChain({ head, logs: [swapLog(POOL, head - 10), swapLog(POOL, head - 40_000)] });
  const probe = await askLogs(chain, { kind: 'probe', poolId: POOL, from: head - fees.PROBE_SPAN + 1, to: head }, memoryCache().cache);
  assert.equal(probe.status, 200);
  const body = await probe.json();
  assert.deepEqual([body.kind, body.units.length, body.units[0].logs.map((log) => log[0]), body.next], ['probe', 1, [head - 10], null]);
  const [call] = chain.log.filter((c) => c.method === 'eth_getLogs');
  assert.deepEqual(call.params[0].topics, [[fees.TOPIC.Initialize, fees.TOPIC.ModifyLiquidity, fees.TOPIC.ProtocolFeeUpdated, fees.TOPIC.Swap, fees.TOPIC.Donate], POOL]);
  assert.deepEqual([Number(call.params[0].fromBlock), Number(call.params[0].toBlock)], [head - fees.PROBE_SPAN + 1, head]);
  // A pool too busy for a probe's reply: too large, never a partial count.
  const busy = fakeChain({ head, logs: Array.from({ length: 900 }, (_, i) => swapLog(POOL, head - i)) });
  const refusedProbe = await askLogs(busy, { kind: 'probe', poolId: POOL, from: head - 1_000, to: head }, memoryCache().cache);
  assert.equal(refusedProbe.status, 413);
  // swapBefore with a floor: its windows end there, and the last one starts there.
  const none = fakeChain({ head });
  const since = 69_950_000;
  const empty = await (await askLogs(none, { kind: 'swapBefore', poolId: POOL, block: 70_000_000, since }, memoryCache().cache)).json();
  assert.equal(empty.log, null);
  const windows = none.log.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(c.params[0].fromBlock), Number(c.params[0].toBlock)]);
  assert.ok(windows.every(([from]) => from >= since), JSON.stringify(windows));
  assert.equal(windows.at(-1)[0], since, 'the last window reaches the floor, not block 0');
  // transfer from a block.
  const nft = fakeChain({ head });
  assert.equal((await askLogs(nft, { kind: 'transfer', tokenId: '7', since: 70_000_000 }, memoryCache().cache)).status, 200);
  assert.deepEqual(nft.log.filter((c) => c.method === 'eth_getLogs').map((c) => Number(c.params[0].fromBlock)), [70_000_000]);
  // 2026-09-27: a transfer window: from `since` to `until`, not to the head (a replay looks for its mint newest first).
  const windowed = fakeChain({ head });
  const answer = await (await askLogs(windowed, { kind: 'transfer', tokenId: '7', since: 70_000_000, until: 70_500_000 }, memoryCache().cache)).json();
  assert.deepEqual([answer.units[0].from, answer.units[0].to], [70_000_000, 70_500_000]);
  assert.deepEqual(windowed.log.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(c.params[0].fromBlock), Number(c.params[0].toBlock)]), [[70_000_000, 70_500_000]]);
});

// 2026-09-25: a pool epoch asked `parts: true` (the replay in a browser, for a pool its probe saw liquidity history in) is
// read in tenths from the start, never whole, and a tenth whose reply passes PART_REPLY_BYTES ends the answer as too large.
test('pool parts: an epoch asked in parts is read tenth by tenth, never whole, and a tenth past PART_REPLY_BYTES is too large', async () => {
  const head = 71_500_000;
  const epoch = Math.floor(head / fees.EPOCH_SPAN);
  const start = epoch * fees.EPOCH_SPAN;
  const modify = (block, index = 0) => rpcLog({ topics: [fees.TOPIC.ModifyLiquidity, POOL, addressTopic('0x2222222222222222222222222222222222222222')], data: `0x${[-600, 600, 1000, block].map(word).join('')}`, block, index });
  const quiet = fakeChain({ head, logs: [modify(start + 10), modify(start + fees.EPOCH_PART_SPAN + 10)] });
  const body = await (await askLogs(quiet, { kind: 'pool', poolId: POOL, epoch, until: head, parts: true }, memoryCache().cache)).json();
  assert.deepEqual(body.units[0].logs.map((log) => log[0]), [start + 10, start + fees.EPOCH_PART_SPAN + 10]);
  const ranges = quiet.log.filter((c) => c.method === 'eth_getLogs').map((c) => Number(c.params[0].toBlock) - Number(c.params[0].fromBlock) + 1);
  assert.ok(ranges.every((span) => span <= fees.EPOCH_PART_SPAN), `tenths only: ${ranges.join(', ')}`);
  // One tenth holding more than a part's reply may take.
  const busy = fakeChain({ head, logs: Array.from({ length: 600 }, (_, i) => modify(start + 100 + i)) });
  assert.equal((await askLogs(busy, { kind: 'pool', poolId: POOL, epoch, until: head, parts: true }, memoryCache().cache)).status, 413);
  assert.ok(busy.log.filter((c) => c.method === 'eth_getLogs').every((c) => Number(c.params[0].toBlock) - Number(c.params[0].fromBlock) + 1 <= fees.EPOCH_PART_SPAN), 'never the whole epoch');
});

test('simultaneous questions for one unit make one RPC read', async () => {
  const chain = fakeChain({ head: 71_500_000, logs: [swapLog(POOL, 70_000_100)] });
  const { cache } = memoryCache();
  const answers = await Promise.all([1, 2, 3].map(() => askLogs(chain, { kind: 'swaps', poolId: POOL, day: 81, count: 1 }, cache)));
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200]);
  assert.equal(chain.log.filter((c) => c.method === 'eth_getLogs').length, 1);
});

test('SEND_GZIP stays off until the preview measurement; the answer is plain JSON either way', async () => {
  assert.equal(fees.SEND_GZIP, false);
  const response = fees.answer('{"v":1}'.padEnd(4096, ' '), post('/api/fees/v1/logs', {}, { 'Accept-Encoding': 'gzip' }));
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

test('both routes answer only behind the beta gate and leave with no-store, no-transform and the API CSP', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('the gate let an unauthenticated request reach the chain');
  try {
    for (const [route, path, body] of [[stateRoute, '/api/fees/v1/state', { tokenIds: ['1'] }], [logsRoute, '/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' }]]) {
      let reached = 0;
      const request = post(path, body);
      const refused = await gate({ request, env: GATE, next: async () => (reached++, route.onRequest({ request })) });
      assert.equal(refused.status, 401);
      assert.equal(reached, 0);
      const admitted = post(path, '{"nope":1}', { Cookie: await betaCookie() });
      const answered = await gate({ request: admitted, env: GATE, next: async () => (reached++, route.onRequest({ request: admitted })) });
      assert.equal(reached, 1);
      assert.equal(answered.status, 400);
      assert.equal(answered.headers.get('Cache-Control'), 'no-store, no-transform');
      assert.equal(answered.headers.get('Content-Security-Policy'), API_CSP);
      assert.deepEqual(await answered.json(), { v: 1, error: 'bad_request' });
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a busy pool epoch (more ModifyLiquidity than one call returns) falls back to tenths kept one by one; an answer that cannot finish it says so', async () => {
  const head = 71_500_000;
  const epoch = 15;
  const start = epoch * fees.EPOCH_SPAN;
  // 50 ModifyLiquidity in each tenth of the epoch: 500, over a 60-log limit; each tenth under it.
  const logs = [];
  for (let part = 0; part < 10; part++) for (let i = 0; i < 50; i++) logs.push(modifyLog(start + part * fees.EPOCH_PART_SPAN + i * 7000, i));
  const chain = fakeChain({ head, logs, logLimit: 60 });
  const { cache, stored } = memoryCache();
  const answer = await (await askLogs(chain, { kind: 'pool', poolId: POOL, epoch, until: head }, cache)).json();
  assert.deepEqual(answer.units.map((u) => [u.unit, u.logs.length, u.final]), [[epoch, 500, true]]);
  const ranges = chain.log.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(c.params[0].fromBlock) - start, Number(c.params[0].toBlock) - start]);
  assert.deepEqual(ranges[0], [0, fees.EPOCH_SPAN - 1], 'the whole epoch first');
  assert.deepEqual(ranges.slice(1), Array.from({ length: 10 }, (_, k) => [k * fees.EPOCH_PART_SPAN, k * fees.EPOCH_PART_SPAN + fees.EPOCH_PART_SPAN - 1]), 'then its tenths');
  assert.ok(stored.has(`${ORIGIN}/api/fees/v1/cache/c1/poolBusy/${POOL}/${epoch}`));
  assert.ok(stored.has(`${ORIGIN}/api/fees/v1/cache/c1/poolPart/${POOL}/${epoch * 10 + 3}`));

  // Out of calls midway: every tenth is itself over a 20-log limit and costs 7 calls in halves, so 10 of them do not fit
  // in one answer's 32 calls. No whole epoch, `next` = the same epoch; the kept tenths carry the later answers through.
  fees.resetRelayMemory();
  const busy = fakeChain({ head, logs, logLimit: 20 });
  const small = memoryCache();
  const answers = [];
  for (let i = 0; i < 5 && !answers.at(-1)?.units?.length; i++) {
    fees.resetRelayMemory();
    answers.push(await (await askLogs(busy, { kind: 'pool', poolId: POOL, epoch, until: head }, small.cache)).json());
  }
  assert.deepEqual([answers[0].units.length, answers[0].next], [0, epoch], 'nothing whole yet, and where to go on');
  assert.ok(answers.length >= 3, `${answers.length} answers`);
  assert.deepEqual(answers.at(-1).units.map((u) => u.logs.length), [500]);
});
