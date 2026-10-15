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
import { browserChain, poolIdOf, RPC_URL } from './support/browser-chain.mjs';
import { ETH_KEY, KEY, OWNER, TOKEN, USDG } from './owned-chain.mjs';

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

// Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): the read keeps its NFT's facts beside it.
// (2026-10-14, Q1 alone; review finding on the 4 s window): a kept answer is served 5 s again, 918bbd62's window; Q1's 4 s
// missed every poll of a page polling every 5 s once a read takes any time (see 'a lone viewer at the page's period').
test('/state is kept 5 s per id set and a failure 5 s; a rate limit is waited out, then answered 429 with Retry-After', async () => {
  const fixture = loadCase('3136705');
  const [position] = fixture.state.positions;
  const chain = stateChain(position, { head: fixture.state.block, timestamp: fixture.state.timestamp });
  const { cache, stored } = memoryCache();
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  const calls = chain.log.length;
  chain.deps.time += 4_999;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.equal(chain.log.length, calls, 'kept');
  assert.deepEqual([...stored.keys()].map((url) => url.replace(/[0-9a-f]{64}/, '<sha256>')).sort(), [`${ORIGIN}/api/fees/v1/cache/c1/facts/${position.tokenId}/0`, `${ORIGIN}/api/fees/v1/cache/c1/state/<sha256>/0`]);
  chain.deps.time += 1;
  assert.equal((await askState(chain, { tokenIds: [position.tokenId] }, cache)).status, 200);
  assert.ok(chain.log.length > calls, 'read again at 5 s');

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

// ---------------------------------------------------------------------------
// One POST, shared per position (incident 2026-10-13, design 2.5, package Q1)
// ---------------------------------------------------------------------------

const VAULT = `0x${'5a'.repeat(20)}`;
const SINGLE = { tokenIds: ['11'], automation: true };

/** Two positions on the browser chain (tests/support/browser-chain.mjs), #11 under an Auto-compound vault, read by the relay itself. */
function walletChain(positions) {
  return browserChain({
    nodeRules: false,
    positions: positions ?? [
      { tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n], subscriber: VAULT },
      { tokenId: 12, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [0n, 0n] },
    ],
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol: 'UFG', decimals: 18 } },
    vaults: { [VAULT]: { root: 11, feeBps: 200, paused: false } },
  });
}

/**
 * The relay over `chain`, as one isolate of one data centre (`cache`): every node POST it sent (`posts`), on one clock.
 * (2026-10-14, Q1 alone): `postMs`, how long each node POST takes on that clock (0: the clock stands still during a read).
 */
function relayOver(chain, cache = memoryCache().cache, postMs = 0) {
  const clock = { time: 1_000_000 };
  const posts = [];
  const deps = {
    now: () => clock.time,
    sleep: async (ms) => void (clock.time += ms),
    fetch: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      clock.time += postMs;
      return chain.fetch(RPC_URL, init);
    },
  };
  const rt = { deps, cache };
  const ask = async (body) => {
    const response = await fees.answerState(post('/api/fees/v1/state', body), rt);
    return { status: response.status, body: await response.json() };
  };
  return { ask, posts, clock, cache, rt };
}

/** How many calls an aggregate3 POST carries (the word after its selector's offset, as functions/_lib/localRpc.ts reads it). */
const callsIn = (one) => Number(BigInt(`0x${one.params[0].data.slice(74, 138)}`));

test('the second read of an NFT costs one POST: one multicall at the head, with the pool id check, the same answer as two', async () => {
  const chain = walletChain();
  const relay = relayOver(chain);
  const first = await relay.ask(SINGLE);
  assert.equal(first.status, 200);
  assert.equal(relay.posts.length, 2, 'the first read of an NFT: two POSTs, and its facts learned');
  relay.clock.time += 10_000;
  chain.head += 97;
  chain.positions[0].unclaimed = [9n, 11n];
  const second = await relay.ask(SINGLE);
  assert.equal(second.status, 200);
  assert.equal(relay.posts.length, 3, 'the next read: one POST');
  const [only] = relay.posts.slice(2);
  assert.equal(only.method, 'eth_call');
  assert.equal(only.params[1], 'latest', 'one multicall at the head: every figure from that one block');
  assert.equal(second.body.block, chain.head, 'the block it says it read');
  assert.ok(callsIn(only) <= 50, 'rugged97’s rule 5');
  // The same answer the two POSTs give at that block: a new isolate and data centre, asked cold.
  fees.resetRelayMemory();
  const cold = relayOver(chain);
  assert.deepEqual(second.body, (await cold.ask(SINGLE)).body, 'figures, currencies and feature as two POSTs read them');
  assert.equal(cold.posts.length, 2);
  assert.notDeepEqual(second.body.positions[0].unclaimed0, first.body.positions[0].unclaimed0, 'the figures are the chain’s now, not kept');
});

test('a position that is not what its kept facts say is read in two POSTs, its figures the chain’s; facts are kept per data centre', async () => {
  const chain = walletChain();
  const { cache } = memoryCache();
  const relay = relayOver(chain, cache);
  const truth = (await relay.ask(SINGLE)).body;
  // A new isolate in the same data centre: the facts come from the cache, and the read is one POST.
  fees.resetRelayMemory();
  const next = relayOver(chain, cache);
  next.clock.time = relay.clock.time + 10_000;
  assert.deepEqual((await next.ask(SINGLE)).body, truth);
  assert.equal(next.posts.length, 1, 'a known NFT, a new isolate: one POST');
  // Kept facts that name another range (and, below, another pool) are not believed: the second POST runs at the first's block.
  const facts = await fees.kept(next.rt, fees.cacheUrl(ORIGIN, 'facts', '11', 0));
  const OTHER = { ...KEY, fee: 10_000, tickSpacing: 200 };
  for (const wrong of [{ ...facts.value, tickLower: -1200 }, { ...facts.value, key: OTHER, poolId: poolIdOf(OTHER) }]) {
    fees.resetRelayMemory();
    await fees.keep(next.rt, fees.cacheUrl(ORIGIN, 'facts', '11', 0), wrong, fees.FACTS_SECONDS);
    const posts = next.posts.length;
    next.clock.time += 10_000;
    const read = await next.ask(SINGLE);
    assert.deepEqual(read.body, truth, 'the chain’s figures, not the kept facts’');
    assert.deepEqual(next.posts.slice(posts).map((one) => one.params[1]), ['latest', `0x${truth.block.toString(16)}`], 'the second POST at the first one’s block');
    assert.deepEqual((await fees.kept(next.rt, fees.cacheUrl(ORIGIN, 'facts', '11', 0))).value, facts.value, 'the facts the chain gave are kept again');
  }
  // Facts that do not check out as stored (a pool id that is not its key's) are not taken at all.
  assert.equal(fees.factsFrom({ ...facts.value, poolId: `0x${'00'.repeat(32)}` }), null);
  assert.equal(fees.factsFrom({ ...facts.value, currencies: [facts.value.currencies[1], facts.value.currencies[0]] }), null);
  assert.deepEqual(fees.factsFrom(facts.value), facts.value);
});

test('an NFT’s facts are kept a day, in the isolate as in the data centre: past it, two POSTs once, and they are learned again', async () => {
  const chain = walletChain();
  const relay = relayOver(chain);
  await relay.ask(SINGLE);
  relay.clock.time += 10_000;
  await relay.ask(SINGLE);
  assert.equal(relay.posts.length, 3, 'two, then one');
  relay.clock.time += fees.FACTS_SECONDS * 1000;
  await relay.ask(SINGLE);
  assert.equal(relay.posts.length, 5, 'a day later: two POSTs, nothing older believed');
  relay.clock.time += 10_000;
  await relay.ask(SINGLE);
  assert.equal(relay.posts.length, 6, 'then one again');
});

test('a changed subscriber costs two POSTs once, then one again; the feature is the chain’s', async () => {
  const chain = walletChain();
  const relay = relayOver(chain);
  const plain = { tokenIds: ['12'], automation: true };
  assert.deepEqual((await relay.ask(plain)).body.automation, [{ tokenId: '12', automation: 'plain' }]);
  relay.clock.time += 10_000;
  await relay.ask(plain);
  assert.equal(relay.posts.length, 3, 'two, then one');
  // Auto-compound turned on for #12: a vault of its own is its subscriber now.
  const vault = `0x${'5b'.repeat(20)}`;
  chain.vaults[vault] = { root: 12, feeBps: 200, paused: false };
  chain.positions[1].subscriber = vault;
  relay.clock.time += 10_000;
  const turnedOn = await relay.ask(plain);
  assert.deepEqual(turnedOn.body.automation, [{ tokenId: '12', automation: 'compound', paused: false, active: true, vault }]);
  assert.equal(relay.posts.length, 5, 'two POSTs, once');
  relay.clock.time += 10_000;
  assert.deepEqual((await relay.ask(plain)).body, turnedOn.body);
  assert.equal(relay.posts.length, 6, 'one POST again');
  // Paused: the vault's own reads ride in the one POST, so the feature follows at once.
  chain.vaults[vault].paused = true;
  relay.clock.time += 10_000;
  assert.deepEqual((await relay.ask(plain)).body.automation, [{ tokenId: '12', automation: 'compound', paused: true, active: false, vault }]);
  assert.equal(relay.posts.length, 7);
});

// Changed on purpose (2026-10-14, Q1 alone; review finding on the 4 s window): within 5 s, 918bbd62's window, was 4 s.
test('a single-id question is served from the entry a batch wrote within 5 s, as that id’s own answer; never for a fresh question', async () => {
  const chain = walletChain();
  const relay = relayOver(chain);
  const batch = (await relay.ask({ tokenIds: ['12', '11'], automation: true })).body;
  const posts = relay.posts.length;
  relay.clock.time += 4_999;
  const one = await relay.ask(SINGLE);
  assert.equal(relay.posts.length, posts, 'the list’s read serves the page: no node POST');
  assert.deepEqual(one.body, { v: 1, block: batch.block, timestamp: batch.timestamp, positions: [batch.positions[0]], nextTokenId: batch.nextTokenId, automation: [batch.automation[0]] });
  fees.resetRelayMemory();
  assert.deepEqual(one.body, (await relayOver(chain).ask(SINGLE)).body, 'what #11 asked alone at that block answers');
  // The question without the features has its own entry, and a fresh one never takes the batch's.
  const plainOne = await relay.ask({ tokenIds: ['11'] });
  assert.equal(plainOne.body.automation, undefined);
  assert.ok(relay.posts.length > posts, 'another question, another entry');
  const before = relay.posts.length;
  await relay.ask({ ...SINGLE, fresh: true });
  assert.ok(relay.posts.length > before, 'a fresh question reads: the batch may have begun before the owner’s action');
});

// Changed on purpose (2026-10-14, Q1 alone; review finding on the 4 s window): the window is 918bbd62's 5 s again, so a
// second viewer up to 4,999 ms after a read shares it. The claim this case made before, that a lone viewer polling every
// 5 s gets a read of its own at each poll, held only on this clock, which stands still during a node POST; what a lone
// viewer costs at the page's period is measured in the next case, with reads that take time.
test('two viewers of one NFT within 5 s cost one read, one node POST once known', async () => {
  const chain = walletChain();
  const relay = relayOver(chain);
  await relay.ask(SINGLE);
  const warm = relay.posts.length;
  for (let read = 1; read <= 6; read++) {
    relay.clock.time += 10_000;
    chain.head += 97;
    assert.equal((await relay.ask(SINGLE)).body.block, chain.head, `read ${read}: for its question`);
    relay.clock.time += 4_999;
    assert.equal((await relay.ask(SINGLE)).body.block, chain.head, 'a second viewer 4,999 ms later: the same read');
    relay.clock.time -= 4_999;
  }
  assert.equal(relay.posts.length, warm + 6, 'one node POST a read, none for the second viewer');
});

// Added (2026-10-14, Q1 alone; review finding on the 4 s window): a node POST takes time, and a kept answer's age counts
// from when its read ended (keep stamps it then), while the page polls on a fixed beat (store.ts schedules the next poll
// when its timer fires). So a lone viewer polling every STATE_REFRESH_MS finds the entry 5 s minus the read's time old,
// plus the timer's lateness. Against 918bbd62's 5 s window every second poll is served kept: six reads a minute. Against
// Q1's 4 s every poll missed: twelve reads, one POST each for an ordinary NFT (no saving on 918bbd62's twelve) and two for
// one whose facts cannot be learned (a currency's symbol empty or holding a zero-width joiner: readState skips it), 24 a
// minute, twice 918bbd62's load on the node. The fake fetch here advances the clock 30 to 400 ms a POST.
// Changed on purpose (owner's D8, 2026-10-15): the page polls every 10 s (was 5 s). The edge's window (LIVE_STATE_MS, 5 s)
// stays shorter than the period, so every poll of a lone viewer is a read and its figure is fresh (0 blocks old, where it
// was one poll old on every second poll): still six reads a minute, six POSTs for an ordinary NFT and twelve for one
// whose facts cannot be learned. The page's own requests halve (twelve a minute to six, tests/fees-store.test.mjs); the
// node's POSTs for a lone viewer do not, since the edge already served every second 5 s poll from what it kept.
test('a lone viewer at the page’s period, each node POST taking time: six reads a minute, never more POSTs than 918bbd62’s twelve, facts learned or not', async () => {
  const { STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');
  // The window is measured against this period: it must stay shorter, so a lone viewer always gets a fresh figure.
  assert.equal(STATE_REFRESH_MS, 10_000);
  assert.ok(fees.LIVE_STATE_MS < STATE_REFRESH_MS, 'the edge’s window is shorter than the page’s period');
  const position = { tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n] };
  const minute = async (symbol, postMs, lateMs) => {
    fees.resetRelayMemory();
    const chain = browserChain({ nodeRules: false, positions: [position], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol, decimals: 18 } } });
    const relay = relayOver(chain, memoryCache().cache, postMs);
    const question = { tokenIds: ['11'], automation: true };
    let beat = relay.clock.time;
    assert.equal((await relay.ask(question)).status, 200);
    const learned = (await fees.kept(relay.rt, fees.cacheUrl(ORIGIN, 'facts', '11', 0))) !== null;
    const warm = relay.posts.length;
    let reads = 0;
    // A minute of polls at the page's period.
    for (let poll = 1; poll <= 60_000 / STATE_REFRESH_MS; poll++) {
      beat += STATE_REFRESH_MS + lateMs;
      relay.clock.time = Math.max(relay.clock.time, beat);
      chain.head += 49;
      const before = relay.posts.length;
      const answered = await relay.ask(question);
      assert.equal(answered.status, 200);
      assert.equal(answered.body.block, chain.head, `poll ${poll}: a fresh figure, never one kept from the last poll`);
      if (relay.posts.length > before) reads++;
    }
    return { learned, reads, posts: relay.posts.length - warm };
  };
  for (const postMs of [30, 150, 400]) {
    for (const lateMs of [0, 5]) {
      const at = `${postMs} ms a POST, the timer ${lateMs} ms late`;
      assert.deepEqual(await minute('UFG', postMs, lateMs), { learned: true, reads: 6, posts: 6 }, `${at}: an ordinary NFT, half 918bbd62's twelve`);
      for (const symbol of ['', 'US‍DG']) {
        assert.deepEqual(await minute(symbol, postMs, lateMs), { learned: false, reads: 6, posts: 12 }, `${at}: no facts (${JSON.stringify(symbol)}), 918bbd62's twelve`);
      }
    }
  }
});

test('the one-POST read never carries more than 50 calls: eight positions in eight pools under eight vaults stay two POSTs', async () => {
  const positions = Array.from({ length: 8 }, (_, i) => ({ tokenId: 21 + i, holder: OWNER, key: { ...KEY, fee: 100 + i }, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [1n, 2n], subscriber: `0x${(0x60 + i).toString(16).repeat(20)}` }));
  const chain = walletChain(positions);
  positions.forEach((p) => (chain.vaults[p.subscriber] = { root: p.tokenId, feeBps: 200, paused: false }));
  const relay = relayOver(chain);
  const ids = positions.map((p) => String(p.tokenId));
  const first = await relay.ask({ tokenIds: ids, automation: true });
  assert.equal(first.status, 200);
  relay.clock.time += 60_000;
  const posts = relay.posts.length;
  const again = await relay.ask({ tokenIds: ids, automation: true });
  assert.deepEqual(again.body, first.body);
  assert.ok(relay.posts.slice(posts).length >= 2, 'too many calls for one multicall: read as before');
  assert.ok(relay.posts.every((one) => callsIn(one) <= 50), 'rugged97’s rule 5, every POST');
  // Three of them fit in one.
  relay.clock.time += 60_000;
  const few = { tokenIds: ids.slice(0, 3), automation: true };
  await relay.ask(few);
  relay.clock.time += 60_000;
  const before = relay.posts.length;
  await relay.ask(few);
  assert.equal(relay.posts.length, before + 1, 'a list of three: one POST');
});

test('a native-ETH position (the owner’s case) is one POST once known, ETH named as its currency', async () => {
  const chain = walletChain([{ tokenId: 31, holder: OWNER, key: ETH_KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 15n, unclaimed: [5n, 7n] }]);
  const relay = relayOver(chain);
  const first = (await relay.ask({ tokenIds: ['31'], automation: true })).body;
  relay.clock.time += 10_000;
  const second = (await relay.ask({ tokenIds: ['31'], automation: true })).body;
  assert.equal(relay.posts.length, 3);
  assert.deepEqual(second, first);
  assert.deepEqual(second.positions[0].currencies.map((c) => [c.symbol, c.decimals]), [['ETH', 18], ['UFG', 18]]);
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
