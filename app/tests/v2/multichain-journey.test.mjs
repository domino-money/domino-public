/**
 * The owner's New position on Base and Arbitrum One (2026-10-05, the owner: "the search on the screen, across the three
 * networks; the results get the network's tag", and creating there through Domino V2; spec F7 rev4 §1.2-§1.4, §6.1,
 * §6.2): what is pure of it and the one new read.
 *
 *   - finance/v2/zap.ts readPools: many pools at one block through the chain profile's Multicall3, two reads in one
 *     bounded operation, each answer what readPool says of that pool;
 *   - src/v2in/journey/model/networks.ts: which networks are offered (a live S1 gate only), the hits a search text names
 *     (the profile's tokens by symbol, a pasted address on each network), the pools to read for a token (every pair with
 *     the profile's tokens at every tier; native ETH is v4's alone; ETH never pairs with WETH), and the rows they become
 *     (the pools a position can open in now, grouped and ordered; a v3 pool keyed by its address as a 32-byte word);
 *   - src/v2in/journey/model/fromV1.ts and pools.ts: such a row read for the plan on its own network, v3 or v4;
 *   - lib/create/journey.ts: identity is chain plus address, so Base's ETH never keeps a Robinhood Chain pool;
 *   - lib/read/orientation.ts: those networks' USDC and WETH as quotes, so "1 ETH = X USDC" on every step.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createV2Chain, walletOf, poolIdOf } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const { createZapClient } = require(`${BUILD}finance/v2/zap.js`);
const { forgetV2DeploymentChecks } = require(`${BUILD}finance/v2/deployment.js`);
const chains = require(`${BUILD}v2/chains.js`);
const networks = require(`${BUILD}v2in/journey/model/networks.js`);
const fromV1 = require(`${BUILD}v2in/journey/model/fromV1.js`);
const journey = require(`${BUILD}lib/create/journey.js`);
const otherChains = require(`${BUILD}lib/create/otherChains.js`);
const orientation = require(`${BUILD}lib/read/orientation.js`);

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TOKEN = '0x1111111111111111111111111111111111111111';

const ETH_USDC_V4 = { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
const ETH_USDC_V4_30 = { ...ETH_USDC_V4, fee: 3000, tickSpacing: 60 };
const WETH_USDC_V3 = { dex: 3, currency0: WETH_BASE, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
const WETH_USDC_V3_EXTRA = { ...WETH_USDC_V3, fee: 200, tickSpacing: 4 };
const SQRT = 3_543_191_142_285_914_205_922_034n;
const LIVE = (chainId) => ({ mode: 'live', chainId, locked: false, contracts: { chainId } });
const GATES = { 4663: LIVE(4663), 8453: LIVE(8453), 42161: LIVE(42161) };

test('readPools: every pool at one block through Multicall3, two reads in one operation, each answer readPool\'s', async () => {
  forgetV2DeploymentChecks();
  const chain = createV2Chain({
    chainId: 8453,
    pools: [
      { pool: ETH_USDC_V4, sqrtPriceX96: SQRT, tick: -197_000, liquidity: 10n ** 18n },
      { pool: WETH_USDC_V3, sqrtPriceX96: SQRT, tick: -197_001, liquidity: 7n * 10n ** 17n },
      { pool: WETH_USDC_V3_EXTRA, sqrtPriceX96: SQRT, tick: -197_002, liquidity: 5n },
    ],
  });
  const client = createZapClient(walletOf(chain), chains.v2Chain(8453), chain.contracts, () => fx.NOW);
  const asked = [ETH_USDC_V4, ETH_USDC_V4_30, WETH_USDC_V3, WETH_USDC_V3_EXTRA, { ...WETH_USDC_V3, fee: 10_000, tickSpacing: 200 }];
  const before = chain.log.length;
  const found = await client.readPools(asked);
  const calls = chain.log.slice(before);
  // Two v4 pools (slot0 and liquidity each), three v3 pools (the factory's getPool each) and their three tiers' spacing; then
  // slot0 and liquidity of the two v3 pools that exist.
  assert.deepEqual(chain.multicalls, [2 * 2 + 3 + 3, 2 * 2], 'one aggregate3 for the StateView, the factory and its tiers; one for the v3 pools that exist');
  assert.equal(calls.filter((method) => method === 'eth_call').length, 2, 'two reads of the chain, whatever the number of pools');
  assert.equal(found.length, asked.length);
  // Each answer is readPool's for that pool.
  for (const [index, pool] of asked.entries()) {
    const one = await client.readPool(pool);
    assert.deepEqual({ ...found[index] }, { ...one }, `${pool.dex}:${pool.fee}`);
  }
  assert.deepEqual(found.map((entry) => [entry.exists, entry.initialized, entry.spacingOk]), [[true, true, true], [false, false, true], [true, true, true], [true, true, true], [false, false, true]]);
  assert.equal(found[0].id, poolIdOf(ETH_USDC_V4), 'a v4 pool by its id');
  assert.match(found[2].id, /^0x[0-9a-f]{40}$/, 'a v3 pool by its address');
  assert.equal(found[3].liquidity, 5n, 'Base\'s 0.02% tier, confirmed by the factory');
  assert.deepEqual(await client.readPools([]), [], 'nothing asked, nothing read');
  await assert.rejects(client.readPools([{ ...ETH_USDC_V4, currency0: USDC_BASE, currency1: ZERO }]), /plan_pool_order/);
});

test('the networks offered are the ones whose S1 gate is live; the search names their profile tokens and a pasted address on each', () => {
  assert.deepEqual(networks.offeredNetworks(GATES), [8453, 42161]);
  assert.deepEqual(networks.offeredNetworks({ ...GATES, 42161: { mode: 'preview', chainId: 42161, locked: true } }), [8453], 'a locked network is not offered');
  assert.deepEqual(networks.offeredNetworks(null), []);
  const both = [8453, 42161];
  assert.deepEqual(networks.networkTokens('e', both), [], 'two characters at least, as today\'s search');
  // Closest first (ETH exact before WETH), Base before Arbitrum One for the same match.
  assert.deepEqual(networks.networkTokens('eth', both).map((row) => `${row.network}:${row.token.symbol}`), ['Base:ETH', 'Arbitrum One:ETH', 'Base:WETH', 'Arbitrum One:WETH']);
  const usd = networks.networkTokens(' USD ', both);
  assert.deepEqual(usd.map((row) => [row.chainId, row.token.address, row.token.decimals]), [[8453, USDC_BASE, 6], [42161, USDC_ARB, 6]]);
  assert.ok(usd.every((row) => row.unread === false && row.token.readStatus === 'available' && row.token.origin === 'read'));
  assert.deepEqual(networks.networkTokens('usdg', both), [], 'Robinhood Chain\'s dollar is not on those networks');
  assert.deepEqual(networks.networkTokens('weth', both).map((row) => row.token.artwork), ['WETH', 'WETH'], 'the network\'s own WETH, by address');
  // Added 2026-10-06 (the review of the next update): each is the network's own currency, for Enter's choice (preselectOf).
  assert.ok(networks.networkTokens('eth', both).every((row) => row.own === true));
  // An address: a profile token as it is named there, any other to read once chosen.
  assert.deepEqual(networks.networkTokens(USDC_BASE.toUpperCase().replace('0X', '0x'), both).map((row) => [row.chainId, row.unread, row.token.symbol, row.own ?? null]), [[8453, false, 'USDC', true], [42161, true, null, null]]);
  assert.deepEqual(networks.networkTokens(TOKEN, [8453]).map((row) => [row.chainId, row.unread, row.token.address]), [[8453, true, TOKEN]]);
  assert.deepEqual(networks.networkTokens('0x1234', both), [], 'half an address names nothing');
});

test('the pools to read for a token: each profile token at every tier of v4 and v3, hookless, each once; native ETH is v4\'s alone', () => {
  const key = (pool) => `${pool.dex}:${pool.currency0}:${pool.currency1}:${pool.fee}:${pool.tickSpacing}`;
  const usdc = networks.poolsToRead(8453, USDC_BASE);
  assert.equal(new Set(usdc.map(key)).size, usdc.length, 'each pool once');
  assert.ok(usdc.every((pool) => pool.hooks === ZERO && BigInt(pool.currency0) < BigInt(pool.currency1)));
  // v4: with ETH and with WETH at the four tiers; v3: with WETH (ETH is WETH there) at Base's seven tiers.
  assert.equal(usdc.filter((pool) => pool.dex === 4).length, 8);
  assert.deepEqual(usdc.filter((pool) => pool.dex === 3).map((pool) => pool.fee), [100, 200, 300, 400, 500, 3000, 10000]);
  assert.ok(usdc.filter((pool) => pool.dex === 3).every((pool) => pool.currency0 === WETH_BASE));
  const eth = networks.poolsToRead(8453, ZERO);
  assert.ok(eth.every((pool) => pool.dex === 4), 'a chosen ETH asks no v3 pool: v3 pools hold WETH');
  assert.ok(eth.every((pool) => pool.currency1 === USDC_BASE), 'and never pairs with WETH');
  const weth = networks.poolsToRead(42161, WETH_ARB);
  assert.ok(weth.every((pool) => pool.currency0 !== ZERO && pool.currency1 !== ZERO), 'WETH never pairs with ETH');
  assert.deepEqual(weth.filter((pool) => pool.dex === 3).map((pool) => pool.fee), [100, 500, 3000, 10000], 'Arbitrum One has no extra tiers');
  const other = networks.poolsToRead(8453, TOKEN);
  assert.equal(other.length, 4 * 3 + 7 * 2, 'any token: v4 with ETH, WETH and USDC; v3 with WETH and USDC');
});

test('the rows: the pools a position can open in now, grouped by what the token pairs with, the most liquidity first; keyed as today\'s list keys them', () => {
  const token = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const v3Address = '0x00000000000000000000000000000000000c0ffe';
  const at = (pool, fields) => ({ pool, id: pool.dex === 4 ? poolIdOf(pool) : v3Address, exists: true, initialized: true, sqrtPriceX96: SQRT, tick: -197_000, liquidity: 10n, block: 31_000_000n, spacingOk: true, ...fields });
  const found = [
    at(ETH_USDC_V4, { liquidity: 10n ** 15n }),
    at(ETH_USDC_V4_30, { liquidity: 10n ** 18n }),
    at(WETH_USDC_V3, { liquidity: 10n ** 17n }),
    at(WETH_USDC_V3_EXTRA, { liquidity: 0n }),
    at({ ...WETH_USDC_V3, fee: 3000, tickSpacing: 60 }, { initialized: false, sqrtPriceX96: 0n }),
    at({ ...WETH_USDC_V3, fee: 100, tickSpacing: 1 }, { spacingOk: false }),
    at({ ...ETH_USDC_V4, fee: 100, tickSpacing: 1 }, { exists: false, initialized: false, sqrtPriceX96: 0n }),
  ];
  const rows = networks.listedPools(8453, token, found, 1_700_000_000_000);
  // ETH and WETH are one group (the same decimals, so their liquidity compares): the most liquidity in range first.
  assert.deepEqual(rows.map((row) => [row.dex, row.feePips]), [[4, 3000], [3, 500], [4, 500]], 'no empty, unpriced, unconfirmed or missing pool');
  const [first, second] = rows;
  assert.deepEqual(first.currencies.map((currency) => [currency.chainId, currency.address, currency.symbol, currency.artwork]), [[8453, ZERO, 'ETH', 'ETH'], [8453, USDC_BASE, 'USDC', null]]);
  assert.equal(first.key, poolIdOf(ETH_USDC_V4_30));
  assert.equal(second.key, `0x${'0'.repeat(24)}${v3Address.slice(2)}`, 'a v3 pool: its address as a 32-byte word');
  assert.deepEqual([second.fee, second.hooks, second.integration, second.kind, second.catalogue, second.block, second.readAt], ['0.05%', ZERO, 'hookless_fixed_fee', 'discovery', null, 31_000_000, 1_700_000_000_000]);
  assert.deepEqual([second.liquidity.state, second.volume.state, second.providerNote], ['unavailable', 'unavailable', null], 'no TVL or volume is invented');
  // And back: the PoolRef of a row, for a price read again.
  assert.deepEqual(networks.refOf(second), WETH_USDC_V3);
  assert.deepEqual(networks.refOf(first), ETH_USDC_V4_30);
});

test('a row of another network read for the plan: its network, its version, a v3 pool by its address', () => {
  const token = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const v3Address = '0x00000000000000000000000000000000000c0ffe';
  const [row] = networks.listedPools(8453, token, [{ pool: WETH_USDC_V3, id: v3Address, exists: true, initialized: true, sqrtPriceX96: SQRT, tick: -197_000, liquidity: 10n ** 17n, block: 31_000_000n, spacingOk: true }], 1);
  const zap = fromV1.zapStateFromV1({ pool: row, range: { lower: -197_100, upper: -196_900 }, slippageBps: '50' });
  assert.equal(zap.chainId, 8453);
  assert.deepEqual(zap.pool.pool, WETH_USDC_V3);
  assert.equal(zap.pool.id, v3Address);
  assert.equal(zap.pool.chainId, 8453);
  const funding = fromV1.inputsFromV1(zap, { need: [10n ** 17n, 250_000_000n], plan: { kind: 'both', amount0: 10n ** 17n, amount1: 250_000_000n } });
  const request = fromV1.requestFromV1(zap, funding, 'direct');
  assert.deepEqual([request.chainId, request.pool.dex, request.pool.fee], [8453, 3, 500]);
  // A key that is not a v3 address word, or currencies of two networks, is never read for a plan.
  assert.equal(fromV1.zapStateFromV1({ pool: { ...row, key: `0x${'ab'.repeat(32)}` }, range: zap.range, slippageBps: '50' }), null);
  assert.equal(fromV1.zapStateFromV1({ pool: { ...row, currencies: [row.currencies[0], { ...row.currencies[1], chainId: 42161 }] }, range: zap.range, slippageBps: '50' }), null);
});

test('identity is chain plus address: Base\'s ETH never keeps a Robinhood Chain pool, or its amount', () => {
  const robinhoodEth = { origin: 'read', chainId: 4663, address: ZERO, symbol: 'ETH', decimals: 18, readStatus: 'available', artwork: 'ETH' };
  const usdg = { origin: 'read', chainId: 4663, address: USDG, symbol: 'USDG', decimals: 6, readStatus: 'available', artwork: 'USDG' };
  const pool = { key: `0x${'cd'.repeat(32)}`, currencies: [robinhoodEth, usdg], hooks: ZERO, feePips: 500 };
  const robinhood = otherChains.networkCandidate(robinhoodEth);
  const base = otherChains.networkCandidate({ ...robinhoodEth, chainId: 8453 });
  assert.equal(journey.poolHoldsToken(pool, robinhood), true);
  assert.equal(journey.poolHoldsToken(pool, base), false, 'the same address on Base');
  const state = { ...journey.initialState(), token: robinhood, pool, range: { lower: 1, upper: 2 }, budget: '1.5' };
  const moved = journey.withToken(state, base);
  assert.deepEqual([moved.pool, moved.range, moved.budget], [null, null, ''], 'the pool, its range and the amount go');
  const kept = journey.withToken(state, otherChains.networkCandidate(robinhoodEth));
  assert.deepEqual([kept.pool, kept.budget], [pool, '1.5'], 'Robinhood Chain\'s ETH again keeps all three, as before');
  assert.equal(otherChains.onOtherChain(base.token), true);
  assert.equal(otherChains.poolOnOtherChain(pool), false);
  assert.equal(base.why, null, 'chosen, selectable');
});

test('Base\'s and Arbitrum One\'s USDC and WETH are quotes, so their pools read "1 ETH = X USDC"; Robinhood Chain\'s are unchanged', () => {
  assert.equal(orientation.quoteRank(USDC_BASE), 2);
  assert.equal(orientation.quoteRank(USDC_ARB.toUpperCase().replace('0X', '0x')), 2);
  assert.equal(orientation.quoteRank(WETH_BASE), 1);
  assert.equal(orientation.quoteRank(WETH_ARB), 1);
  assert.equal(orientation.priceInverted(ZERO, USDC_BASE), false, 'ETH/USDC: 1 ETH = X USDC');
  assert.equal(orientation.priceInverted(USDC_ARB, TOKEN), true, 'USDC/TOKEN: 1 TOKEN = X USDC');
  assert.equal(orientation.priceInverted(ZERO, USDG), false);
  assert.equal(orientation.quoteRank(TOKEN), 0);
});

// ---------------------------------------------------------------------------
// 2026-10-06, the owner's point 3: Base and Arbitrum One in New position "like Robinhood Chain"
// ---------------------------------------------------------------------------

const rowApr = require(`${BUILD}lib/read/screens/rowApr.js`);

test('the gates read again: a network once live stays live; one that says the same keeps its gate, so nothing starts over', () => {
  const preview = (chainId) => ({ mode: 'preview', chainId, locked: true, lockedCopy: 'later' });
  const held = Object.freeze({ 4663: LIVE(4663), 8453: preview(8453), 42161: preview(42161) });
  assert.equal(networks.mergeGates(null, held), held);
  assert.equal(networks.mergeGates(held, { 4663: LIVE(4663), 8453: preview(8453), 42161: preview(42161) }), held, 'nothing changed: the very gates held');
  const next = { 4663: preview(4663), 8453: LIVE(8453), 42161: preview(42161) };
  const merged = networks.mergeGates(held, next);
  assert.equal(merged[4663], held[4663], 'live stays live, its own gate');
  assert.equal(merged[8453], next[8453], 'Base live now');
  assert.equal(merged[42161], held[42161], 'the same word: the gate held');
  assert.deepEqual(networks.offeredNetworks(merged), [8453]);
  assert.ok(Object.isFrozen(merged));
});

test('a pool read through the wallet has no protocol fee read, so no APR is worked out for it; its facts are its active liquidity', () => {
  const token = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const found = [{ pool: ETH_USDC_V4, id: poolIdOf(ETH_USDC_V4), exists: true, initialized: true, sqrtPriceX96: SQRT, tick: -197_000, liquidity: 10n ** 15n, block: 31_000_000n, spacingOk: true }];
  const [row] = networks.listedPools(8453, token, found, 1);
  assert.equal(row.protocolFeeRaw, otherChains.PROTOCOL_FEE_UNDESCRIBED);
  assert.deepEqual(networks.factsOfFound(found), { [poolIdOf(ETH_USDC_V4)]: { depthUsd: null, liquidity: String(10n ** 15n) } });
});

/** DEX Screener's figures as the store gives them, by chain and name. */
const dexOf = (entries) => (chainId, name) => entries.find((entry) => entry.chainId === chainId && entry.poolId === name.toLowerCase()) ?? null;
const figuresOf = (chainId, poolId, base, quote, liquidityUsd, volume24hUsd = '1000.00') => ({ chainId, poolId, base, quote, liquidityUsd, volume24hUsd, retrievedAt: 1_790_000_000 });
const V3_ADDRESS = '0x00000000000000000000000000000000000c0ffe';
const onChain = (pool, fields = {}) => ({ pool, id: pool.dex === 4 ? poolIdOf(pool) : V3_ADDRESS, exists: true, initialized: true, sqrtPriceX96: SQRT, tick: 0, liquidity: 10n, block: 1n, spacingOk: true, ...fields });

test('networkRows: DEX Screener’s TVL and 24h volume on the very pool (its v4 id or v3 address, both currencies its own), attributed and dated; the APR follows; anything else keeps its dash', () => {
  const token = networks.displayOf(8453, { address: TOKEN, symbol: 'TOKEN', decimals: 18 });
  const V4_ETH = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V3_WETH = { dex: 3, currency0: TOKEN, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V4_USDC = { dex: 4, currency0: TOKEN, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
  // Through the wallet, then given chain-pools' protocol fees (none here) as the service's rows carry them.
  const rows = networks.listedPools(8453, token, [onChain(V4_ETH), onChain(V3_WETH), onChain(V4_USDC)], 1).map((row) => ({ ...row, protocolFeeRaw: 0 }));
  const shown = otherChains.networkRows(rows, dexOf([
    figuresOf(8453, poolIdOf(V4_ETH), TOKEN, ZERO, '35138.92', '8844.96'),
    figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '166296.81', '21085.45'),
    // The name of Base's v4 TOKEN/USDC pool, but another pair: never taken.
    figuresOf(8453, poolIdOf(V4_USDC), TOKEN, WETH_BASE, '1.00'),
  ]));
  assert.deepEqual(shown.map((row) => [row.dex, row.feePips, row.liquidity.state === 'attributed' ? row.liquidity.raw : row.liquidity.state]), [[3, 3000, '166296.81'], [4, 3000, '35138.92'], [4, 500, 'unavailable']], 'the largest reported TVL first, a pool with none last');
  const [v3, v4, usdc] = shown;
  assert.deepEqual(v3.liquidity, { state: 'attributed', value: '$166.3K', raw: '166296.81', zero: false, provider: 'dexscreener', retrievedAt: 1_790_000_000, cacheAgeSeconds: null }, 'the same figure a Robinhood Chain row’s stand-in is');
  assert.equal(v4.volume.raw, '8844.96');
  assert.match(v4.providerNote, /^Provider figures retrieved \d\d:\d\d:\d\d UTC/);
  const apr = rowApr.rowApr({ integration: v4.integration, currentLpFeePips: v4.feePips, protocolFeeRaw: v4.protocolFeeRaw, liquidity: v4.liquidity, volume: v4.volume });
  assert.deepEqual(apr, { kind: 'estimate', text: '27.56', stale: false }, '0.30% of $8,844.96 a day over $35,138.92, a year of days');
  assert.equal(usdc.liquidity.state, 'unavailable', 'a pair that is not the pool’s keeps its dash');
  // Another chain's figures under the same name are never this chain's.
  assert.ok(otherChains.networkRows(rows, dexOf([figuresOf(42161, poolIdOf(V4_ETH), TOKEN, ZERO, '9.00')])).every((row) => row.liquidity.state === 'unavailable'));
  // A volume the provider did not report: the TVL shows, the volume is "not reported", and the APR a dash.
  const [lone] = otherChains.networkRows([rows[0]], dexOf([figuresOf(8453, poolIdOf(V4_ETH), ZERO, TOKEN, '10.00', null)]));
  assert.deepEqual([lone.liquidity.state, lone.volume.state], ['attributed', 'not_reported']);
});

test('networkRows: a v3 and a v4 pool of one pair and fee are one row: the larger DEX Screener TVL, else the deeper, else the more liquid; the chosen one stays', () => {
  const token = networks.displayOf(8453, { address: TOKEN, symbol: 'TOKEN', decimals: 18 });
  const V4 = { dex: 4, currency0: TOKEN, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V3 = { dex: 3, currency0: TOKEN, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const OTHER_FEE = { ...V4, fee: 10_000, tickSpacing: 200 };
  const rows = networks.listedPools(8453, token, [onChain(V4), onChain(V3), onChain(OTHER_FEE)], 1);
  const [v4Key, v3Key, otherKey] = [poolIdOf(V4), `0x${'0'.repeat(24)}${V3_ADDRESS.slice(2)}`, poolIdOf(OTHER_FEE)];
  const kept = (shown) => shown.map((row) => row.key).sort();
  const none = dexOf([]);
  // By DEX Screener's TVL when both pools have one.
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '500.00'), figuresOf(8453, v4Key, TOKEN, WETH_BASE, '20.00')]))), [v3Key, otherKey].sort());
  // Changed on purpose 2026-10-06 (review): a TVL on one side alone decides nothing (DEX Screener lists no v4 pool on
  // Arbitrum One): the depth both have, else the liquidity both have, else the first (the service's more liquid one).
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '500.00')]), { [v4Key]: { depthUsd: '900.0', liquidity: '1' }, [v3Key]: { depthUsd: '10.0', liquidity: '1' } })), [v4Key, otherKey].sort(), 'the v4 twin measured deeper, though only the v3 one has a TVL');
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '500.00')]), { [v4Key]: { depthUsd: null, liquidity: '5' }, [v3Key]: { depthUsd: '10.0', liquidity: '9' } })), [v3Key, otherKey].sort(), 'no depth both have: the liquidity');
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, v4Key, TOKEN, WETH_BASE, '20.00')]))), [v4Key, otherKey].sort(), 'nothing both have: the first stays');
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '500.00')]))), [v4Key, otherKey].sort(), 'the same the other way round');
  // Else by the depth chain-pools measured, else by active liquidity.
  assert.deepEqual(kept(otherChains.networkRows(rows, none, { [v4Key]: { depthUsd: '10.5', liquidity: '9' }, [v3Key]: { depthUsd: '99.0', liquidity: '1' } })), [v3Key, otherKey].sort());
  assert.deepEqual(kept(otherChains.networkRows(rows, none, { [v4Key]: { depthUsd: null, liquidity: '900' }, [v3Key]: { depthUsd: null, liquidity: '1000' } })), [v3Key, otherKey].sort());
  assert.deepEqual(kept(otherChains.networkRows(rows, none, { [v4Key]: { depthUsd: null, liquidity: '1000' }, [v3Key]: { depthUsd: null, liquidity: '900' } })), [v4Key, otherKey].sort());
  // The row already chosen stays, whatever the figures say.
  assert.deepEqual(kept(otherChains.networkRows(rows, dexOf([figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '500.00')]), {}, v4Key)), [v4Key, otherKey].sort());
  // ETH and WETH are two partners a beginner tells apart by name: never collapsed.
  const ETH = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
  assert.equal(otherChains.networkRows(networks.listedPools(8453, token, [onChain(ETH), onChain(V3)], 1), none).length, 2);
  assert.equal(otherChains.dexNameOf(rows.find((row) => row.dex === 3)), V3_ADDRESS, 'a v3 pool is named by its address');
});

// Added 2026-10-06 (review): byTvl's fallback (fee tier, then id) put a near-empty 0.01% pool first whenever DEX Screener
// had no figure (every Arbitrum One v4 row, every list before the provider answers).
test('networkRows: rows without figures keep the order they came in (ETH and WETH partners, the most liquidity first), never the fee tier’s; their depths order them only when every one has one', () => {
  const token = networks.displayOf(8453, { address: TOKEN, symbol: 'TOKEN', decimals: 18 });
  const ETH_30 = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const WETH_100 = { dex: 4, currency0: TOKEN, currency1: WETH_BASE, fee: 10_000, tickSpacing: 200, hooks: ZERO };
  const USDC_1 = { dex: 4, currency0: TOKEN, currency1: USDC_BASE, fee: 100, tickSpacing: 1, hooks: ZERO };
  const rows = networks.listedPools(8453, token, [onChain(USDC_1, { liquidity: 10n }), onChain(WETH_100, { liquidity: 10n ** 20n }), onChain(ETH_30, { liquidity: 10n ** 24n })], 1);
  const order = (shown) => shown.map((row) => row.key);
  const listed = [poolIdOf(ETH_30), poolIdOf(WETH_100), poolIdOf(USDC_1)];
  assert.deepEqual(order(rows), listed, 'as they come: ETH and WETH partners first, the most liquid first');
  const none = dexOf([]);
  assert.deepEqual(order(otherChains.networkRows(rows, none)), listed, 'no figures: as they came, never the 0.01% pool first');
  // Every one measured (qualified USD): the deepest first.
  const depths = { [poolIdOf(ETH_30)]: { depthUsd: '50.0', liquidity: '1' }, [poolIdOf(WETH_100)]: { depthUsd: '10.0', liquidity: '1' }, [poolIdOf(USDC_1)]: { depthUsd: '900.0', liquidity: '1' } };
  assert.deepEqual(order(otherChains.networkRows(rows, none, depths)), [poolIdOf(USDC_1), poolIdOf(ETH_30), poolIdOf(WETH_100)]);
  // One not measured, which may be the deepest: as they came.
  assert.deepEqual(order(otherChains.networkRows(rows, none, { ...depths, [poolIdOf(ETH_30)]: { depthUsd: null, liquidity: '1' } })), listed);
  // A reported TVL first, as Robinhood Chain's list; the rest after it as they came.
  assert.deepEqual(order(otherChains.networkRows(rows, dexOf([figuresOf(8453, poolIdOf(WETH_100), TOKEN, WETH_BASE, '12.00')]))), [poolIdOf(WETH_100), poolIdOf(ETH_30), poolIdOf(USDC_1)]);
});

test('mergeHits: every network’s hits by match quality, exact first, today’s first between two of one quality, each list in its own order', () => {
  const home = [{ name: 'VIRTUAL', rank: 0 }, { name: 'VIRTUAL', rank: 0 }, { name: 'VIRTUALS', rank: 1 }, { name: 'XVIRTUAL', rank: 2 }];
  const network = [{ token: { symbol: 'VIRTUAL' }, chainId: 8453 }, { token: { symbol: 'VIRTUALX' }, chainId: 8453 }, { token: { symbol: 'Wrapped Virtual' }, chainId: 42161 }];
  const named = (merged) => merged.map((entry) => ('home' in entry ? `rh:${entry.home.name}` : `${entry.network.chainId}:${entry.network.token.symbol}`));
  const merged = otherChains.mergeHits(home, (hit) => hit.rank, network, 'virtual');
  assert.deepEqual(named(merged), ['rh:VIRTUAL', 'rh:VIRTUAL', '8453:VIRTUAL', 'rh:VIRTUALS', '8453:VIRTUALX', 'rh:XVIRTUAL', '42161:Wrapped Virtual']);
  // An exact match on Base is not buried under twenty prefix matches on Robinhood Chain.
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `USDC${i}`, rank: 1 }));
  assert.deepEqual(otherChains.mergeHits(many, (hit) => hit.rank, [{ token: { symbol: 'USDC' } }], 'usdc')[0], { network: { token: { symbol: 'USDC' } } });
  assert.deepEqual(otherChains.mergeHits(home, (hit) => hit.rank, [], 'virtual').map((entry) => entry.home), home, 'without other networks, today’s list exactly');
  assert.deepEqual(['usdc', 'us', 'sd', 'eth', ''].map((query) => otherChains.hitRank('USDC', query)), [0, 1, 2, 3, 3]);
  assert.equal(otherChains.hitRank(null, 'usdc'), 3);
  // Added 2026-10-06 (review: rugged's "virtual"): Robinhood Chain's two copies with no liquidity after Base's real token,
  // and after every hit of their quality that may have some, whatever its network; still before the next quality.
  const copies = [{ name: 'VIRTUAL', rank: 0, empty: true }, { name: 'VIRTUAL', rank: 0, empty: true }, { name: 'VIRTUALS', rank: 1 }];
  const real = [{ token: { symbol: 'VIRTUAL' }, chainId: 8453 }, { token: { symbol: 'VIRTUAL' }, chainId: 42161, empty: true }];
  const sorted = otherChains.mergeHits(copies, (hit) => hit.rank, real, 'virtual', { home: (hit) => hit.empty === true, network: (row) => row.empty === true });
  assert.deepEqual(named(sorted), ['8453:VIRTUAL', 'rh:VIRTUAL', 'rh:VIRTUAL', '42161:VIRTUAL', 'rh:VIRTUALS']);
});

// Added 2026-10-06 (review): audit V3's rule ("UFG": Enter chose the copy without a logo) across networks.
test('preselectOf: Enter takes the first hit only when no other hit of any network has its name, or it is clearly the real one; never a warned one', () => {
  const hit = (name, facts = {}) => ({ name, liquidityUsd: null, artwork: null, warned: false, ...facts });
  const pick = (entries) => otherChains.preselectOf(entries, (entry) => entry);
  assert.equal(pick([]), -1);
  assert.equal(pick([hit('VIRTUAL'), hit('VIRTUALS')]), 0, 'no other hit of its name');
  assert.equal(pick([hit(null)]), 0, 'an address');
  assert.equal(pick([hit(null), hit(null)]), -1, 'one address no network could read, on two networks: the person chooses where');
  assert.equal(pick([hit(null), hit('VIRTUAL')]), 0);
  assert.equal(pick([hit('USDC', { warned: true }), hit('USDC2')]), -1, 'a look-alike is never chosen');
  // Base's real VIRTUAL over Robinhood Chain's two copies with no liquidity: clearly the real one.
  const base = hit('VIRTUAL', { liquidityUsd: 5_000_000, artwork: true });
  const copy = hit('VIRTUAL', { liquidityUsd: 0, artwork: false });
  assert.equal(pick([base, copy, copy]), 0);
  // Not while a rival's liquidity is unknown, nor without a logo, nor when a rival is a tenth as liquid or more.
  assert.equal(pick([base, hit('VIRTUAL')]), -1);
  assert.equal(pick([{ ...base, artwork: null }, copy]), -1);
  assert.equal(pick([base, hit('VIRTUAL', { liquidityUsd: 500_000 })]), -1);
  // USDC on Base and on Arbitrum One: one name on two networks, so Enter waits for the person's choice.
  assert.equal(pick([hit('USDC', { artwork: true }), hit('USDC', { artwork: true }), hit('USDCE')]), -1);
  // Added 2026-10-06 (the review of the next update: "eth" highlighted nothing, where Robinhood Chain's ETH was taken):
  // Base's and Arbitrum One's own ETH are not rivals of Robinhood Chain's own ETH, whatever their figures.
  const homeEth = hit('ETH', { home: true, own: true, artwork: true });
  const theirEth = hit('ETH', { own: true, artwork: true });
  assert.equal(pick([homeEth, theirEth, theirEth, hit('WETH', { own: true })]), 0);
  assert.equal(pick([homeEth, theirEth, hit('ETH')]), -1, 'a copy named ETH still is one, as before');
  assert.equal(pick([homeEth, theirEth, hit('ETH', { home: true })]), -1, 'and so is a copy on Robinhood Chain');
  assert.equal(pick([{ ...homeEth, own: false }, theirEth]), -1, 'only Robinhood Chain\'s own main token is spared the rule');
  assert.equal(pick([hit('USDC', { own: true }), hit('USDC', { own: true })]), -1, 'Base\'s and Arbitrum One\'s own USDC: the person still chooses');
});
