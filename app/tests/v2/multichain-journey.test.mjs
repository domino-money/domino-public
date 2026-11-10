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
import { readFileSync } from 'node:fs';
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

test('public discovery keeps execution-locked networks readable without offering them for creation', () => {
  const gates = { ...GATES, 8453: { mode: 'preview', chainId: 8453, locked: true }, 42161: { mode: 'off', chainId: 42161 } };
  assert.deepEqual(networks.readableNetworks(gates), [8453]);
  assert.deepEqual(networks.offeredNetworks(gates), [], 'read access never grants creation');
  assert.deepEqual(networks.readableNetworks(null), []);
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

// Added 2026-11-06 (review F1 of the integrated branch): a Base or Arbitrum One position's Pool and New position links name
// the token whose pools read has the pool's key (the network pool page finds a pool only there), or none.
test('the token a network position\'s pool links name: the side whose pools read has the pool, never one that cannot', () => {
  const ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548';
  const USDT_ARB = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
  const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
  const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
  const v3 = (currency0, currency1, fee = 3000, tickSpacing = 60) => ({ dex: 3, currency0, currency1, fee, tickSpacing, hooks: ZERO });
  for (const [name, chainId, pool, expected] of [
    // WETH (or USDC) sorts first, but its read lists it only against the network's own currencies: the other token's
    // read lists the pair (the reviewer's Arbitrum One WETH/USDT and WETH/ARB, Base's WETH/cbBTC, WETH/AERO, USDC/cbBTC).
    ['WETH/USDT v3 on Arbitrum One', 42161, v3(WETH_ARB, USDT_ARB, 500, 10), USDT_ARB],
    ['WETH/ARB v3 on Arbitrum One', 42161, v3(WETH_ARB, ARB), ARB],
    ['WETH/AERO v3 on Base', 8453, v3(WETH_BASE, AERO), AERO],
    ['USDC/cbBTC v3 on Base', 8453, v3(USDC_BASE, CBBTC, 500, 10), CBBTC],
    ['WETH/cbBTC v3 on Base, Base\'s 0.04%', 8453, v3(WETH_BASE, CBBTC, 400, 8), CBBTC],
    // Two of the network's own currencies: either read lists it; the first, as before.
    ['WETH/USDC v3 on Base', 8453, WETH_USDC_V3, WETH_BASE],
    ['ETH/USDC v4 on Base', 8453, ETH_USDC_V4, USDC_BASE],
    ['ETH/token v4', 8453, { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 500, tickSpacing: 10, hooks: ZERO }, TOKEN],
    // No side's read has it: two other tokens, a fee and spacing off the standard pairs, a hook, another network's tier.
    ['ARB/USDT v3 on Arbitrum One', 42161, v3(ARB, USDT_ARB, 500, 10), null],
    ['v4 off the standard pairs', 8453, { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 10, hooks: ZERO }, null],
    ['a hooked v4 pool', 8453, { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: '0x00000000000000000000000000000000000000c0' }, null],
    ['an Arbitrum One v3 pool at Base\'s 0.04%', 42161, v3(WETH_ARB, ARB, 400, 8), null],
  ]) assert.equal(networks.networkPoolToken(chainId, pool), expected, name);
  assert.equal(networks.poolsToRead(42161, WETH_ARB).some((pool) => [pool.currency0, pool.currency1].includes(USDT_ARB)), false, 'WETH\'s own read never lists USDT');
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
// Changed on purpose 2026-10-06 (rugged97's delta of 6 Oct §4): read now, as networkRows counts its ten minutes on the
// wall clock when no time is handed in (a figure read on 21 Sep would be a dash now).
const READ_AT = Math.floor(Date.now() / 1000);
const figuresOf = (chainId, poolId, base, quote, liquidityUsd, volume24hUsd = '1000.00', retrievedAt = READ_AT) => ({ chainId, poolId, base, quote, liquidityUsd, volume24hUsd, retrievedAt });
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
  assert.deepEqual(v3.liquidity, { state: 'attributed', value: '$166.3K', raw: '166296.81', zero: false, provider: 'dexscreener', retrievedAt: READ_AT, cacheAgeSeconds: null }, 'the same figure a Robinhood Chain row’s stand-in is');
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

// Added 2026-10-06 (rugged97's delta of 6 Oct §4, the owner's decision for DEX Screener on Base and Arbitrum One): "Com
// mais de 10 min, não aparece"; "Sem par: '—' com o motivo".
test('networkRows (delta of 6 Oct §4): DEX Screener’s figures for ten minutes after they were read, never after; every dash says why: no pair, too old, nothing read', () => {
  const token = networks.displayOf(8453, { address: TOKEN, symbol: 'TOKEN', decimals: 18 });
  const V4_ETH = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V3_WETH = { dex: 3, currency0: TOKEN, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V4_USDC = { dex: 4, currency0: TOKEN, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
  const rows = networks.listedPools(8453, token, [onChain(V4_ETH), onChain(V3_WETH), onChain(V4_USDC)], 1).map((row) => ({ ...row, protocolFeeRaw: 0 }));
  const [eth, v3, usdc] = [poolIdOf(V4_ETH), `0x${'0'.repeat(24)}${V3_ADDRESS.slice(2)}`, poolIdOf(V4_USDC)];
  assert.deepEqual(rows.map((row) => row.key), [eth, v3, usdc], 'as they come');
  const AT = 1_790_000_000;
  const { NETWORK_FIGURE_MISSING: WHY } = otherChains;
  assert.equal(otherChains.NETWORK_FIGURES_MAX_AGE_S, 600, 'ten minutes');
  // The ETH pool's figures read 30 s after the v3 pool's; DEX Screener has no pair for the USDC pool.
  const read = dexOf([figuresOf(8453, eth, TOKEN, ZERO, '35138.92', '8844.96', AT + 30), figuresOf(8453, V3_ADDRESS, TOKEN, WETH_BASE, '166296.81', '21085.45', AT)]);
  const at = (nowS, listed = true) => otherChains.networkRows(rows, read, {}, null, { nowS, listed });
  const said = (shown) => shown.map((row) => [row.key, ...[row.liquidity, row.volume].map((figure) => (figure.state === 'attributed' ? figure.raw : figure.reason))]);
  // Ten minutes to the second after the v3 pool's read: both shown, the largest TVL first; the USDC pool has no pair.
  assert.deepEqual(said(at(AT + 600)), [[v3, '166296.81', '21085.45'], [eth, '35138.92', '8844.96'], [usdc, WHY.noPair, WHY.noPair]]);
  // A second more: the v3 pool's figures are a dash saying so, and order nothing; the ETH pool's still show.
  assert.deepEqual(said(at(AT + 601)), [[eth, '35138.92', '8844.96'], [v3, WHY.tooOld, WHY.tooOld], [usdc, WHY.noPair, WHY.noPair]]);
  // Past both: no figure shows, and the rows are as they came.
  assert.deepEqual(said(at(AT + 631)), [[eth, WHY.tooOld, WHY.tooOld], [v3, WHY.tooOld, WHY.tooOld], [usdc, WHY.noPair, WHY.noPair]]);
  for (const row of at(AT + 631)) assert.equal(row.providerNote, null, `${row.key}: no retrieval to date`);
  // No answer about the token read in the last ten minutes: a pool without figures says nothing was read.
  assert.deepEqual(said(at(AT + 60, false))[2], [usdc, WHY.notRead, WHY.notRead]);
  // A pair under the pool's name that holds other tokens is no pair for it, whatever was read about the token.
  const mismatched = otherChains.networkRows(rows, dexOf([figuresOf(8453, usdc, TOKEN, WETH_BASE, '1.00', '1.00', AT)]), {}, null, { nowS: AT, listed: false });
  assert.equal(mismatched.find((row) => row.key === usdc).liquidity.reason, WHY.noPair);
  // A pair DEX Screener lists with neither figure: both "not reported" by it, and no retrieval to date.
  const [bare] = otherChains.networkRows([rows[0]], dexOf([figuresOf(8453, eth, ZERO, TOKEN, null, null, AT)]), {}, null, { nowS: AT, listed: true });
  assert.deepEqual([bare.liquidity, bare.volume, bare.providerNote], [{ state: 'not_reported', provider: 'dexscreener' }, { state: 'not_reported', provider: 'dexscreener' }, null]);

  // A row kept on screen while time passes (the chosen pool, the row last pointed at): the same ten minutes as it is drawn.
  const shown = at(AT + 60);
  assert.equal(otherChains.figuresShownUntil(shown), AT + 600, 'the first figure shown may be until the v3 pool’s ten minutes are up');
  const kept = shown.find((row) => row.key === v3);
  assert.equal(otherChains.networkFiguresAt(kept, AT + 600), kept, 'still shown: the very row');
  const gone = otherChains.networkFiguresAt(kept, AT + 601);
  const dash = { state: 'unavailable', provider: 'dexscreener', reason: WHY.tooOld };
  assert.deepEqual([gone.liquidity, gone.volume, gone.providerNote], [dash, dash, null]);
  assert.deepEqual(rowApr.rowApr({ integration: gone.integration, currentLpFeePips: gone.feePips, protocolFeeRaw: gone.protocolFeeRaw, liquidity: gone.liquidity, volume: gone.volume }), { kind: 'none', reason: 'missing_reported_tvl' }, 'the APR goes with them');
  assert.equal(otherChains.figuresShownUntil([gone]), null);
  assert.equal(otherChains.figuresShownUntil(at(AT + 631)), null, 'nothing shown, nothing to wait for');
  // Robinhood Chain's figures are the read service's: never aged here.
  const home = { ...kept, currencies: kept.currencies.map((currency) => ({ ...currency, chainId: 4663 })) };
  assert.equal(otherChains.networkFiguresAt(home, AT + 100_000), home);
  assert.equal(otherChains.figuresShownUntil([home]), null);
});

// Added 2026-10-06 (rugged97's delta of 6 Oct §4): "Rótulo: número do provedor, com o nome dele e a hora da leitura";
// not a qualified source; a dash with its reason.
test('networkFigureNote and networkAprNote (delta of 6 Oct §4): DEX Screener named, with the time it was read; a dash says why', () => {
  const AT = 1_790_000_000;
  const { NETWORK_FIGURE_MISSING: WHY } = otherChains;
  const figure = { state: 'attributed', value: '$166.3K', raw: '166296.81', zero: false, provider: 'dexscreener', retrievedAt: AT, cacheAgeSeconds: null };
  assert.equal(otherChains.networkFigureNote(figure), 'Reported by DEX Screener, retrieved 14:13:20 UTC, 2026-09-21. Provider-reported, not reconciled with chain data.');
  assert.equal(otherChains.networkFigureNote({ state: 'not_reported', provider: 'dexscreener' }), 'Retrieved from DEX Screener, which reported no value for this figure. Provider-reported, not reconciled with chain data.');
  const dash = (reason) => ({ state: 'unavailable', provider: 'dexscreener', reason });
  assert.equal(otherChains.networkFigureNote(dash(WHY.noPair)), 'DEX Screener doesn’t list this pool.');
  assert.equal(otherChains.networkFigureNote(dash(WHY.tooOld)), 'DEX Screener’s figures for this pool are more than 10 minutes old.');
  assert.equal(otherChains.networkFigureNote(dash(WHY.notRead)), 'DEX Screener’s figures couldn’t be read.');
  // The APR: worked out from DEX Screener's two figures, named and dated; without one, the reason of the dash it lacks.
  assert.equal(otherChains.networkAprNote({ liquidity: figure, volume: figure }, { kind: 'estimate', text: '13.9', stale: false }, 'the row’s own'), 'Estimate from this pool’s fixed LP fee and DEX Screener’s 24h volume and liquidity, retrieved 14:13:20 UTC, 2026-09-21, annualised. A pool estimate, not a position’s APR, not APY and not a forecast.');
  assert.equal(otherChains.networkAprNote({ liquidity: dash(WHY.noPair), volume: dash(WHY.noPair) }, { kind: 'none', reason: 'missing_reported_tvl' }, 'the row’s own'), 'DEX Screener doesn’t list this pool.');
  assert.equal(otherChains.networkAprNote({ liquidity: figure, volume: dash(WHY.tooOld) }, { kind: 'none', reason: 'missing_volume24h' }, 'the row’s own'), 'DEX Screener’s figures for this pool are more than 10 minutes old.');
  assert.equal(otherChains.networkAprNote({ liquidity: figure, volume: figure }, { kind: 'none', reason: 'protocol_fee_directional_unsupported' }, 'the row’s own'), 'the row’s own', 'any other reason is the row’s own');
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

// ---------------------------------------------------------------------------
// 2026-11-07: Base USDC's and Arbitrum One WETH's WETH/USDC rows were dashes on the live site. DEX Screener lists 30
// pairs a token, not ranked by liquidity (recorded that day: tests/support/dexscreener-cap-2026-11-07.json), and the
// pools those pages list were not among them. They are asked about by their own names (lib/read/dexFigures.ts askPairs).
// ---------------------------------------------------------------------------

const dexFigures = require(`${BUILD}lib/read/dexFigures.js`);
const RECORDED = JSON.parse(readFileSync(new URL('../support/dexscreener-cap-2026-11-07.json', import.meta.url), 'utf8'));
/** A pool's key as the read lists it: a v3 pool's address as a 32-byte word. */
const v3Key = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
/** What our edge answers about pools by name, from the recorded pairs endpoint (none for a pool it does not list). */
const recordedByName = (chain, at, asked) => async (chainId, names) => {
  asked.push([chainId, names]);
  return new Map(names.map((name) => [name, { pairs: RECORDED.pairs[chain].filter((pair) => pair.pairAddress.toLowerCase() === name), retrievedAt: at }]));
};

test('2026-11-07 (recorded): Base USDC’s 30 pairs name none of its WETH/USDC pools; asked by their own names they get DEX Screener’s own figures, dated, in the order of their TVL', async () => {
  const { NETWORK_FIGURE_MISSING: WHY } = otherChains;
  const token = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const V3_30 = { dex: 3, currency0: WETH_BASE, currency1: USDC_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V3_05 = { ...V3_30, fee: 500, tickSpacing: 10 };
  const V3_30_ADDRESS = '0x6c561b446416e1a00e8e93e221854d6ea4171372';
  const V3_05_ADDRESS = '0xd0b53d9277642d899df5c87a3966a349a798f224';
  // ETH/USDC 0.30% on Base: its id is the one DEX Screener names.
  assert.equal(poolIdOf(ETH_USDC_V4_30), '0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9');
  // As the read lists them: ETH and WETH partners first, the most liquid first; a v3 pool by its address.
  const rows = networks.listedPools(8453, token, [onChain(V3_30, { id: V3_30_ADDRESS }), onChain(ETH_USDC_V4_30), onChain(V3_05, { id: V3_05_ADDRESS })], 1)
    .map((row) => ({ ...row, protocolFeeRaw: 0 }));
  assert.deepEqual(rows.map((row) => row.key), [v3Key(V3_30_ADDRESS), poolIdOf(ETH_USDC_V4_30), v3Key(V3_05_ADDRESS)]);
  const AT = Date.UTC(2026, 10, 7, 11, 28);
  let wall = AT;
  const asked = [];
  const store = dexFigures.createDexStore(async () => null, () => wall, recordedByName('base', AT - 2_000, asked));
  store.take(USDC_BASE, RECORDED.tokenPairs[`base/${USDC_BASE}`], AT, 8453);
  const seen = (chainId, name) => store.chainPoolSeen(chainId, name);
  const nowS = Math.floor(AT / 1000);
  const shown = () => otherChains.networkRows(rows, seen, {}, null, { nowS: Math.floor(wall / 1000), listed: true });
  const said = (list) => list.map((row) => [row.key, ...[row.liquidity, row.volume].map((figure) => (figure.state === 'attributed' ? figure.raw : figure.reason))]);
  // What the live page showed: the token's pairs were read, and none names these pools.
  assert.equal(store.chainToken(8453, USDC_BASE).pools, 30);
  assert.deepEqual(said(shown()).map((row) => row.slice(1)), Array(3).fill([WHY.noPair, WHY.noPair]));
  const names = otherChains.unnamedPools(rows, seen, nowS);
  assert.deepEqual(names, [V3_30_ADDRESS, poolIdOf(ETH_USDC_V4_30), V3_05_ADDRESS], 'every row the token’s pairs leave out, by its name there, in the list’s order');
  await store.askPairs(8453, names);
  assert.deepEqual(asked, [[8453, names]], 'one ask for the three');
  assert.deepEqual(said(shown()), [
    [v3Key(V3_30_ADDRESS), '146056184.05', '46354331.24'],
    [v3Key(V3_05_ADDRESS), '8090054.33', '9991770.05'],
    [poolIdOf(ETH_USDC_V4_30), '4381526.99', '640192.36'],
  ], 'DEX Screener’s own figures, the largest TVL first, as on Base WETH’s page');
  const [top] = shown();
  assert.deepEqual([top.liquidity.provider, top.liquidity.retrievedAt], ['dexscreener', Math.floor((AT - 2_000) / 1000)], 'attributed and dated by the edge’s own retrieval');
  assert.match(top.providerNote, /^Provider figures retrieved 11:27:58 UTC/);
  assert.equal(rowApr.rowApr({ integration: top.integration, currentLpFeePips: top.feePips, protocolFeeRaw: top.protocolFeeRaw, liquidity: top.liquidity, volume: top.volume }).kind, 'estimate', 'and the APR estimate follows from them');
  assert.deepEqual(otherChains.unnamedPools(rows, seen, nowS), [], 'none left to ask');
  // Asked again within the minute: nothing goes out; ten minutes on they are asked again, never sooner.
  await store.askPairs(8453, names);
  assert.equal(asked.length, 1);
  wall = AT + 9 * 60_000;
  assert.deepEqual(otherChains.unnamedPools(rows, seen, Math.floor(wall / 1000)), [], 'fresh for ten minutes from their retrieval');
  wall = AT - 2_000 + 601_000;
  assert.deepEqual(said(shown()).map((row) => row[1]), Array(3).fill(WHY.tooOld), 'past ten minutes: a dash saying so');
  assert.deepEqual(otherChains.unnamedPools(rows, seen, Math.floor(wall / 1000)).length, 3);
  // Robinhood Chain, and a chain these reads do not cover, never ask.
  await store.askPairs(4663, names);
  await store.askPairs(99901, names);
  assert.equal(asked.length, 1);
});

test('2026-11-07 (recorded): Arbitrum One WETH’s 30 pairs are its bridged-USDC pools; its native-USDC pool asked by name is matched on both currencies, whichever the provider names first', async () => {
  const { NETWORK_FIGURE_MISSING: WHY } = otherChains;
  const token = networks.displayOf(42161, { address: WETH_ARB, symbol: 'WETH', decimals: 18 });
  const NATIVE_05 = '0xc6962004f452be9203591991d15f6b388e09e8d0';
  const pool = { dex: 3, currency0: WETH_ARB, currency1: USDC_ARB, fee: 500, tickSpacing: 10, hooks: ZERO };
  const [row] = networks.listedPools(42161, token, [onChain(pool, { id: NATIVE_05 })], 1).map((one) => ({ ...one, protocolFeeRaw: 0 }));
  const AT = Date.UTC(2026, 10, 7, 11, 30);
  const asked = [];
  const store = dexFigures.createDexStore(async () => null, () => AT, recordedByName('arbitrum', AT, asked));
  const weth = RECORDED.tokenPairs[`arbitrum/${WETH_ARB}`];
  assert.ok(weth.every((pair) => pair.pairAddress.toLowerCase() !== NATIVE_05) && weth.some((pair) => pair.quoteToken.symbol === 'USDC'), 'the token’s 30 pairs: USDC.e pools, never this one');
  store.take(WETH_ARB, weth, AT, 42161);
  const seen = (chainId, name) => store.chainPoolSeen(chainId, name);
  const nowS = Math.floor(AT / 1000);
  assert.equal(otherChains.networkRows([row], seen, {}, null, { nowS, listed: true })[0].liquidity.reason, WHY.noPair);
  await store.askPairs(42161, otherChains.unnamedPools([row], seen, nowS));
  assert.deepEqual(asked, [[42161, [NATIVE_05]]]);
  const [figured] = otherChains.networkRows([row], seen, {}, null, { nowS, listed: true });
  assert.equal(RECORDED.pairs.arbitrum[0].baseToken.symbol, 'USDC', 'the provider names USDC first, the pool WETH first');
  assert.deepEqual([figured.liquidity.raw, figured.volume.raw], [RECORDED.pairs.arbitrum[0].liquidity.usd.toFixed(2), RECORDED.pairs.arbitrum[0].volume.h24.toFixed(2)]);
  // A pair under the pool's name that holds other tokens is no pair for it: both currencies are checked.
  const other = dexFigures.createDexStore(async () => null, () => AT, async (_chainId, names) => new Map(names.map((name) => [name, {
    pairs: [{ chainId: 'arbitrum', dexId: 'uniswap', pairAddress: name, baseToken: { address: USDC_ARB }, quoteToken: { address: TOKEN }, liquidity: { usd: 5 }, volume: { h24: 5 } }], retrievedAt: AT,
  }])));
  await other.askPairs(42161, [NATIVE_05]);
  assert.equal(otherChains.networkRows([row], (chainId, name) => other.chainPoolSeen(chainId, name), {}, null, { nowS, listed: true })[0].liquidity.reason, WHY.noPair);
  // Another exchange's pool under the name is not Uniswap's: not taken.
  const elsewhere = dexFigures.createDexStore(async () => null, () => AT, async (_chainId, names) => new Map(names.map((name) => [name, { pairs: [{ ...RECORDED.pairs.arbitrum[0], dexId: 'sushiswap' }], retrievedAt: AT }])));
  await elsewhere.askPairs(42161, [NATIVE_05]);
  assert.equal(elsewhere.chainPoolSeen(42161, NATIVE_05), null);
  // Our edge away or refusing: nothing taken, and the ask settles all the same.
  const away = dexFigures.createDexStore(async () => null, () => AT, async () => { throw new Error('edge away'); });
  await away.askPairs(42161, [NATIVE_05]);
  assert.equal(away.chainPoolSeen(42161, NATIVE_05), null);
});

test('2026-11-07: askPairs considers the first thirty names it is given, each once, not again within the minute; a bad name is never asked', async () => {
  let wall = Date.UTC(2026, 10, 7, 12);
  const asked = [];
  const store = dexFigures.createDexStore(async () => null, () => wall, async (chainId, names) => { asked.push(names); return null; });
  const name = (i) => `0x${(i + 1).toString(16).padStart(64, '0')}`;
  const many = Array.from({ length: 33 }, (_, i) => name(i));
  await store.askPairs(8453, [many[0].toUpperCase().replace('0X', '0x'), ...many, '0x123', 'pool']);
  assert.equal(dexFigures.DEX_PAIRS_MAX, 30);
  assert.deepEqual(asked, [many.slice(0, 29)], 'the first thirty given (one written twice), lowercase, each once');
  await store.askPairs(8453, many);
  assert.deepEqual(asked.at(-1), [many[29]], 'the ones not asked yet, within the first thirty');
  wall += dexFigures.DEX_ASK_EVERY_MS - 1;
  await store.askPairs(8453, many.slice(0, 5));
  assert.equal(asked.length, 2, 'not within the minute');
  wall += 1;
  await store.askPairs(8453, many.slice(0, 5));
  assert.deepEqual(asked.at(-1), many.slice(0, 5));
  // A pool's name is not a token's: asking about one never stops the other.
  const tokens = [];
  const both = dexFigures.createDexStore(async (address, chainId) => { tokens.push([address, chainId]); return null; }, () => wall, async (_chainId, names) => { asked.push(names); return null; });
  const address = '0x6c561b446416e1a00e8e93e221854d6ea4171372';
  await both.askPairs(8453, [address]);
  both.askOn(8453, address);
  assert.deepEqual([asked.at(-1), tokens], [[address], [[address, 8453]]]);
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

// Added 2026-11-06 (the owner's replica rule, O-01 and O-03: Base and Arbitrum One's token page and pool page are Robinhood
// Chain's): a network's pool row as a Markets row, which the same table, the same pool page and the same figures dialog
// draw. Its key names the chain; its figures are DEX Screener's, attributed as a Robinhood Chain row's discovered figures
// are; its APR the read service's estimate method on them, marked an estimate; nothing is made up past their ten minutes.
test('networkMarketRow: a Base pool row as Robinhood Chain’s Markets row, chain-qualified, DEX Screener’s figures attributed, an estimate APR, the pool’s own price', () => {
  const markets = require(`${BUILD}lib/read/networkMarkets.js`);
  const token = networks.displayOf(8453, { address: TOKEN, symbol: 'TOKEN', decimals: 18 });
  const V4_ETH = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const V3_WETH = { dex: 3, currency0: TOKEN, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const rows = networks.listedPools(8453, token, [onChain(V4_ETH), onChain(V3_WETH)], 1).map((row) => ({ ...row, protocolFeeRaw: 0 }));
  const AT = 1_790_000_000;
  const read = dexOf([figuresOf(8453, poolIdOf(V4_ETH), TOKEN, ZERO, '35138.92', '8844.96', AT)]);
  const [eth, weth] = otherChains.networkRows(rows, read, {}, null, { nowS: AT + 60, listed: true });
  const row = markets.networkMarketRow(eth);
  assert.equal(row.key, `8453:${poolIdOf(V4_ETH).toLowerCase()}`, 'the chain in the key: an id can repeat across chains');
  assert.equal(row.poolId, poolIdOf(V4_ETH).toLowerCase());
  assert.equal(markets.onNetwork(row), true);
  assert.deepEqual(row.tvlUsd, { value: '35138.92', state: 'provider', asOf: AT, source: 'DexScreener', fallback: 'discovered' });
  assert.deepEqual(row.volume24hUsd, { value: '8844.96', state: 'provider', asOf: AT, source: 'DexScreener', fallback: 'discovered' });
  assert.equal(row.feeAprPercent.state, 'unavailable', 'no Domino history on Base');
  assert.deepEqual(row.aprFallback, { percent: '27.56', asOf: AT, basis: 'discovered' }, 'the same estimate New position’s row shows (networkRows test above)');
  assert.deepEqual(row.poolState, { sqrtPriceX96: eth.sqrtPriceX96, tick: eth.tick, tickSpacing: 60, block: eth.block, currency0: ZERO, currency1: TOKEN }, 'the price from the pool’s own state, in pool order');
  assert.equal(row.feePips, 3000);
  assert.equal(row.integration, 'hookless_fixed_fee');
  assert.deepEqual(row.tokens, { base: eth.currencies[0], quote: eth.currencies[1] });
  // A row DEX Screener has no figures for: dashes, no estimate, nothing stood in.
  const bare = markets.networkMarketRow(weth);
  assert.equal(bare.tvlUsd.state, 'unavailable');
  assert.equal(bare.volume24hUsd.state, 'unavailable');
  assert.equal(bare.aprFallback, undefined);
  // Past its ten minutes the same pool's figures are gone from the row, and its estimate with them.
  const aged = otherChains.networkRows(rows, read, {}, null, { nowS: AT + 601, listed: true }).find((option) => option.key === eth.key);
  const old = markets.networkMarketRow(aged);
  assert.equal(old.tvlUsd.state, 'unavailable');
  assert.equal(old.aprFallback, undefined);
  // A v3 pool whose protocol fee is on: the LPs' share, as New position's row works it out (rowApr.ts v3LpShare).
  const v3 = markets.networkMarketRow({ ...weth, liquidity: eth.liquidity, volume: eth.volume, protocolFeeRaw: otherChains.PROTOCOL_FEE_UNDESCRIBED, v3FeeProtocol: 0x44 });
  assert.equal(v3.aprFallback.percent, '20.67', 'three quarters of the v4 twin’s 27.56%');
  assert.deepEqual(v3.aprFallback, { percent: rowApr.rowApr({ integration: 'hookless_fixed_fee', currentLpFeePips: 3000, protocolFeeRaw: otherChains.PROTOCOL_FEE_UNDESCRIBED, v3FeeProtocol: 0x44, liquidity: eth.liquidity, volume: eth.volume }).text, asOf: AT, basis: 'discovered' });
  assert.equal(markets.networkMarketRows([eth, weth]).length, 2);
  // Robinhood Chain's rows are never a network's.
  assert.equal(markets.onNetwork({ tokens: { base: { chainId: 4663 } } }), false);
});
