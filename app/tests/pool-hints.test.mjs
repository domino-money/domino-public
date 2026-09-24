/**
 * New position's first step (owner, 2026-09-24): only pools Domino can open a
 * position in, largest TVL first, and the pools worth verifying named in the
 * one pools read. The pure parts: which pools are usable (poolsList.ts
 * `usableForDomino`, `projectPoolsView(…, { only: 'domino' })`), the order
 * (`byTvl`), the request (`usablePoolsRequest`, checked against the read
 * contract's own request validator) and the pool-id hints taken from the
 * provider's token-pairs list (poolHints.ts), replayed on a saved reply.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const pools = require('../.test-build/app/src/lib/read/screens/poolsList.js');
const hints = require('../.test-build/app/src/lib/read/screens/poolHints.js');
const featured = require('../.test-build/app/src/lib/read/screens/featuredPools.js');
const { SELECTED_POOLS } = require('../.test-build/app/src/config/selectedPools.js');

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8'));
const TOKEN = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
const HOOKS = `0x${'ab'.repeat(20)}`;
const id = (digit) => `0x${digit.repeat(64)}`;
/** The saved token-pairs reply for PONS (2026-09-23), trimmed to the fields the hints read. */
const PONS_BODY = JSON.parse(readFileSync(new URL('./support/dexscreener-pons.json', import.meta.url), 'utf8'));
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** The same replies for USDG and for native ETH (the zero address), 2026-09-23: 30 pairs each, the provider's cap. */
const USDG_BODY = JSON.parse(readFileSync(new URL('./support/dexscreener-usdg.json', import.meta.url), 'utf8'));
const ETH_BODY = JSON.parse(readFileSync(new URL('./support/dexscreener-eth.json', import.meta.url), 'utf8'));
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const U = '0xce24439f2d9c6a2289f741120fe202248b666666';
/** The featured pools (config/selectedPools.ts), in catalogue order. */
const [WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG, PONS_USDG] = SELECTED_POOLS;

/** The fixture's one pool with another id, key, liquidity or volume. */
function pool({ poolId, liquidity = '10.00', volume = '1234.56', hooks = ZERO, dynamic = false, integration = 'hookless_fixed_fee', fee = 3000, metrics = true } = {}) {
  const base = fixture('pools.success').pools[0];
  return {
    ...base,
    poolId,
    currentLpFeePips: dynamic ? 0 : fee,
    integrationClass: integration,
    poolKey: dynamic
      ? { ...base.poolKey, hooks, feeMode: 'dynamic', fee_pips: 8388608 }
      : { ...base.poolKey, hooks, feeMode: 'fixed', fee_pips: fee },
    providerMetrics: metrics ? { ...base.providerMetrics, reportedLiquidityUsd: liquidity, volume24hUsd: volume } : null,
  };
}
const reply = (list, extra = {}) => runtime.assertResponse('pools', { ...fixture('pools.success'), pools: list, ...extra });

test('only pools Domino can open a position in: no hooks and a fixed fee, every field agreeing', () => {
  const plain = pool({ poolId: id('1') });
  assert.equal(pools.usableForDomino(plain), true);
  assert.equal(pools.usableForDomino(pool({ poolId: id('2'), hooks: HOOKS, integration: 'requires_separate_adapter' })), false, 'hooks');
  assert.equal(pools.usableForDomino(pool({ poolId: id('3'), hooks: HOOKS, dynamic: true, integration: 'requires_separate_adapter' })), false, 'a dynamic fee');
  // One field that disagrees is enough to leave a pool out, whichever it is.
  assert.equal(pools.usableForDomino(pool({ poolId: id('4'), integration: 'requires_separate_adapter' })), false, 'the class alone');
  assert.equal(pools.usableForDomino(pool({ poolId: id('5'), hooks: HOOKS })), false, 'hooks alone, whatever the class says');
  assert.equal(pools.usableForDomino(pool({ poolId: id('6'), dynamic: true })), false, 'the dynamic flag alone');
  assert.equal(pools.usableForDomino({ ...plain, poolKey: { ...plain.poolKey, hooks: HOOKS.toUpperCase().replace('0X', '0x') } }), false, 'hooks in any case');
  // The projected pool, for a link or a pool page, says the same.
  const option = (p) => pools.projectPoolsView(reply([p])).options[0];
  assert.equal(pools.optionUsableForDomino(option(plain)), true);
  for (const p of [pool({ poolId: id('2'), hooks: HOOKS, integration: 'requires_separate_adapter' }), pool({ poolId: id('3'), hooks: HOOKS, dynamic: true, integration: 'requires_separate_adapter' }), pool({ poolId: id('4'), integration: 'requires_separate_adapter' })]) {
    assert.equal(pools.optionUsableForDomino(option(p)), false, p.poolId);
  }
});

test('with only: domino a hooked or dynamic pool is never an option, a row or a count; the rest are in TVL order', () => {
  const mixed = reply([
    pool({ poolId: id('a'), liquidity: '5.00' }),
    pool({ poolId: id('b'), hooks: HOOKS, integration: 'requires_separate_adapter', liquidity: '9000000' }),
    pool({ poolId: id('c'), hooks: HOOKS, dynamic: true, integration: 'requires_separate_adapter', liquidity: '8000000' }),
    pool({ poolId: id('d'), liquidity: '250.5' }),
  ], { unverifiedCandidates: [{ poolId: id('e'), reason: 'pool_id_mismatch' }] });
  const view = pools.projectPoolsView(mixed, 7, { only: 'domino' });
  assert.deepEqual(view.options.map((o) => o.key), [id('d'), id('a')], 'hookless only, the larger TVL first');
  assert.equal(view.hidden, 2, 'how many were left out, for data');
  assert.deepEqual(view.rejected.map((r) => r.reason), ['pool_id_mismatch'], 'rejected candidates are kept as they were');
  assert.equal(view.options[0].readAt, 7);
  // Without it nothing changes: every pool, the neutral order, nothing hidden.
  const all = pools.projectPoolsView(mixed);
  assert.deepEqual(all.options.map((o) => o.key), [id('a'), id('b'), id('d'), id('c')]);
  assert.equal(all.hidden, 0);
  // Every pool left out: no options at all.
  assert.deepEqual(pools.projectPoolsView(reply([pool({ poolId: id('b'), hooks: HOOKS, integration: 'requires_separate_adapter' })]), null, { only: 'domino' }).options, []);
});

test('TVL order: reported TVL highest first, compared as exact decimals; unknown last; ties by volume, then fee, then id', () => {
  const figure = (raw, stale = false) => ({ state: stale ? 'attributed_stale' : 'attributed', value: raw, raw, zero: false, provider: 'dexscreener', retrievedAt: 0, cacheAgeSeconds: null, ...(stale ? { refreshReason: null } : {}) });
  const missing = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' };
  const row = (key, liquidity, volume = missing, feePips = 3000) => ({ key, liquidity, volume, feePips });
  const ordered = pools.byTvl([
    row('0x01', missing),
    row('0x02', figure('9.999')),
    row('0x03', figure('10.00')),
    row('0x04', figure('10.0000000000000000001', true)),
    row('0x05', { state: 'not_reported', provider: 'dexscreener' }, figure('500')),
    row('0x06', { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' }),
    row('0x07', figure('10.00'), figure('3')),
    row('0x08', figure('10'), figure('3'), 500),
    row('0x09', figure('0')),
  ]);
  assert.deepEqual(ordered.map((o) => o.key), [
    '0x04', // a retained figure still counts, and 10.0000000000000000001 > 10
    '0x08', '0x07', // 10 with volume 3: the lower fee tier first
    '0x03', // 10 with no volume
    '0x02', // 9.999
    '0x09', // a real zero is a reported TVL
    '0x05', // no TVL: volume first among them
    '0x01', '0x06', // no TVL, no volume: fee then id
  ]);
  assert.deepEqual(pools.byTvl([]), []);
});

test('the pools read names the hinted pools and asks for exactly that many, and passes the read contract', () => {
  const token = TOKEN;
  assert.deepEqual(pools.usablePoolsRequest(token, null, []), { token }, 'no hints: the plain read');
  assert.deepEqual(pools.usablePoolsRequest(token, USDG, []), { token, pairedToken: USDG });
  const three = [id('a'), id('b'), id('c')];
  const request = pools.usablePoolsRequest(token, null, three);
  assert.deepEqual(request, { token, maxPools: 3, poolIds: three });
  assert.deepEqual(Object.keys(pools.usablePoolsRequest(token, USDG, three)), ['token', 'pairedToken', 'maxPools', 'poolIds'], 'a fixed key order: the scheduler coalesces by JSON');
  const eleven = [...'123456789ab'].map(id);
  const capped = pools.usablePoolsRequest(token, USDG, eleven);
  assert.equal(capped.poolIds.length, 10);
  assert.equal(capped.maxPools, 10);
  for (const body of [request, capped, pools.usablePoolsRequest(token, null, []), pools.usablePoolsRequest(token, USDG, [id('f')])]) {
    assert.equal(runtime.validateRequest('pools', body), true, JSON.stringify(body));
  }
});

// Review 2026-09-23: the provider's token-pairs list is a 30-pair sample, not ranked by liquidity. For USDG, the token
// every featured pool holds, it names none of U/USDG ($3.0M), cbBTC/USDG, ETH/USDG or WETH/USDG, so step 1 never
// listed them. The featured pools that hold the token are named first; every one was read on chain (Initialize, 2026-09-23)
// as hookless with a fixed fee, and ETH/USDG as holding native ETH, although its catalogue row names no addresses.
test('the featured pools that hold the token, in catalogue order; ETH/USDG by the native ETH its pool was read to hold', () => {
  assert.deepEqual(featured.featuredPoolIds(USDG, null), [WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG, PONS_USDG], 'all six hold USDG');
  assert.deepEqual(featured.featuredPoolIds(ZERO, null), [ETH_USDG], 'native ETH');
  assert.deepEqual(featured.featuredPoolIds(ZERO, USDG), [ETH_USDG]);
  assert.deepEqual(featured.featuredPoolIds(USDG, ZERO), [ETH_USDG], 'USDG with native ETH on the other side');
  assert.deepEqual(featured.featuredPoolIds(WETH, null), [WETH_USDG], 'wrapped ether is another token');
  assert.deepEqual(featured.featuredPoolIds(WETH, ZERO), []);
  assert.deepEqual(featured.featuredPoolIds(U, null), [U_USDG]);
  assert.deepEqual(featured.featuredPoolIds(USDG, PONS), [PONS_USDG], 'the second asset must be the other side');
  assert.deepEqual(featured.featuredPoolIds(PONS, USDG), [PONS_USDG]);
  assert.deepEqual(featured.featuredPoolIds(PONS, WETH), []);
  assert.deepEqual(featured.featuredPoolIds(TOKEN, null), [], 'a token no featured pool holds');
});

test('USDG: the featured pools first, then the provider’s hints, each once, ten at most, and exactly that many asked for', () => {
  const provider = hints.v4PoolHints(USDG_BODY, USDG, null);
  assert.equal(provider.length, 10);
  for (const poolId of [WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG]) assert.equal(provider.includes(poolId), false, `the provider’s sample leaves out ${poolId}`);
  assert.equal(provider[1], PONS_USDG, 'one featured pool is in it, second');
  const request = pools.usablePoolsRequest(USDG, null, provider);
  assert.deepEqual(request, {
    token: USDG,
    maxPools: 10,
    poolIds: [
      WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG, PONS_USDG,
      // Then the provider's most liquid, PONS/USDG not twice.
      '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea',
      provider[2], provider[3], provider[4],
    ],
  });
  assert.equal(new Set(request.poolIds).size, 10, 'each once');
  // Hints that are slow or missing still leave the featured pools, not the catalogue's first twelve by id.
  assert.deepEqual(pools.usablePoolsRequest(USDG, null, []), { token: USDG, maxPools: 6, poolIds: [WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG, PONS_USDG] });
  // A second asset keeps only the featured pools with it on the other side.
  assert.deepEqual(pools.usablePoolsRequest(USDG, PONS, [id('a')]), { token: USDG, pairedToken: PONS, maxPools: 2, poolIds: [PONS_USDG, id('a')] });
  // Six featured and eleven hints: ten at most.
  const eleven = [...'123456789ab'].map(id);
  const capped = pools.usablePoolsRequest(USDG, null, eleven);
  assert.deepEqual(capped.poolIds, [WETH_USDG, USDG_MARLIN, CBBTC_USDG, U_USDG, ETH_USDG, PONS_USDG, ...eleven.slice(0, 4)]);
  assert.equal(capped.maxPools, 10);
  // A hint that repeats a featured pool is named once, where the featured pools are.
  assert.deepEqual(pools.usablePoolsRequest(PONS, null, [id('a'), PONS_USDG, id('b')]), { token: PONS, maxPools: 3, poolIds: [PONS_USDG, id('a'), id('b')] });
  for (const body of [request, capped, pools.usablePoolsRequest(USDG, null, []), pools.usablePoolsRequest(USDG, PONS, [id('a')])]) {
    assert.equal(runtime.validateRequest('pools', body), true, JSON.stringify(body));
  }
});

test('native ETH: its featured pool first, then the provider’s native ETH pools, asked by the zero address', async () => {
  const provider = await hints.poolHints(ZERO, null, async (address) => (address === ZERO ? ETH_BODY : null));
  assert.equal(provider.length, 10, 'ETH alone is asked, by the zero address the provider lists native ETH under');
  assert.equal(provider[0], '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551', 'the most liquid, hooked or not: the chain decides');
  assert.equal(provider.indexOf(ETH_USDG), 4);
  const request = pools.usablePoolsRequest(ZERO, null, provider);
  assert.equal(request.poolIds[0], ETH_USDG);
  assert.deepEqual(request.poolIds.slice(1), [...provider.slice(0, 4), ...provider.slice(5)], 'then the rest, ETH/USDG not twice');
  assert.equal(request.maxPools, 10);
  assert.deepEqual(pools.usablePoolsRequest(ZERO, null, []), { token: ZERO, maxPools: 1, poolIds: [ETH_USDG] }, 'no hints: the featured pool alone');
  assert.equal(runtime.validateRequest('pools', request), true);
});

test('pool-id hints: Robinhood Chain Uniswap v4 pools that hold the token (and the second asset), most liquid first, ten at most', () => {
  const all = hints.v4PoolHints(PONS_BODY, PONS, null);
  assert.equal(all.length, 10, 'twelve v4 pairs in the saved reply, ten named');
  assert.deepEqual(all.slice(0, 4), [
    '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
    '0xb59001413cb070e28433826f927b7265a0813213ba21f454d86896cee3cce674',
    '0x13f9ab4e07b7f222cf49ff8ae9d7cdd2f749546eb3f83bdd84b884e27dd5e49d',
  ]);
  assert.ok(all.every((poolId) => /^0x[0-9a-f]{64}$/.test(poolId)), 'lowercase pool ids only: no pair contract of another exchange');
  assert.equal(hints.v4PoolHints(PONS_BODY, PONS, null, 20).length, 10, 'never more than the read contract allows');
  // With a second asset only its pools, and the other side must be exactly it.
  assert.deepEqual(hints.v4PoolHints(PONS_BODY, PONS, USDG), [
    '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
    '0x13f9ab4e07b7f222cf49ff8ae9d7cdd2f749546eb3f83bdd84b884e27dd5e49d',
    '0xfcb3ac1562a590e0c96f24a0e664dbe9dcc2f98e05f3311be02eba6909af5c7d',
    '0xaaa11bc76a36c8d0bbdac3d481b8c61a1c2a0667b2da9e7c5796f3207ef65d8d',
    '0x5cf9e7a7c416d1a1673a013c1bb311a1cf57be2944616949c2dd15e4624a3bff',
  ]);
  assert.equal(hints.v4PoolHints(PONS_BODY, PONS, ZERO).length, 6, 'native ETH as the second asset');
  // Asked for the quote side, the same pairs hold it.
  assert.deepEqual(hints.v4PoolHints(PONS_BODY, USDG, PONS), hints.v4PoolHints(PONS_BODY, PONS, USDG));
  assert.deepEqual(hints.v4PoolHints(PONS_BODY, TOKEN, null), [], 'a token the pairs do not hold');
});

test('pool-id hints refuse anything that is not exactly a listed v4 pool with a finite liquidity figure', () => {
  const good = { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: id('A'), baseToken: { address: TOKEN }, quoteToken: { address: ZERO }, liquidity: { usd: 5 } };
  const one = (patch) => hints.v4PoolHints([{ ...good, ...patch }], TOKEN, null);
  assert.deepEqual(one({}), [id('a')], 'lowercased');
  for (const [why, patch] of [
    ['another chain', { chainId: 'ethereum' }],
    ['another exchange', { dexId: 'ramses' }],
    ['v3', { labels: ['v3'] }],
    ['no labels', { labels: undefined }],
    ['a pair contract', { pairAddress: `0x${'a'.repeat(40)}` }],
    ['not hex', { pairAddress: `0x${'g'.repeat(64)}` }],
    ['no liquidity', { liquidity: undefined }],
    ['liquidity as text', { liquidity: { usd: '5' } }],
    ['negative liquidity', { liquidity: { usd: -1 } }],
    ['infinite liquidity', { liquidity: { usd: Infinity } }],
    ['NaN liquidity', { liquidity: { usd: NaN } }],
    ['a token on neither side', { baseToken: { address: USDG } }],
    ['a malformed address', { baseToken: { address: 'TOKEN' } }],
  ]) assert.deepEqual(one(patch), [], why);
  assert.deepEqual(hints.v4PoolHints([null, 7, 'x', [], good], TOKEN, null), [id('a')], 'junk entries are skipped');
  // Each id once, where it is most liquid; equal liquidity by id.
  assert.deepEqual(hints.v4PoolHints([{ ...good, liquidity: { usd: 1 } }, { ...good, pairAddress: id('b'), liquidity: { usd: 3 } }, { ...good, liquidity: { usd: 2 } }, { ...good, pairAddress: id('c'), liquidity: { usd: 3 } }], TOKEN, null), [id('b'), id('c'), id('a')]);
  for (const body of [null, {}, 'x', Array(101).fill(good)]) assert.deepEqual(hints.v4PoolHints(body, TOKEN, null), [], 'not a list, or longer than the provider sends');
  assert.deepEqual(hints.v4PoolHints([good], TOKEN, USDG), [], 'the second asset is not the other side');
});

test('hints are asked for by a token the provider lists, and never hold up the read: a failure, a slow answer or a cancel gives none', async () => {
  const asked = [];
  const pairs = async (address) => { asked.push(address); return address === ZERO ? ETH_BODY : PONS_BODY; };
  assert.equal((await hints.poolHints(PONS, null, pairs)).length, 10);
  assert.equal((await hints.poolHints(ZERO, PONS, pairs)).length, 6, 'native ETH with a second asset is asked by its other side');
  assert.equal((await hints.poolHints(ZERO, null, pairs)).length, 10, 'ETH alone is asked by the zero address, the provider’s name for native ETH');
  assert.deepEqual(asked, [PONS, PONS, ZERO]);

  const signal = new AbortController().signal;
  assert.equal((await hints.hintsWithin(PONS, USDG, signal, { pairs })).length, 6);
  assert.deepEqual(await hints.hintsWithin(PONS, null, signal, { pairs: async () => { throw new Error('offline'); } }), [], 'a failure');
  const started = Date.now();
  assert.deepEqual(await hints.hintsWithin(PONS, null, signal, { wait: 30, pairs: () => new Promise(() => {}) }), [], 'an answer that never comes');
  assert.ok(Date.now() - started < 2000);
  const controller = new AbortController();
  const cancelled = hints.hintsWithin(PONS, null, controller.signal, { pairs: () => new Promise(() => {}) });
  controller.abort();
  assert.deepEqual(await cancelled, []);
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await hints.hintsWithin(PONS, null, aborted.signal, { pairs }), [], 'already cancelled');
  assert.equal(hints.HINT_WAIT_MS, 2500);
});
