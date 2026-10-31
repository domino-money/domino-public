/**
 * The markets workstream of the 2026-10-01 audit package: what Home's Top pools, the ticker, Markets, a token's pools,
 * a pool's page and the token search show when the read service's provider refuses (V1), a token's pools from both of
 * the read service's sources (V2), tokens that pass for another (V3, I1, I2), the featured list's honest count and
 * withdrawal reasons (B1, B2, B3), and the client's side of the edge (A7, A22, I3).
 *
 * Recorded production shapes (C:/dwt/audit-2026-10-01/live/NOTES.md, L1, L6, L8): the overview's market alternating
 * between `available` (CASHCAT/USDG, TVL $1,067,487, 24h volume $1.886M, estimate 173.4%) and `unavailable`
 * (provider_unavailable, provider_rate_limited, provider_capacity_busy); an empty overview (pools []); DEX Screener's
 * UFG/USDG 4% pool 0x031fe000… with $40.2K liquidity and $7.5K volume, which New position estimated at about 272%.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as v1 from '../../api-contracts/read-v1/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';

const require = createRequire(import.meta.url);
const built = (path) => require(`../.test-build/app/src/${path}.js`);
const fallback = built('lib/read/figureFallback');
const memory = built('lib/read/figureMemory');
const dex = built('lib/read/dexFigures');
const pools = built('lib/read/tokenPools');
const lookalike = built('lib/read/screens/lookalike');
const reading = built('lib/symbolReading');
const mainTokens = built('config/mainTokens');
const search = built('lib/read/screens/tokenSearch');
const featured = built('lib/read/featuredList');
const { overviewRows } = built('lib/read/publicOverview');
const { createPaintMemory, PAINT_MAX_AGE_MS, PREFETCH_MAX_AGE_MS } = built('lib/read/marketsPaint');
const { createBridgeSource, edgeAgeOf, CAPABILITIES_KEEP_MS } = built('lib/read/bridgeSource');
const { createTokenArtworkResolver, DEX_EDGE } = built('lib/tokenArtwork');
const { realClock } = built('lib/read/pipeline');

const overviewFixture = () => JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/overview.json', import.meta.url), 'utf8'));
const gateway = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8'));
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const UFG_COPY = '0xbc1c000000000000000000000000000000001d41';
const UFG_POOL = '0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03';
const { withStalePools } = await import('./support/stale-store.mjs');
/** The overview fixture's own clock (its generatedAt), seconds: "now" in these tests. */
const NOW = overviewFixture().generatedAt;
const instant = (seconds) => ({ wall: seconds * 1000, monotonic: seconds * 1000 });

/**
 * The overview fixture's row, as production served it: good figures (TVL $10,000, $1,000 a day, the read service's
 * 10.95% estimate, retrieved at NOW), or refused, as the store serves a pool without its provider figures
 * (tests/support/stale-store.mjs): `provider_unavailable`, or `provider_rate_limited` with `busy`.
 */
function row({ refused = false, busy = false } = {}) {
  const fixture = overviewFixture();
  const data = refused ? withStalePools(fixture, [fixture.pools[0].poolId], { providerBusy: busy }) : fixture;
  assert.equal(v3.validateResponse('overview', data), true, 'the variant passes read-v3’s own runtime');
  const provenance = { transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt: NOW * 1000, receivedMonotonic: NOW * 1000, attempts: 1 };
  return overviewRows({ data, provenance })[0];
}

/** A memory over a plain object, as localStorage. */
function storage(initial = {}) {
  const items = { ...initial };
  return { items, getItem: (key) => (key in items ? items[key] : null), setItem: (key, value) => { items[key] = String(value); }, removeItem: (key) => { delete items[key]; } };
}

// ---------------------------------------------------------------------------
// V1: a refused figure is stood in for, never replaced by "Unavailable"
// ---------------------------------------------------------------------------

test('V1: only a refusal for the moment is stood in for; a rejected identity or a structural missing estimate never is', () => {
  for (const refused of [row({ refused: true }), row({ refused: true, busy: true })]) {
    assert.equal(fallback.refusedFigure(refused.tvlUsd), true, refused.tvlUsd.reason);
    assert.equal(fallback.needsFallback(refused, instant(NOW)), true, refused.tvlUsd.reason);
  }
  assert.equal(fallback.refusedFigure({ value: null, state: 'unavailable', reason: 'provider_capacity_busy' }), true);
  for (const reason of ['provider_currency_or_pool_mismatch', 'provider_dex_unconfirmed']) assert.equal(fallback.refusedFigure({ value: null, state: 'unavailable', reason }), false, reason);
  assert.equal(fallback.refusedFigure({ value: null, state: 'rejected', reason: 'provider_currency_or_pool_mismatch' }), false);
  const good = row();
  assert.equal(fallback.needsFallback(good, instant(NOW)), false, 'good figures stand as they are');
  // A hooked pool's estimate is not this method's: nothing stands in for it.
  assert.equal(fallback.estimateRefused({ ...row({ refused: true }), integration: 'requires_separate_adapter' }, instant(NOW)), false);
});

test('V1: the last good figures this browser saw stand in, dated and stale, before DEX Screener’s; past half an hour DEX Screener’s first, then the old ones, then today’s selection', () => {
  const kept = { tvl: '1067487.12', volume: '1886000', at: NOW - 600, apr: '173.4', aprAt: NOW - 600 };
  const fromDex = { poolId: 'x', base: USDG, quote: WETH, liquidityUsd: '1050000.00', volume24hUsd: '1900000.00', retrievedAt: NOW - 30 };
  const selection = { tvlUsd: '990000', volume24hUsd: '1700000', apr: '150.25', evaluatedAt: NOW - 26 * 3600 };
  const refused = row({ refused: true });

  const young = fallback.withFallback(refused, { kept, dex: fromDex, selection, now: instant(NOW) });
  assert.deepEqual(young.tvlUsd, { value: '1067487.12', state: 'stale', asOf: NOW - 600, source: 'GeckoTerminal', fallback: 'kept' });
  assert.deepEqual(young.aprFallback, { percent: '173.4', asOf: NOW - 600, basis: 'kept' });

  const later = fallback.withFallback(refused, { kept, dex: fromDex, selection, now: instant(NOW + 3600) });
  assert.deepEqual(later.tvlUsd, { value: '1050000.00', state: 'provider', asOf: NOW - 30, source: 'DexScreener', fallback: 'dexscreener' }, 'DEX Screener’s own, current as the provider’s, attributed');
  assert.equal(later.aprFallback.basis, 'dexscreener', 'the read service’s method on DEX Screener’s figures');

  const noDex = fallback.withFallback(refused, { kept, dex: null, selection, now: instant(NOW + 3600) });
  assert.equal(noDex.tvlUsd.fallback, 'kept', 'an older kept figure before the selection’s');
  const old = fallback.withFallback(refused, { kept, dex: null, selection, now: instant(NOW + 25 * 3600) });
  assert.deepEqual(old.tvlUsd, { value: '990000', state: 'stale', asOf: NOW - 26 * 3600, source: 'GeckoTerminal', fallback: 'selection' }, 'past a day, today’s selection, dated at it');
  assert.deepEqual(old.aprFallback, { percent: '150.25', asOf: NOW - 26 * 3600, basis: 'selection' });
  const nothing = fallback.withFallback(refused, { kept: null, dex: null, selection: null, now: instant(NOW) });
  assert.equal(nothing.tvlUsd.state, 'unavailable', 'never a figure from nothing');
  assert.equal(nothing.aprFallback, undefined);
});

test('V1: DEX Screener’s estimate is the read service’s own method on its figures (UFG/USDG 4%: $40.2K, $7.5K a day, about 272%)', () => {
  const refused = { ...row({ refused: true, busy: true }), feePips: 40_000, protocolFeeRaw: 0 };
  const ufg = { poolId: UFG_POOL, base: UFG, quote: USDG, liquidityUsd: '40200.00', volume24hUsd: '7500.00', retrievedAt: NOW - 5 };
  const shown = fallback.withFallback(refused, { kept: null, dex: ufg, selection: null, now: instant(NOW) });
  assert.deepEqual(shown.aprFallback, { percent: '272.39', asOf: NOW - 5, basis: 'dexscreener' });
  // A pool charging a protocol fee differently each way is outside the method: no estimate stands in.
  const directional = fallback.withFallback({ ...refused, protocolFeeRaw: (100 << 12) | 50 }, { kept: null, dex: ufg, selection: null, now: instant(NOW) });
  assert.equal(directional.aprFallback, undefined);
});

test('V1: this browser keeps the read service’s own good figures, in memory and in its storage, a day at the most, 64 pools', () => {
  const now = { at: NOW * 1000 };
  const store = storage();
  const kept = memory.createFigureMemory(() => store, () => now.at);
  const good = memory.goodFigures(row());
  assert.deepEqual(good, { tvl: '10000', volume: '1000', at: NOW, apr: '10.95', aprAt: NOW });
  assert.equal(memory.goodFigures(row({ refused: true })), null, 'a refusal is nothing to keep');
  assert.equal(memory.goodFigures({ ...row(), tvlUsd: { value: '5', state: 'provider', asOf: NOW, source: 'DexScreener', fallback: 'dexscreener' }, volume24hUsd: { value: null, state: 'unavailable' }, feeAprEstimate: undefined }), null, 'a stand-in is never kept as the read service’s');
  kept.remember(UFG_POOL, good);
  assert.deepEqual(kept.recall(UFG_POOL.toUpperCase().replace('0X', '0x')), { tvl: '10000', volume: '1000', at: NOW, apr: '10.95', aprAt: NOW });
  kept.remember(UFG_POOL, { tvl: '1', volume: '1', at: NOW - 100 });
  assert.equal(kept.recall(UFG_POOL).tvl, '10000', 'an older observation never replaces a newer one');
  // The next visit reads it back from the storage.
  const next = memory.createFigureMemory(() => store, () => now.at);
  assert.equal(next.recall(UFG_POOL).apr, '10.95');
  now.at += (memory.KEPT_MAX_AGE_S + 60) * 1000;
  assert.equal(next.recall(UFG_POOL), null, 'past a day it is not given out');
  // Junk in the storage, a storage that throws: nothing, and no error.
  assert.equal(memory.createFigureMemory(() => storage({ [memory.FIGURES_KEY]: '{"v":1,"pools":{"x":1}}' })).recall(UFG_POOL), null);
  const broken = memory.createFigureMemory(() => { throw new Error('blocked'); }, () => NOW * 1000);
  broken.remember(UFG_POOL, good);
  assert.deepEqual(broken.recall(UFG_POOL)?.tvl, '10000', 'kept in memory for the visit');
  const many = memory.createFigureMemory(() => storage(), () => NOW * 1000);
  for (let i = 0; i < 70; i++) many.remember(`0x${i.toString(16).padStart(64, '0')}`, good);
  assert.equal(many.recall(`0x${(0).toString(16).padStart(64, '0')}`), null, 'the oldest pools leave first');
  assert.ok(many.recall(`0x${(69).toString(16).padStart(64, '0')}`));
});

// ---------------------------------------------------------------------------
// DEX Screener's figures, from the bodies the artwork already reads
// ---------------------------------------------------------------------------

test('DEX Screener: only Uniswap v4 pools on Robinhood Chain by their 32-byte id are a pool’s figures; a token’s liquidity counts every pair naming it', () => {
  const pair = (pairAddress, base, quote, usd, extra = {}) => ({ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress, baseToken: { address: base }, quoteToken: { address: quote }, liquidity: { usd }, volume: { h24: 7500 }, ...extra });
  const body = [
    pair(UFG_POOL.toUpperCase().replace('0X', '0x'), UFG, USDG, 40200),
    pair('0x1c508008e7' + 'a'.repeat(54), UFG, '0x0000000000000000000000000000000000000000', 144600),
    pair('0x' + '2'.repeat(40), UFG, WETH, 1000, { labels: ['v3'] }),
    pair('0x' + '3'.repeat(64), UFG, USDG, 50, { chainId: 'ethereum' }),
    pair('0x' + '4'.repeat(64), UFG, USDG, Number.NaN),
  ];
  const found = dex.dexPoolsFromPairs(body, NOW * 1000);
  assert.deepEqual(found.map((p) => [p.poolId, p.liquidityUsd, p.volume24hUsd]), [[UFG_POOL, '40200.00', '7500.00'], ['0x1c508008e7' + 'a'.repeat(54), '144600.00', '7500.00'], ['0x' + '4'.repeat(64), null, '7500.00']]);
  assert.equal(found[0].retrievedAt, NOW);
  assert.deepEqual(dex.dexTokenFromPairs(body, UFG, NOW * 1000), { address: UFG, liquidityUsd: 40200 + 144600 + 1000, pools: 4, retrievedAt: NOW });
  assert.deepEqual(dex.dexTokenFromPairs([], UFG_COPY, NOW * 1000), { address: UFG_COPY, liquidityUsd: 0, pools: 0, retrievedAt: NOW }, 'a token no pair names has none');
  assert.equal(dex.usdText(1e16), null);
  assert.equal(dex.usdText(-1), null);
  // The recorded PONS body (tests/support): its v4 pools by id.
  const pons = JSON.parse(readFileSync(new URL('./support/dexscreener-pons.json', import.meta.url), 'utf8'));
  assert.ok(dex.dexPoolsFromPairs(pons, NOW * 1000).every((p) => /^0x[0-9a-f]{64}$/.test(p.poolId)));
});

test('DEX Screener: the store keeps the newest figures, gives none past ten minutes, and asks about a token once a minute at most', async () => {
  const asked = [];
  let at = NOW * 1000;
  const store = dex.createDexStore(async (address) => { asked.push(address); return null; }, () => at);
  const heard = [];
  store.subscribe(() => heard.push(store.version()));
  const body = [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: UFG_POOL, baseToken: { address: UFG }, quoteToken: { address: USDG }, liquidity: { usd: 40200 }, volume: { h24: 7500 } }];
  store.take(UFG, body, at);
  assert.equal(store.pool(UFG_POOL).liquidityUsd, '40200.00');
  assert.equal(store.token(UFG).liquidityUsd, 40200);
  store.take(UFG, [{ ...body[0], liquidity: { usd: 1 } }], at - 60_000);
  assert.equal(store.pool(UFG_POOL).liquidityUsd, '40200.00', 'an older body never replaces a newer one');
  assert.deepEqual(heard, [1, 2]);
  at += (dex.DEX_MAX_AGE_S + 1) * 1000;
  assert.equal(store.pool(UFG_POOL), null, 'too old to give out');
  store.ask(UFG); store.ask(UFG.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(asked, [UFG], 'once a minute');
  at += dex.DEX_ASK_EVERY_MS;
  store.ask(UFG);
  assert.deepEqual(asked, [UFG, UFG]);
  store.ask('not-an-address');
  assert.equal(asked.length, 2);
  assert.equal(dex.subjectOf([USDG, UFG]), UFG, 'the token that is not the dollar or ether');
  assert.equal(dex.subjectOf(['0x0000000000000000000000000000000000000000', USDG]), '0x0000000000000000000000000000000000000000', 'ETH/USDG: native ether, as the provider names it');
});

// Added 2026-10-30 (QA round 2, N6): the token search settles its look-alikes with no pair in one batch, exactly as their
// own token-pairs body ([]) would, and leaves every other hit to its mark's own read.
test('N6: a search hit the batch lists no pair for says No liquidity found and has no artwork; any other hit, a missing one or a failed batch is never taken for zero', async () => {
  const at = NOW * 1000;
  const store = dex.createDexStore(async () => null, () => at);
  const held = new Map();
  const asked = [];
  let answer = null;
  const artwork = {
    edgeTokens: async (list) => { asked.push(list); return answer; },
    peek: (_chain, address) => held.get(address),
    seed: (_chain, address, image) => { if (!(image === null && held.get(address))) held.set(address, image); },
  };
  const deps = { artwork, store };
  const empty = `0x${'e'.repeat(40)}`;
  const liquid = UFG;
  const missing = `0x${'9'.repeat(40)}`;
  const known = USDG;
  const pictured = WETH;
  store.take(known, [{ chainId: 'robinhood', baseToken: { address: known }, quoteToken: { address: UFG }, liquidity: { usd: 5 } }], at);
  held.set(pictured, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto');
  answer = new Map([[empty, { pairs: [], retrievedAt: at - 2_000 }], [liquid, { pairs: [{ chainId: 'robinhood', baseToken: { address: liquid }, quoteToken: { address: USDG }, liquidity: { usd: 40200 } }], retrievedAt: at }]]);
  await dex.settleSearchHits([empty, liquid, missing, known, pictured, empty.toUpperCase().replace('0X', '0x'), '0x0000000000000000000000000000000000000000'], undefined, deps);
  assert.deepEqual(asked, [[empty, liquid, missing]], 'one batch, only for hits nothing is known of yet');
  assert.deepEqual(store.token(empty), { address: empty, liquidityUsd: 0, pools: 0, retrievedAt: NOW - 2 }, 'No liquidity found, dated by the edge’s retrieval');
  assert.equal(held.get(empty), null, 'no artwork, so its mark asks nothing');
  assert.equal(store.token(liquid), null, 'a hit with a pair is its mark’s to read: the trimmed batch never feeds a total');
  assert.equal(held.has(liquid), false, 'nor its artwork');
  assert.equal(store.token(missing), null, 'a hit the batch did not answer is not zero');
  // A failed batch (null) settles nothing; an aborted search settles nothing.
  const store2 = dex.createDexStore(async () => null, () => at);
  answer = null;
  await dex.settleSearchHits([empty], undefined, { artwork: { ...artwork, peek: () => undefined }, store: store2 });
  assert.equal(store2.token(empty), null);
  const stopped = new AbortController();
  stopped.abort();
  asked.length = 0;
  await dex.settleSearchHits([missing], stopped.signal, deps);
  assert.deepEqual(asked, [], 'nothing asked for a search already gone');
});

// Added 2026-10-06 (the owner's point 3: Base's and Arbitrum One's pools in New position with TVL, 24h volume and APR
// "like Robinhood Chain"). Shapes as DEX Screener answered for VIRTUAL on Base and ARB on Arbitrum One that day: Uniswap
// v4 pools by their 32-byte id, v3 pools by their address (labelled v3 on Base, unlabelled on Arbitrum One), other
// exchanges beside them, one of them labelled v4 with a pair address.
test('DEX Screener on Base and Arbitrum One (2026-10-06): Uniswap pools by their v4 id or v3 address, on that chain only; the store keeps each chain apart and asks by chain', async () => {
  const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const V4 = '0xaf2baac6d0437b0b16c3eb6ec7f0e9b8af1fa2b6e8d8b1d0a5fa4d4ee8fd4b0a';
  const V3 = '0x529d2863a1521d0b57db028168fde2e97120017c';
  const pair = (pairAddress, quote, usd, extra = {}) => ({ chainId: 'base', dexId: 'uniswap', pairAddress, baseToken: { address: VIRTUAL }, quoteToken: { address: quote }, liquidity: { usd }, volume: { h24: 1000 }, ...extra });
  const body = [
    pair(V4, USDC, 136159.17, { labels: ['v4'] }),
    pair(V3.toUpperCase().replace('0X', '0x'), USDC, 939056.41),
    pair('0x61d460db2951a3c8e9f6b1e2a2c6b1c8e1c0dbb2', WETH_BASE, 25125.67, { dexId: 'quickswap', labels: ['v4'] }),
    pair('0x3f0296bf652e19bca772ec3df08b32732f93014a', WETH_BASE, 381753.71, { dexId: 'aerodrome' }),
    pair(`0x${'12'.repeat(32)}`, ZERO, 10, { chainId: 'robinhood', labels: ['v4'] }),
    pair('0x123', USDC, 1),
  ];
  const found = dex.dexChainPoolsFromPairs(body, 8453, NOW * 1000);
  assert.deepEqual(found.map((p) => [p.poolId, p.base, p.quote, p.liquidityUsd, p.volume24hUsd, p.retrievedAt]), [[V4, VIRTUAL, USDC, '136159.17', '1000.00', NOW], [V3, VIRTUAL, USDC, '939056.41', '1000.00', NOW]], 'Uniswap’s pools only, by their exact name there, labelled or not');
  assert.deepEqual(dex.dexChainPoolsFromPairs(body, 42161, NOW * 1000), [], 'Arbitrum One takes Arbitrum One’s pairs only');
  assert.deepEqual(dex.dexChainPoolsFromPairs(body, 4663, NOW * 1000), [], 'Robinhood Chain keeps its own rule (v4 ids, dexPoolsFromPairs)');
  assert.deepEqual(dex.dexTokenFromPairs(body, VIRTUAL, NOW * 1000, 8453), { address: VIRTUAL, liquidityUsd: 136159.17 + 939056.41 + 25125.67 + 381753.71 + 1, pools: 5, retrievedAt: NOW });
  // The store: one chain's pools and tokens never stand for another's, and each chain is asked on its own.
  const asked = [];
  let at = NOW * 1000;
  const store = dex.createDexStore(async (address, chainId) => { asked.push([address, chainId]); return null; }, () => at);
  store.take(VIRTUAL, body, at, 8453);
  assert.equal(store.chainPool(8453, V4).liquidityUsd, '136159.17');
  assert.equal(store.chainPool(8453, V3.toUpperCase().replace('0X', '0x')).liquidityUsd, '939056.41');
  assert.equal(store.chainPool(42161, V4), null);
  assert.equal(store.pool(V4), null, 'never a Robinhood Chain pool');
  assert.equal(store.chainToken(8453, VIRTUAL).pools, 5);
  assert.equal(store.token(VIRTUAL), null, 'nor a Robinhood Chain token');
  store.askOn(8453, VIRTUAL);
  store.askOn(8453, VIRTUAL.toUpperCase().replace('0X', '0x'));
  store.askOn(42161, VIRTUAL);
  store.ask(VIRTUAL);
  store.askOn(1, VIRTUAL);
  store.askOn(8453, ZERO);
  assert.deepEqual(asked, [[VIRTUAL, 8453], [VIRTUAL, 42161], [VIRTUAL, 4663], [ZERO, 8453]], 'once a minute per chain and token (native ETH by the zero address); a chain not covered never');
  at += (dex.DEX_MAX_AGE_S + 1) * 1000;
  assert.equal(store.chainPool(8453, V4), null, 'none past ten minutes');
  assert.equal(store.chainToken(8453, VIRTUAL), null);
  // Added 2026-10-06 (rugged97's delta of 6 Oct §4): the newest figures whatever their age, for New position to say a
  // figure is too old rather than missing; still each chain's own, and never Robinhood Chain's.
  assert.deepEqual([store.chainPoolSeen(8453, V4).liquidityUsd, store.chainPoolSeen(8453, V4).retrievedAt], ['136159.17', NOW]);
  assert.equal(store.chainPoolSeen(42161, V4), null);
  const HOME_POOL = `0x${'34'.repeat(32)}`;
  store.take(VIRTUAL, [pair(HOME_POOL, USDG, 10, { chainId: 'robinhood', labels: ['v4'] })], at);
  assert.equal(store.pool(HOME_POOL).liquidityUsd, '10.00', 'Robinhood Chain’s pool is kept');
  assert.equal(store.chainPoolSeen(4663, HOME_POOL), null, 'but never given out as another network’s');
});

// ---------------------------------------------------------------------------
// V2: a token's pools from both sources
// ---------------------------------------------------------------------------

/** A pools route reply naming `list`, each a verified pool with DEX Screener's figures, as New position reads it. */
function poolsReply(list) {
  const base = gateway('pools.success');
  const pool = base.pools[0];
  const reply = {
    ...base,
    pools: list.map(({ poolId, fee = 3000, hooks = '0x0000000000000000000000000000000000000000', liquidity, volume, integration = 'hookless_fixed_fee' }) => ({
      ...pool, poolId, currentLpFeePips: fee, integrationClass: integration,
      poolKey: { ...pool.poolKey, hooks, feeMode: 'fixed', fee_pips: fee },
      providerMetrics: liquidity === undefined ? null : { ...pool.providerMetrics, reportedLiquidityUsd: liquidity, volume24hUsd: volume, retrievedAt: NOW - 10 },
    })),
  };
  return v1.assertResponse('pools', reply);
}

test('V2: the pools route’s verified pools become rows with DEX Screener’s figures, attributed and dated, and the read service’s estimate method on them', () => {
  const reply = poolsReply([{ poolId: UFG_POOL, fee: 40_000, liquidity: '40200', volume: '7500' }, { poolId: `0x${'9'.repeat(64)}`, fee: 990_000 }]);
  const rows = pools.discoveryRows(reply, { transport: 'bridge', contract: null, receivedAt: NOW * 1000, attempts: 1 });
  assert.equal(rows[0].poolId, UFG_POOL);
  assert.deepEqual(rows[0].tvlUsd, { value: '40200', state: 'provider', asOf: NOW - 10, source: 'DexScreener', fallback: 'discovered' });
  assert.deepEqual(rows[0].aprFallback, { percent: '272.39', asOf: NOW - 10, basis: 'discovered' });
  assert.equal(rows[0].feePips, 40_000);
  assert.ok(rows[0].poolState.sqrtPriceX96, 'its own state for its price');
  assert.deepEqual(rows[1].tvlUsd, { value: null, state: 'unavailable', reason: 'no_provider_figures' }, 'no figure from nothing');
  assert.equal(rows[1].aprFallback, undefined);
});

test('V2: one list from both sources, each pool once, today’s listed pools first, then the largest; flagged pools wait for Show all', () => {
  const stored = row();
  const reply = poolsReply([
    { poolId: stored.poolId, fee: 3000, liquidity: '1', volume: '1' },
    { poolId: UFG_POOL, fee: 40_000, liquidity: '40200', volume: '7500' },
    { poolId: `0x${'8'.repeat(64)}`, fee: 991_200, liquidity: '15', volume: '1' },
    { poolId: `0x${'7'.repeat(64)}`, fee: 40_000, hooks: `0x${'ab'.repeat(20)}`, integration: 'requires_separate_adapter', liquidity: '99', volume: '1' },
    { poolId: `0x${'6'.repeat(64)}`, fee: 3000 },
  ]);
  const found = pools.discoveryRows(reply, { transport: 'bridge', contract: null, receivedAt: NOW * 1000, attempts: 1 });
  const merged = pools.mergeTokenPools([stored], found, { listed: [UFG_POOL] });
  assert.deepEqual(merged.map((m) => m.poolId), [UFG_POOL, stored.poolId, `0x${'7'.repeat(64)}`, `0x${'8'.repeat(64)}`, `0x${'6'.repeat(64)}`], 'listed first, then by liquidity, none last');
  assert.equal(merged.find((m) => m.poolId === stored.poolId), stored, 'the stored row claims its pool');
  const { shown, hidden } = pools.splitFlagged(merged);
  assert.deepEqual(shown.map((m) => m.poolId), [UFG_POOL, stored.poolId, `0x${'6'.repeat(64)}`]);
  assert.deepEqual(hidden.map((m) => m.poolId), [`0x${'7'.repeat(64)}`, `0x${'8'.repeat(64)}`], 'hooks, and a 99% fee');
  assert.equal(pools.flagged({ feePips: 100_000, integration: 'hookless_fixed_fee', hooks: `0x${'0'.repeat(40)}` }), false, 'exactly 10% is not flagged');
  assert.equal(pools.flagged({ feePips: null }), true, 'a dynamic fee: no positions here');
  // A refused stored row is ordered by DEX Screener's liquidity.
  const refused = row({ refused: true });
  const order = pools.mergeTokenPools([refused], found.slice(1, 2), { liquidity: (poolId) => (poolId === refused.poolId ? '99999' : null) });
  assert.deepEqual(order.map((m) => m.poolId), [refused.poolId, UFG_POOL]);
});

// ---------------------------------------------------------------------------
// V3, I1, I2: look-alikes
// ---------------------------------------------------------------------------

test('I2: confusable scripts, mixed scripts and format characters read as what they imitate, or as unsafe', () => {
  for (const fake of ['ꓴꓢꓓꓖ', 'ՍSDG', 'USDꓖ', 'ᴜꜱᴅɢ', 'ＵＳＤＧ', 'U\u200bSDG', 'USDԌ']) {
    assert.equal(mainTokens.readsAsMainToken(fake, `0x${'1'.repeat(40)}`), true, fake);
    assert.equal(mainTokens.readsAsMainToken(fake, USDG), false, `${fake} at USDG’s own address`);
  }
  for (const fake of ['ᏔᎬᎢᎻ', 'WEТH', 'ꓪꓰꓔꓧ']) assert.equal(mainTokens.readsAsMainToken(fake, `0x${'1'.repeat(40)}`), true, fake);
  for (const plain of ['UFG', 'USDGX', 'CASHCAT', '比特币币', 'ETH2']) assert.equal(mainTokens.readsAsMainToken(plain, `0x${'1'.repeat(40)}`), false, plain);
  assert.equal(reading.mixesInto('比特币币', 'USDG'), false, 'no ASCII letters in place: not a mix');
  assert.equal(reading.hasFormatCharacter('MEME\u202e'), true);
  assert.equal(featured.unsafeSymbol('MEME\u202e'), true, 'a bidirectional control is unsafe');
  assert.equal(featured.unsafeSymbol('MEME'), false);
});

test('I1: a pool or a token that passes for a main token is warned about in plain words; the real ones never are', () => {
  assert.deepEqual(lookalike.tokenWarning({ symbol: 'USDG', address: `0x${'1'.repeat(40)}` }), { kind: 'lookalike', address: `0x${'1'.repeat(40)}`, main: 'USDG' });
  assert.equal(lookalike.tokenWarning({ symbol: 'USDG', address: USDG }), null);
  assert.equal(lookalike.tokenWarning({ symbol: 'WETH', address: WETH }), null);
  assert.equal(lookalike.tokenWarning({ symbol: null, address: `0x${'1'.repeat(40)}` }), null);
  assert.deepEqual(lookalike.tokenWarning({ symbol: 'claim.io', address: `0x${'1'.repeat(40)}` }), { kind: 'unsafe', address: `0x${'1'.repeat(40)}` });
  const warning = lookalike.poolWarning([{ symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' }, { symbol: 'USDG', address: `0x${'2'.repeat(40)}` }]);
  assert.equal(lookalike.warningText(warning), 'This isn’t the USDG Domino uses. Adding money to this pool can lose it.');
  assert.equal(lookalike.warningText(warning, 'token'), 'This isn’t the USDG Domino uses. Adding money to its pools can lose it.');
  assert.equal(lookalike.poolWarning([{ symbol: 'UFG', address: UFG }, { symbol: 'USDG', address: USDG }]), null);
});

test('V3: two tokens named UFG: the most liquid, with a logo, first; the copy without one never preselected; a look-alike last and never preselected', () => {
  const known = search.knownTokens({ catalogue: [], candidates: [
    { key: UFG_COPY, wire: UFG_COPY, token: { symbol: 'UFG', address: UFG_COPY, artwork: null }, source: 'read' },
    { key: UFG, wire: UFG, token: { symbol: 'UFG', address: UFG, artwork: null }, source: 'read' },
  ] });
  const found = search.searchTokens('UFG', known, 20);
  assert.deepEqual(found.map((r) => r.token.key), [UFG_COPY, UFG], 'the service’s order put the copy first');
  const facts = { [UFG]: { liquidityUsd: 184800, artwork: true, warned: false }, [UFG_COPY]: { liquidityUsd: 0, artwork: false, warned: false } };
  const told = search.disambiguate(found, (key) => facts[key], reading.symbolReading);
  assert.deepEqual(told.results.map((r) => r.token.key), [UFG, UFG_COPY]);
  assert.deepEqual([...told.twins].sort(), [UFG, UFG_COPY].sort());
  assert.equal(told.preselect, 0, 'the real one, clearly: preselected');
  // Not known yet: nothing is preselected, whatever order the service gave.
  const unknown = search.disambiguate(found, () => ({ liquidityUsd: null, artwork: null, warned: false }), reading.symbolReading);
  assert.equal(unknown.preselect, -1);
  // Close in liquidity: not clearly the real one, so nothing preselected.
  const close = search.disambiguate(found, (key) => ({ liquidityUsd: key === UFG ? 1000 : 500, artwork: true, warned: false }), reading.symbolReading);
  assert.equal(close.preselect, -1);
  // A look-alike of USDG goes last, and a single look-alike result is never preselected.
  const fakeUsdg = search.knownTokens({ catalogue: [], candidates: [{ key: `0x${'3'.repeat(40)}`, wire: `0x${'3'.repeat(40)}`, token: { symbol: 'USDG', address: `0x${'3'.repeat(40)}`, artwork: null }, source: 'read' }] });
  const alone = search.disambiguate(search.searchTokens('USDG', fakeUsdg, 20), () => ({ liquidityUsd: 5, artwork: false, warned: true }), reading.symbolReading);
  assert.equal(alone.preselect, -1);
  // More than 8 hits come back, up to the search's 20 (B7).
  const many = search.knownTokens({ catalogue: Array.from({ length: 12 }, (_, i) => ({ address: `0xa${String(i).padStart(39, '0')}`, label: `TOK${i}`, artwork: null })), candidates: [] });
  assert.equal(search.searchTokens('tok', many, 20).length, 12);
});

// ---------------------------------------------------------------------------
// B1, B2, B3: the featured list
// ---------------------------------------------------------------------------

const CURRENT = JSON.parse(readFileSync(new URL('../../api-contracts/read-v5/fixtures/valid/current.json', import.meta.url), 'utf8'));
const answered = (body) => ({ kind: 'list', valid: featured.keptPools(body), withdrawn: body.withdrawn.map((entry) => ({ poolId: entry.poolId.toLowerCase(), reason: entry.reason })) });

test('B1: a short list says how many of its rules’ pools it shows; a whole one, the embedded one, or one without rules says nothing', () => {
  const list = featured.listFrom(answered(CURRENT));
  assert.equal(list.size, CURRENT.rules.size);
  assert.deepEqual(featured.shortCount({ ...list, entries: list.entries.slice(0, 2) }), { shown: 2, size: CURRENT.rules.size });
  assert.deepEqual(featured.shortCount({ source: 'server', entries: [1, 2], size: 6 }), { shown: 2, size: 6 });
  assert.equal(featured.shortCount({ source: 'server', entries: [1, 2, 3, 4, 5, 6], size: 6 }), null);
  assert.equal(featured.shortCount({ source: 'bundled', entries: [1], size: 6 }), null);
  assert.equal(featured.shortCount({ source: 'server', entries: [1], size: null }), null);
  // The entries carry the selection's own figures, dated at it (V1's last stand-in).
  const ranked = CURRENT.pools.find((pool) => pool.rankInputs);
  const entry = featured.entryOf(ranked);
  assert.deepEqual(entry.selection, { tvlUsd: ranked.rankInputs.reportedLiquidityUsd, volume24hUsd: ranked.rankInputs.volume24hUsd, apr: ranked.rankInputs.freshApr, evaluatedAt: ranked.rankInputs.evaluatedAt });
});

// Changed on purpose 2026-10-02 (owner: only today's list on Markets): audit B5's second table under the list on
// Markets, "Selected pools" with the embedded pools today's list does not name, is gone. The short list's count and the
// catalogue search it opens stay. In a browser: tests/release.browser.test.mjs (v).
test('B5 withdrawn 2026-10-02: Markets draws one pools table, today’s list, and no second "Selected pools" table under it', () => {
  const explore = readFileSync(new URL('../src/screens/Explore.tsx', import.meta.url), 'utf8');
  const markets = explore.slice(explore.indexOf('function MarketsList('), explore.indexOf('export function Explore('));
  assert.ok(markets.length > 0, 'MarketsList is found');
  assert.equal(markets.match(/<MarketsTable\b/g)?.length, 1, 'one table on Markets');
  assert.equal(markets.match(/aria-labelledby="markets-pools-title"/g)?.length, 1, 'one pools table section on Markets');
  assert.doesNotMatch(explore, /SelectedBeyond|data-selected-beyond|markets-selected-title|createReadMarketsProvider|MarketsContext/, 'no second table, and no markets provider of its own');
  // Changed on purpose 2026-10-03 (the owner): a short list no longer says how many of its pools it shows ("5 of 6 today").
  assert.doesNotMatch(markets, /data-featured-count|\{short\.shown\} of/, 'no count beside the title');
  assert.match(markets, /id="markets-catalogue-token"/, 'the catalogue search is always available, including a short list');
  assert.doesNotMatch(markets, /catalogueOpen && source/, 'the search is not hidden behind an accordion');
  assert.match(markets, /data-catalogue-search=""/, 'the catalogue search stays');
});

test('B2: New position refuses a link only to a pool withdrawn for safety; one withdrawn because its figures were unavailable is not refused', async () => {
  const at = CURRENT.servedAt;
  const body = { ...structuredClone(CURRENT), withdrawn: [
    { poolId: `0x${'a'.repeat(64)}`, reason: 'estimate_unavailable', at },
    { poolId: `0x${'b'.repeat(64)}`, reason: 'volume_collapse', at },
    { poolId: `0x${'c'.repeat(64)}`, reason: 'token_code_changed', at },
    { poolId: `0x${'d'.repeat(64)}`, reason: 'excluded_by_owner', at },
  ] };
  const store = featured.createFeaturedStore({ read: async () => answered(body) });
  const snapshot = await store.ensure();
  assert.deepEqual([...snapshot.withdrawn].sort(), [`0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`]);
  assert.equal(snapshot.withdrawnReasons.get(`0x${'a'.repeat(64)}`), 'estimate_unavailable', 'every reason is kept');
  assert.deepEqual([...featured.SOFT_WITHDRAWALS].sort(), ['estimate_unavailable', 'volume_collapse']);
});

test('B3: every read made while the embedded list holds the place is a placeholder read; a refresh of a served list is not', async () => {
  const flags = [];
  const answers = [{ kind: 'failed', passing: true }, answered(CURRENT), answered(CURRENT)];
  const timers = [];
  const clock = { ...realClock, timer: (ms, fire) => { timers.push(fire); return () => undefined; } };
  const store = featured.createFeaturedStore({ clock, read: async (_signal, placeholder) => { flags.push(placeholder === true); return answers.shift(); } });
  await store.ensure();
  timers[0](); await new Promise((resolve) => setImmediate(resolve));
  await store.refresh();
  assert.deepEqual(flags, [true, true, false]);
});

// ---------------------------------------------------------------------------
// A7 a: the copy names the pools to read first, for a day
// ---------------------------------------------------------------------------

test('A7 a: past 15 minutes the copy paints nothing, and for a day still names the pools to read beside the list', () => {
  const data = overviewFixture();
  let at = 1_000_000;
  // 2026-10-01 (the chain2 workstream, part B, audit G10): a copy under its name from before (no chain in it) moves to
  // domino-markets-v2:4663 on this first read, and is read the same.
  const store = storage({ 'domino-markets:v1': JSON.stringify({ v: 1, contract: v3.CONTRACT_VERSION, receivedAt: at, data }) });
  const paint = createPaintMemory(() => store, { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateResponse: v3.validateResponse }, () => at);
  assert.ok(paint.load());
  assert.deepEqual(paint.prefetch(), data.requestedPoolIds);
  at += PAINT_MAX_AGE_MS;
  assert.equal(paint.load(), null, 'nothing painted');
  assert.deepEqual(paint.prefetch(), data.requestedPoolIds, 'its pools still named');
  at += PREFETCH_MAX_AGE_MS;
  assert.equal(paint.prefetch(), null, 'past a day, nothing');
});

// ---------------------------------------------------------------------------
// A22 and the edge's age: the client's side
// ---------------------------------------------------------------------------

// Rewritten on purpose 2026-10-15 (pack 7): an answer that lists routes is kept CAPABILITIES_KEEP_MS (five minutes; was a
// minute) for a route it lists, so its renewal behind comes then; a route it does not list still asks again past its minute.
test('A22: a capabilities answer past its time is used at once for a route it lists, renewed behind; one that does not list the route is asked again first, past its minute', async () => {
  let at = 0;
  let enabled = ['overview'];
  const gets = [];
  let release = null;
  const clock = { ...realClock, now: () => at, monotonic: () => at };
  const capabilities = () => JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8'));
  const source = createBridgeSource({ enabled: true, validators: v3, namespace: 'v3', clock, fetch: async (path) => {
    gets.push(path);
    if (release) await new Promise((resolve) => { const go = release; release = null; go(resolve); });
    const data = capabilities(); data.enabledReads = enabled;
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  } });
  assert.equal((await source.routeEnabled('overview')).state, 'enabled');
  assert.equal(gets.length, 1);
  at = 60_000;
  assert.equal((await source.routeEnabled('overview')).state, 'enabled');
  assert.equal(gets.length, 1, 'a route it lists: kept past its minute, nothing asked');
  at = CAPABILITIES_KEEP_MS;
  let resume;
  release = (go) => { resume = go; };
  // The renewal waits; the read does not.
  assert.equal((await source.routeEnabled('overview')).state, 'enabled', 'the kept answer, at once');
  assert.equal(gets.length, 2, 'renewed behind');
  enabled = ['overview', 'search'];
  resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await source.routeEnabled('search')).state, 'enabled', 'the renewed answer, once in');
  // A route the kept answer does not list waits for the renewal, so a route switched on is used at once.
  at = CAPABILITIES_KEEP_MS + 60_000;
  enabled = ['overview', 'search', 'history'];
  assert.equal((await source.routeEnabled('history')).state, 'enabled');
  assert.equal(gets.length, 3);
});

// Changed on purpose 2026-10-30 (launch capacity, item 4): within an hour, the featured list's stand-in at the edge
// (functions/_lib/featuredEdge.ts ERROR_SECONDS), no longer 15 minutes.
test('the edge’s age dates an answer by when the edge received it; anything but a plain whole number of ms within an hour is no age', () => {
  assert.equal(edgeAgeOf('8123'), 8123);
  assert.equal(edgeAgeOf('0'), 0);
  assert.equal(edgeAgeOf('900001'), 900_001, 'a stand-in kept past 15 minutes');
  assert.equal(edgeAgeOf('3600000'), 3_600_000);
  for (const bad of [null, '-1', '1.5', '1e3', '3600001', 'abc', '']) assert.equal(edgeAgeOf(bad), undefined, String(bad));
});

// ---------------------------------------------------------------------------
// I3: DEX Screener through our own edge, the provider directly only when the edge gives no answer
// ---------------------------------------------------------------------------

test('I3: the token-pairs body is asked of our own edge first, with the beta cookie; the provider directly only when the edge gives no answer, then for five minutes', async () => {
  const asked = [];
  let edgeUp = true;
  let at = 0;
  const pair = { chainId: 'robinhood', baseToken: { address: UFG }, quoteToken: { address: USDG }, info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=8' } };
  const resolver = createTokenArtworkResolver({ edge: DEX_EDGE, now: () => at, wall: () => 1_000_000, fetch: async (url, init) => {
    asked.push([url, init.credentials, init.referrerPolicy]);
    if (url.startsWith('/api/') && !edgeUp) return new Response('{"error":"upstream_unavailable"}', { status: 502, headers: { 'content-type': 'application/json' } });
    // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D1): the Wallet card's prices are asked on our edge's
    // new path, whose answer says each token's own state.
    // Changed on purpose 2026-10-15 (pack 7): the token-pairs reads too, each token dated by the edge's own retrieval.
    if (url.startsWith('/api/read/dex2/')) return new Response(JSON.stringify({ v: 2, now: 9_000, tokens: Object.fromEntries(url.split('/').pop().split(',').map((token) => [token, { at: 5_000, pairs: [pair] }])) }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify([pair]), { headers: { 'content-type': 'application/json' } });
  } });
  const heard = [];
  resolver.onPairs((address, body, retrievedAt) => heard.push([address, retrievedAt]));
  assert.ok(await resolver.resolve(4663, UFG));
  assert.deepEqual(asked, [[`/api/read/dex2/token-pairs/${UFG}`, 'same-origin', 'no-referrer']]);
  assert.deepEqual(heard, [[UFG, 1_000_000 - 4000]], 'dated by the edge’s own retrieval');
  edgeUp = false;
  at += 31_000;
  await resolver.pairs(4663, UFG_COPY);
  assert.deepEqual(asked.slice(1), [[`/api/read/dex2/token-pairs/${UFG_COPY}`, 'same-origin', 'no-referrer'], [`https://api.dexscreener.com/token-pairs/v1/robinhood/${UFG_COPY}`, 'omit', 'no-referrer']]);
  await resolver.tokenPrices([UFG]);
  assert.deepEqual(asked.at(-1), [`https://api.dexscreener.com/token-pairs/v1/robinhood/${UFG}`, 'omit', 'no-referrer'], 'for five minutes the provider directly, with the same pair coverage');
  at += 300_001;
  edgeUp = true;
  await resolver.tokenPrices([UFG, USDG]);
  assert.deepEqual(asked.at(-1), [`/api/read/dex2/tokens/${[UFG, USDG].sort().join(',')}`, 'same-origin', 'no-referrer'], 'then the edge again, on its new path (2026-10-14, D1)');
  // Without an edge (the test builds), the provider directly, as before.
  const direct = [];
  const plain = createTokenArtworkResolver({ fetch: async (url) => (direct.push(url), new Response('[]', { headers: { 'content-type': 'application/json' } })) });
  await plain.pairs(4663, UFG);
  assert.deepEqual(direct, [`https://api.dexscreener.com/token-pairs/v1/robinhood/${UFG}`]);
});

// Rewritten on purpose 2026-10-14 (incident of 2026-10-13, package D1). It was '…; a failed batch alone uses equivalent
// per-token coverage': the tokens of a GET our edge did not answer were asked of the provider directly, one GET each,
// from the visitor's own address. The list now goes to the edge's new path, whose answer says each token's own state; a
// GET that gives nothing leaves its tokens without a price yet, and nothing goes to the provider while any token was answered.
test('I3: a wallet’s price list goes to our edge’s new path ten tokens a GET; a GET that fails leaves its tokens with no price yet, and no direct call', async () => {
  const tokens = Array.from({ length: 12 }, (_, i) => `0xb${String(i).padStart(39, '0')}`)
  const asked = []
  let failOne = false
  const resolver = createTokenArtworkResolver({ edge: DEX_EDGE, now: () => 0, wall: () => 1, fetch: async (url) => {
    asked.push(url)
    if (url.startsWith('/api/') && failOne && url.includes(tokens[11])) return new Response('{"error":"upstream_unavailable"}', { status: 502, headers: { 'content-type': 'application/json' } })
    const named = url.split('/').pop().split(',')
    return new Response(JSON.stringify({ v: 2, now: 1, tokens: Object.fromEntries(named.map((address) => [address, { at: 1, pairs: [{ chainId: 'robinhood', baseToken: { address }, quoteToken: { address: USDG } }] }])) }), { headers: { 'content-type': 'application/json' } })
  } })
  const body = await resolver.tokenPrices(tokens)
  assert.deepEqual(asked, [`/api/read/dex2/tokens/${tokens.slice(0, 10).join(',')}`, `/api/read/dex2/tokens/${tokens.slice(10).join(',')}`])
  assert.deepEqual(Object.keys(body.tokens), tokens, 'one answer for the whole list')
  assert.deepEqual(Object.values(body.tokens).map((token) => token.pairs[0].baseToken.address), tokens)
  assert.deepEqual(body.unavailable, [])
  asked.length = 0
  failOne = true
  const partial = await resolver.tokenPrices(tokens)
  assert.equal(asked.length, 2, 'the two GETs, and no direct call for the one that failed')
  assert.ok(asked.every((url) => url.startsWith('/api/read/dex2/')))
  assert.deepEqual(partial.unavailable, tokens.slice(10), 'its tokens have no price yet')
  assert.deepEqual(Object.keys(partial.tokens), tokens.slice(0, 10))
})
