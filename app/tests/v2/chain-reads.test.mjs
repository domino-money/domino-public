/**
 * Base and Arbitrum One read by Domino's service (2026-10-06, rugged97's delta of 5 Oct, items 1-3: read-v6's live chain
 * reads chain-pools, chain-balances and chain-tokens, api-contracts/read-v6 README "Chain reads"), what is pure of it
 * (src/v2in/journey/model/chainReads.ts), on the package's own fixtures:
 *   - a chain-pools answer becomes today's pool rows: the pools Domino can open (hookless, a tier the network offers), in
 *     the answer's order, a v3 pool keyed by its address as a 32-byte word, the read's block and age;
 *   - the same answer names a pasted address's symbol and decimals, and reads one pool again;
 *   - a chain-balances answer gives a pool's two balances, and nothing for a network it could not read;
 *   - a chain-tokens answer becomes the search's rows, a token passing for USDC listed with a warning;
 *   - a test build's script serves the chain reads it scripts, and only those (src/v2in/dataSource.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const reads = require(`${BUILD}v2in/journey/model/chainReads.js`);
const networks = require(`${BUILD}v2in/journey/model/networks.js`);
const dataSource = require(`${BUILD}v2in/dataSource.js`);
const v6 = require(`${BUILD}v2/read/v6.js`);
const runtime = await import('../../../api-contracts/read-v6/runtime.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIVE = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
const chosen = networks.displayOf(8453, { address: LIVE, symbol: 'LIVE', decimals: 18 });

test('the fixtures used here are answers the contract accepts', () => {
  for (const [route, name] of [['chain-pools', 'chain-pools'], ['chain-pools', 'chain-pools-paired'], ['chain-balances', 'chain-balances-asked'], ['chain-tokens', 'chain-tokens'], ['chain-tokens', 'chain-tokens-usdc']]) {
    assert.equal(runtime.validateResponse(route, fixture(name)), true, name);
  }
});

test('chain-pools: the pools Domino can open, in the answer\'s order, keyed, read at the answer\'s block and age', () => {
  const answer = fixture('chain-pools');
  const receivedAt = 1_790_431_240_000;
  const rows = reads.poolsOfAnswer(8453, chosen, answer, receivedAt);
  assert.deepEqual(rows.map((row) => [row.dex, row.feePips, row.tickSpacing, row.fee]), [[3, 500, 10, '0.05%'], [4, 3000, 60, '0.30%']]);
  const [v3, v4] = rows;
  assert.equal(v3.key, `0x${'0'.repeat(24)}${answer.pools[0].address.slice(2)}`, 'a v3 pool: its address as a 32-byte word');
  assert.equal(v4.key, answer.pools[1].id, 'a v4 pool: its id');
  assert.deepEqual(v3.currencies.map((token) => [token.address, token.symbol, token.chainId]), [[WETH_BASE, 'WETH', 8453], [LIVE, 'LIVE', 8453]]);
  assert.equal(v3.currencies[1], chosen, 'the chosen token is kept as the journey holds it');
  assert.equal(v4.currencies[0].address, ZERO);
  assert.equal(v4.currencies[0].artwork, 'ETH', 'the network\'s own currencies as the profile names them');
  assert.equal(v3.tick, answer.pools[0].tick);
  assert.equal(v3.sqrtPriceX96, answer.pools[0].sqrtPriceX96);
  assert.equal(v3.block, answer.snapshot.number);
  assert.equal(v3.readAt, receivedAt - answer.freshness.ageSeconds * 1000, 'its age at the answer counts');
  // A pool with a hook, or on a tier this network does not offer for its version, is never a row.
  const odd = structuredClone(answer);
  odd.pools[0].pool.hooks = '0x1111111111111111111111111111111111110080';
  odd.pools[1].pool.tickSpacing = 61;
  assert.deepEqual(reads.poolsOfAnswer(8453, chosen, odd, receivedAt), []);
});

test('chain-pools names a pasted address\'s token, and reads one pool again', () => {
  const resolved = reads.resolvedOf(8453, LIVE.toUpperCase().replace('0X', '0x'), fixture('chain-pools'));
  assert.equal(resolved.ok, true);
  assert.deepEqual([resolved.token.address, resolved.token.symbol, resolved.token.decimals, resolved.token.chainId], [LIVE, 'LIVE', 18, 8453]);
  // A token whose decimals could not be read is never used.
  assert.deepEqual(reads.resolvedOf(8453, '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f', fixture('chain-pools-none')), { ok: false, code: 'token_decimals_unknown', reason: 'This token doesn’t say how many decimals it has, so it can’t be used here.' });
  // Read again: the same pool in an answer about its pair, at that answer's price; gone from it, null.
  const rows = reads.poolsOfAnswer(8453, chosen, fixture('chain-pools'), 1_000_000);
  const paired = fixture('chain-pools-paired');
  paired.pools[0].tick = 13870;
  const again = reads.rereadOf(rows[0], networks.refOf(rows[0]), paired, 2_000_000);
  assert.equal(again.key, rows[0].key);
  assert.equal(again.tick, 13870);
  assert.deepEqual(again.currencies, rows[0].currencies);
  assert.equal(reads.rereadOf(rows[1], networks.refOf(rows[1]), paired, 2_000_000), null, 'the v4 pool is not in an answer about WETH');
});

test('chain-balances: a pool\'s two balances in pool order; a network not read gives none, never zeros', () => {
  const eth = networks.displayOf(8453, { address: ZERO, symbol: 'ETH', decimals: 18 });
  const pair = reads.balancesOfAnswer(8453, [eth, chosen], fixture('chain-balances-asked'));
  assert.deepEqual(pair.map((entry) => [entry.token.address, entry.fact.text, entry.raw]), [[ZERO, '0.1', '100000000000000000'], [LIVE, '7', '7000000000000000000']]);
  assert.deepEqual(reads.balanceTokens(8453, [eth, chosen]), [{ chainId: 8453, address: ZERO }, { chainId: 8453, address: LIVE }]);
  // Arbitrum One unavailable in the default answer: no balances at all for a pool there.
  const usdcArb = networks.displayOf(42161, { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6 });
  const ethArb = networks.displayOf(42161, { address: ZERO, symbol: 'ETH', decimals: 18 });
  assert.equal(reads.balancesOfAnswer(42161, [ethArb, usdcArb], fixture('chain-balances')), null);
  // Base read, but its WETH balance unavailable: that one has no figure, the other has its own.
  const weth = networks.displayOf(8453, { address: WETH_BASE, symbol: 'WETH', decimals: 18 });
  const usdc = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const partial = reads.balancesOfAnswer(8453, [weth, usdc], fixture('chain-balances'));
  assert.deepEqual(partial.map((entry) => [entry.fact?.text ?? null, entry.raw]), [[null, null], ['2.5', '2500000']]);
});

test('chain-tokens: the search\'s rows, with their network; a token passing for USDC is listed with a warning', () => {
  const rows = reads.rowsOfTokens(8453, fixture('chain-tokens'));
  assert.deepEqual(rows.map((row) => [row.chainId, row.network, row.token.symbol, row.token.decimals, row.unread, row.warning ?? null]), [
    [8453, 'Base', 'AERO', 18, false, null],
    [8453, 'Base', 'AEROX', 18, false, null],
  ]);
  const usdc = reads.rowsOfTokens(8453, fixture('chain-tokens-usdc'));
  assert.equal(usdc[0].token.address, USDC_BASE);
  assert.equal(usdc[0].warning, undefined, 'the network\'s own USDC');
  // Added 2026-10-06 (the review of the next update): the network's own currency says so, for Enter's choice (preselectOf).
  assert.equal(usdc[0].own, true);
  assert.deepEqual(rows.map((row) => row.own), [undefined, undefined], 'any other token is not the network\'s own');
  const fake = fixture('chain-tokens-usdc');
  fake.tokens[0] = { ...fake.tokens[0], address: '0x9999999999999999999999999999999999999999', sources: ['looked_up'] };
  assert.equal(reads.rowsOfTokens(8453, fake)[0].warning, 'Not the USDC Domino uses');
  assert.equal(reads.rowsOfTokens(8453, fake)[0].own, undefined, 'a token passing for it is not');
  assert.equal(reads.lookalikeOf(8453, { address: '0x9999999999999999999999999999999999999999', symbol: ' weth ' }), 'WETH');
  assert.equal(reads.lookalikeOf(8453, { address: WETH_BASE, symbol: 'WETH' }), null);
  assert.deepEqual(['usdc', 'us', 'sd', 'aero'].map((query) => reads.symbolRank('USDC', query)), [0, 1, 2, 3]);
});

test('a test build\'s script serves the chain reads it scripts, answering by request, and only those', async () => {
  const deps = (script) => ({ runtimes: { read: runtime, plan: {} }, live: () => assert.fail('no live route under a script'), script: () => script });
  const gate = { mode: 'live' };
  const asked = [];
  const t = dataSource.createV2Transports(gate, deps({
    read6: {
      'chain-pools': (request) => {
        asked.push(request);
        return request.token === LIVE ? { status: 200, body: fixture('chain-pools') } : undefined;
      },
    },
  }));
  const state = await t.routeState('readV6');
  assert.deepEqual(state.routes, ['portfolio', 'activity', 'plan', 'chain-pools']);
  const reply = await v6.readChainPools(t.read, t.readRuntime, 8453, LIVE);
  assert.equal(reply.kind, 'ok');
  assert.deepEqual(asked, [{ chainId: 8453, token: LIVE }]);
  assert.deepEqual(await v6.readChainPools(t.read, t.readRuntime, 8453, USDC_BASE), { kind: 'unavailable', reason: 'network' }, 'a request the function leaves unscripted is refused');
  // Without chain reads scripted, today's routes alone, as before.
  const plain = dataSource.createV2Transports(gate, deps({ read6: { portfolio: { status: 200, body: fixture('portfolio') } } }));
  assert.deepEqual((await plain.routeState('readV6')).routes, ['portfolio', 'activity', 'plan']);
});

// Added 2026-10-06 (the owner's point 3: Base's and Arbitrum One's rows "dry", unnamed pasted addresses, "sometimes only
// Robinhood Chain"): what the rows carry for the APR estimate and for telling two of them apart, a pasted address named
// where it is a token, and which failed reads are worth asking again.
const otherChains = require(`${BUILD}lib/create/otherChains.js`);
const rowApr = require(`${BUILD}lib/read/screens/rowApr.js`);

test('chain-pools rows carry their protocol fee for the APR (v4 as read; v3 as its slot0.feeProtocol) and the facts that tell two rows apart; never the depth as TVL', () => {
  const answer = fixture('chain-pools');
  const [v3, v4] = reads.poolsOfAnswer(8453, chosen, answer, 1_000_000);
  assert.equal(v4.protocolFeeRaw, answer.pools[1].protocolFee, 'v4: the packed fee as read');
  assert.equal(v4.v3FeeProtocol, undefined);
  assert.equal(v3.protocolFeeRaw, otherChains.PROTOCOL_FEE_UNDESCRIBED, 'v3 with its protocol fee on: never read as a packed v4 fee');
  // Changed on purpose 2026-10-06 (the owner: Base's v3 rows showed no APR): beside it, its slot0.feeProtocol (0x44: a
  // quarter of the fee each way), from which the estimate takes the LPs' share.
  assert.equal(v3.v3FeeProtocol, answer.pools[0].protocolFee);
  assert.equal(v3.v3FeeProtocol, 0x44);
  const off = structuredClone(answer);
  off.pools[0].protocolFee = 0;
  assert.equal(reads.poolsOfAnswer(8453, chosen, off, 1_000_000)[0].protocolFeeRaw, 0, 'v3 with it off: no protocol fee');
  assert.equal(reads.poolsOfAnswer(8453, chosen, off, 1_000_000)[0].v3FeeProtocol, undefined);
  assert.deepEqual([v3.liquidity.state, v4.volume.state], ['unavailable', 'unavailable'], 'no TVL or volume from the answer itself');
  // With a TVL and a volume: the marker alone is refused, and with the row's slot0.feeProtocol the APR is three quarters
  // of the no-fee figure (0.05% × 1,000 / 1,000 × 365 = 18.25%, LPs keep 3/4: 13.69%).
  const figure = { state: 'attributed', value: '$1.0K', raw: '1000', zero: false, provider: 'dexscreener', retrievedAt: 1, cacheAgeSeconds: null };
  assert.deepEqual(rowApr.rowApr({ integration: v3.integration, currentLpFeePips: v3.feePips, protocolFeeRaw: v3.protocolFeeRaw, liquidity: figure, volume: figure }), { kind: 'none', reason: 'invalid_protocol_fee' });
  assert.equal(rowApr.rowApr({ integration: v3.integration, currentLpFeePips: v3.feePips, protocolFeeRaw: 0, liquidity: figure, volume: figure }).text, '18.25');
  assert.equal(rowApr.rowApr({ integration: v3.integration, currentLpFeePips: v3.feePips, protocolFeeRaw: v3.protocolFeeRaw, v3FeeProtocol: v3.v3FeeProtocol, liquidity: figure, volume: figure }).text, '13.69');
  assert.deepEqual(reads.factsOfAnswer(answer), {
    [v3.key]: { depthUsd: '102636.571596', liquidity: '1000000000000000000000' },
    [v4.key]: { depthUsd: '0.000000', liquidity: '4200000' },
  });
  const unmeasured = structuredClone(answer);
  unmeasured.pools[0].market = { status: 'unavailable', reference: null, depthUsd: null, reason: 'pool_depth_unmeasurable' };
  assert.equal(reads.factsOfAnswer(unmeasured)[v3.key].depthUsd, null);
});

test('a pool read again keeps its figures (they are about the pool, not its price), and takes the answer’s price and protocol fee', () => {
  const [row] = reads.poolsOfAnswer(8453, chosen, fixture('chain-pools'), 1_000_000);
  const figured = { ...row, liquidity: { state: 'attributed', value: '$102.6K', raw: '102636.57', zero: false, provider: 'dexscreener', retrievedAt: 7, cacheAgeSeconds: null }, volume: { state: 'not_reported', provider: 'dexscreener' }, providerNote: 'Provider figures retrieved…' };
  const paired = fixture('chain-pools-paired');
  paired.pools[0].tick = 13870;
  paired.pools[0].protocolFee = 0;
  const again = reads.rereadOf(figured, networks.refOf(figured), paired, 2_000_000);
  assert.equal(again.tick, 13870);
  assert.equal(again.protocolFeeRaw, 0);
  assert.equal(again.v3FeeProtocol, undefined);
  assert.deepEqual([again.liquidity, again.volume, again.providerNote], [figured.liquidity, figured.volume, figured.providerNote]);
  // Added 2026-10-06: read again with its protocol fee on, the slot0.feeProtocol comes with it.
  assert.equal(reads.rereadOf(figured, networks.refOf(figured), fixture('chain-pools-paired'), 2_000_000).v3FeeProtocol, 0x44);
});

test('a pasted address is named where it is a token; missing metadata beside pools stays unknown; no metadata and no pool is no token', () => {
  const named = reads.pastedOf(8453, LIVE.toUpperCase().replace('0X', '0x'), fixture('chain-pools'));
  assert.equal(named.state, 'token');
  assert.deepEqual([named.token.address, named.token.symbol, named.token.decimals, named.token.chainId], [LIVE, 'LIVE', 18, 8453]);
  // Changed on purpose 2026-10-30 (QA round 2, N98): no metadata and no pool at all is "No token at this address.", never
  // "Token data on Base … is unavailable right now." (such an address could not be used: no decimals, no pool).
  assert.equal(fixture('chain-pools-none').pools.length, 0);
  assert.deepEqual(reads.pastedOf(8453, '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f', fixture('chain-pools-none')), { state: 'none' }, 'no metadata and no pool: not a token there');
  const pooled = structuredClone(fixture('chain-pools-none'));
  pooled.pools = structuredClone(fixture('chain-pools').pools);
  assert.deepEqual(reads.pastedOf(8453, '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f', pooled), { state: 'metadata_unavailable' }, 'with pools, missing metadata cannot prove absence');
  const partial = structuredClone(fixture('chain-pools'));
  const live = partial.tokens.find((token) => token.address === LIVE);
  Object.assign(live, { decimals: null, status: 'partial' });
  assert.deepEqual(reads.pastedOf(8453, LIVE, partial), { state: 'metadata_unavailable' }, 'unknown decimals cannot prove absence');
  assert.equal(reads.pastedOf(8453, USDC_BASE, fixture('chain-pools')).token.symbol, 'USDC', 'the network’s own currency as the profile names it');
});

test('a failed chain read is asked again only when it may pass by itself', () => {
  for (const reason of ['network', 'read_capacity_busy', 'read_deadline_exceeded', 'request_timeout', 'upstream_unavailable', 'request_budget_exhausted', 'network_unavailable']) {
    assert.equal(reads.passingReply({ kind: 'unavailable', reason }), true, reason);
  }
  for (const reply of [{ kind: 'unavailable', reason: 'invalid_request' }, { kind: 'unavailable', reason: 'route_not_available' }, { kind: 'unavailable', reason: 'origin_not_allowed' }, { kind: 'invalid', detail: 'response' }, { kind: 'ok', body: {} }]) {
    assert.equal(reads.passingReply(reply), false, JSON.stringify(reply));
  }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §1: the gateway's Retry-After is now the real time to the lane's next token):
// a busy reader's 429 is asked again no sooner than the Retry-After it named; any other failure that may pass waits as a
// dropped connection does, as before.
test('a busy reader\'s Retry-After is the least a chain read waits before it is asked again', () => {
  const { quietDelayMs } = require(`${BUILD}lib/read/screens/transient.js`);
  assert.equal(reads.retryAfterOf({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 9 }), 9);
  for (const reply of [{ kind: 'unavailable', reason: 'read_capacity_busy' }, { kind: 'unavailable', reason: 'network' }, { kind: 'invalid', detail: 'response' }, { kind: 'ok', body: {} }]) {
    assert.equal(reads.retryAfterOf(reply), undefined, JSON.stringify(reply));
  }
  assert.deepEqual(reads.passingAfter(undefined), reads.PASSING, 'nothing named: a dropped connection’s wait, as before');
  assert.deepEqual(reads.passingAfter(9), { state: 'busy', retryAfterSeconds: 9 });
  for (const draw of [0, 0.5, 1]) {
    const busy = [0, 1, 2].map((attempt) => quietDelayMs(reads.passingAfter(9), attempt, () => draw));
    assert.ok(busy.every((wait) => wait >= 9_000), `never under the 9 s asked (${busy})`);
    const passing = quietDelayMs(reads.passingAfter(undefined), 0, () => draw);
    assert.ok(passing >= 3_000 && passing <= 5_000, `a dropped connection’s first wait, 3 to 5 s (${passing})`);
    // A Retry-After shorter than the quiet wait changes nothing: its 1 s is the lane's next token, already waited for.
    assert.equal(quietDelayMs(reads.passingAfter(1), 0, () => draw), passing);
  }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §1: "don't repeat chain-pools of the same token before 15 s, which is the
// reader's cache"; the app reuses an answer 20 s): one answer per key for every ask within its window, a read on its way
// shared, a failure dropped, and never a second read within the reader's 15 s whatever is asked.
test('one chain-pools answer per token serves every ask within 20 s, never asked again within the reader’s 15 s; a failure is not kept', async () => {
  assert.equal(reads.READER_POOLS_CACHE_MS, 15_000);
  assert.equal(reads.POOLS_REUSE_MS, 20_000);
  assert.equal(reads.poolsKey(8453, LIVE.toUpperCase().replace('0X', '0x')), `8453|${LIVE}|`);
  assert.equal(reads.poolsKey(4663, ZERO, WETH_BASE.toUpperCase().replace('0X', '0x')), `4663|${ZERO}|${WETH_BASE}`);
  let clock = 1_000;
  const asked = [];
  const reuse = reads.createAnswerReuse((said) => said.kind === 'ok', () => clock);
  const answer = (said) => (key) => () => { asked.push(key); return Promise.resolve(said); };
  const ok = answer({ kind: 'ok' });
  const key = reads.poolsKey(8453, LIVE);
  const first = reuse.ask(key, ok(key));
  assert.equal(reuse.ask(key, ok(key)), first, 'a read on its way is shared');
  await first;
  clock += 19_999;
  assert.equal(reuse.ask(key, ok(key)), first, 'kept 20 s');
  assert.equal(reuse.ask(reads.poolsKey(8453, LIVE, WETH_BASE), ok('pair')) === first, false, 'a pair is its own read');
  // A price read again asks for an answer younger than the reader's cache: never one sooner than that cache allows.
  clock = 1_000 + 14_999;
  assert.equal(reuse.ask(key, ok(key), reads.READER_POOLS_CACHE_MS), first, 'within the reader’s 15 s, the kept answer');
  assert.equal(reuse.ask(key, ok(key), 0), first, 'asked for a fresh one: still never within the reader’s 15 s');
  clock = 1_000 + 15_000;
  const fresh = reuse.ask(key, ok(key), reads.READER_POOLS_CACHE_MS);
  assert.notEqual(fresh, first, 'past the reader’s cache, a price read again reads');
  await fresh;
  assert.deepEqual(asked, [key, 'pair', key]);
  // A failure is dropped as it lands: asked again (after its own wait), it reads again.
  const failing = reads.poolsKey(42161, LIVE);
  const failed = reuse.ask(failing, answer({ kind: 'failed', passing: true, retryAfterS: 2 })(failing));
  await failed;
  await Promise.resolve();
  assert.notEqual(reuse.ask(failing, ok(failing)), failed, 'a failure is not kept');
  assert.deepEqual(asked, [key, 'pair', key, failing, failing]);
  // At most 64 tokens are kept, the oldest dropped first.
  const small = reads.createAnswerReuse(() => true, () => clock, 2);
  const a = small.ask('a', ok('a')), b = small.ask('b', ok('b'));
  small.ask('c', ok('c'));
  assert.equal(small.ask('b', ok('b')), b);
  assert.notEqual(small.ask('a', ok('a')), a, 'the oldest went first');
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §1: respect the Retry-After, now the real time to the lane's next token): a
// busy reader's refusal is kept for every caller until its Retry-After has passed, so none asks the same chain-pools again
// sooner (a pasted address's pools, chosen a moment after its search was refused, included); a refusal that names no wait
// is dropped as it lands, as before.
test('a busy reader’s refusal is kept for every caller until its Retry-After has passed, then read again', async () => {
  let clock = 50_000;
  const asked = [];
  const hold = (said) => (said.kind === 'failed' && said.retryAfterS !== undefined ? said.retryAfterS * 1000 : 0);
  const reuse = reads.createAnswerReuse((said) => said.kind === 'ok', () => clock, 64, hold);
  const reading = (name, said) => () => { asked.push(name); return Promise.resolve(said); };
  const key = reads.poolsKey(8453, LIVE);
  const busy = reuse.ask(key, reading('busy', { kind: 'failed', passing: true, retryAfterS: 6 }));
  await busy;
  await Promise.resolve();
  clock += 5_999;
  assert.equal(reuse.ask(key, reading('early', { kind: 'ok' })), busy, 'within its 6 s: the same refusal, nothing asked');
  assert.equal(reuse.ask(key, reading('early', { kind: 'ok' }), 0), busy, 'a price read again waits too');
  clock += 1;
  const after = reuse.ask(key, reading('after', { kind: 'ok' }));
  assert.notEqual(after, busy, 'its Retry-After passed: read again');
  await after;
  // No wait named: dropped as it lands.
  const other = reads.poolsKey(42161, LIVE);
  const failed = reuse.ask(other, reading('failed', { kind: 'failed', passing: true }));
  await failed;
  await Promise.resolve();
  assert.notEqual(reuse.ask(other, reading('again', { kind: 'ok' })), failed);
  assert.deepEqual(asked, ['busy', 'after', 'failed', 'again']);
});

// Added 2026-11-02 (review M1, REVISAO_DINHEIRO_LOGIN.md). A link #/new/network/8453/<token>/<pool> opened New position
// with any token that had decimals chosen (resolvedOf), and the link's pool chosen as soon as Base's own read listed it:
// an attacker's "USDC" on Base, its pool against WETH, opened chosen with no word about it. The search lists such a
// token with its warning and never chooses it; Robinhood Chain's link refuses a pool with one (audit I1). Now the same
// rule refuses it, whichever way it comes (a link, a pasted address chosen in the search, its Markets page), and a link's
// pool with one is marked so the network's list never chooses it.
test('review M1: a token passing for one of the network’s own currencies is never resolved for use, and a pool with one is marked for the link', () => {
  const FAKE = '0x9999999999999999999999999999999999999999';
  const token = (address, symbol, decimals = 6) => ({ address, decimals, price: null, priceReason: 'no_pool', status: 'available', symbol });
  const answer = (symbol) => {
    const said = structuredClone(fixture('chain-pools'));
    said.tokens = [...said.tokens.filter((entry) => entry.address !== FAKE), token(FAKE, symbol)];
    return said;
  };
  const refusal = (main) => ({ ok: false, code: 'token_lookalike', reason: `This isn’t the ${main} Domino uses. Adding money to its pools can lose it.` });
  // Robinhood Chain's own words for such a token (its search and token page), kept equal here.
  const { warningText } = require(`${BUILD}lib/read/screens/lookalike.js`);
  for (const main of ['USDC', 'WETH', 'ETH']) assert.equal(refusal(main).reason, warningText({ kind: 'lookalike', address: FAKE, main }, 'token'));
  // A "USDC" an attacker deployed: refused, in the words the search and the token pages use, as are the ways it can be
  // spelled to read as USDC (a Cyrillic С, a 5 for an S, a space inside): Robinhood Chain's own reading (audit I2).
  for (const symbol of ['USDC', 'usdc', 'USDС', 'U5DC', 'US DC']) assert.deepEqual(reads.resolvedOf(8453, FAKE, answer(symbol)), refusal('USDC'), symbol);
  assert.deepEqual(reads.resolvedOf(42161, FAKE, answer('WETH')), refusal('WETH'), 'Arbitrum One: its own WETH');
  assert.deepEqual(reads.resolvedOf(8453, FAKE, answer('ETH')), refusal('ETH'));
  // Any other token, and the network's own currencies at their own addresses, as before.
  assert.equal(reads.resolvedOf(8453, LIVE, fixture('chain-pools')).ok, true);
  assert.equal(reads.resolvedOf(8453, FAKE, answer('USDbC')).ok, true, 'another symbol is not a look-alike');
  assert.equal(reads.resolvedOf(8453, WETH_BASE, fixture('chain-pools')).ok, true, 'Base’s own WETH');
  assert.equal(reads.lookalikeOf(8453, { address: USDC_BASE, symbol: 'USDC' }), null);
  assert.equal(reads.lookalikeOf(8453, { address: FAKE, symbol: 'USDС' }), 'USDC');
  // Read through the wallet (the search's fallback), the same rule.
  assert.deepEqual(reads.usableNetworkToken(8453, networks.displayOf(8453, { address: FAKE, symbol: 'USDC', decimals: 6 })), refusal('USDC'));
  assert.equal(reads.usableNetworkToken(8453, chosen).ok, true);
  // A pool with such a token is marked; the link's pool is then refused, never chosen; a pool without one is chosen.
  const pooled = answer('USDC');
  pooled.pools.push({ ...structuredClone(pooled.pools[1]), id: `0x${'ab'.repeat(32)}`, pool: { ...pooled.pools[1].pool, currency0: LIVE, currency1: FAKE } });
  const rows = reads.poolsOfAnswer(8453, chosen, pooled, 1_000_000);
  assert.equal(rows.length, 3);
  const warned = reads.lookalikePools(8453, rows);
  assert.deepEqual(warned, [`0x${'ab'.repeat(32)}`]);
  assert.deepEqual(otherChains.linkedNetworkPool(rows, `0x${'AB'.repeat(32)}`, warned), { option: rows[2], refused: true });
  assert.deepEqual(otherChains.linkedNetworkPool(rows, rows[1].key, warned), { option: rows[1], refused: false });
  assert.equal(otherChains.linkedNetworkPool(rows, `0x${'cd'.repeat(32)}`, warned), null, 'a pool the read does not list is never chosen');
  assert.equal(otherChains.linkedNetworkPool(rows, null, warned), null);
});
