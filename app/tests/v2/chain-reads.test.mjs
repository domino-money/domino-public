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

test('a pasted address is named where it is a token on that network, and nothing where it is not', () => {
  const named = reads.pastedOf(8453, LIVE.toUpperCase().replace('0X', '0x'), fixture('chain-pools'));
  assert.equal(named.state, 'token');
  assert.deepEqual([named.token.address, named.token.symbol, named.token.decimals, named.token.chainId], [LIVE, 'LIVE', 18, 8453]);
  assert.deepEqual(reads.pastedOf(8453, '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f', fixture('chain-pools-none')), { state: 'none' }, 'no contract there: not listed');
  const partial = structuredClone(fixture('chain-pools'));
  const live = partial.tokens.find((token) => token.address === LIVE);
  Object.assign(live, { decimals: null, status: 'partial' });
  assert.deepEqual(reads.pastedOf(8453, LIVE, partial), { state: 'none' }, 'a contract without decimals is no token to use');
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
