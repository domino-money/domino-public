import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { marketPoolPrice } = require('../.test-build/app/src/lib/read/marketPrice.js');
const { PRICE_STALE_MS, sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const { retainAsStale } = require('../.test-build/app/src/lib/read/marketsProvider.js');
const { projectMarketRow } = require('../.test-build/app/src/lib/read/project.js');
const { formatUsdPrice } = require('../.test-build/app/src/lib/read/decimal.js');

// The WETH/USDG pool as read on 2026-09-13: WETH is currency0 (18 decimals), USDG currency1 (6 decimals).
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TICK = -198111;
const BLOCK = 62038995;
const RECEIVED = { wall: 1_000_000, monotonic: 50_000 };
/** A moment `ms` after the row's reply arrived, on both clocks. */
const at = (ms) => ({ wall: RECEIVED.wall + ms, monotonic: RECEIVED.monotonic + ms });
const token = (address, symbol, decimals, readStatus = 'available') => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus, artwork: null });

/** A markets row as projectMarketRow builds it, with the pool state and the two token reads it carries. */
function row({ tick = TICK, sqrtPriceX96 = sqrtPriceAtTick(tick).toString(), base = token(WETH, 'WETH', 18), quote = token(USDG, 'USDG', 6), pool = {}, received = RECEIVED } = {}) {
  return {
    key: '4663:0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    poolId: '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    base: base.symbol ?? base.address,
    quote: quote.symbol ?? quote.address,
    tokens: { base, quote },
    feePips: 200,
    protocol: 'v4',
    tvlUsd: { value: '518671.8794', state: 'provider', source: 'GeckoTerminal', asOf: 1000 },
    volume24hUsd: { value: '4155190.92551692', state: 'provider', source: 'GeckoTerminal', asOf: 1000 },
    feeAprPercent: { value: null, state: 'unavailable', reason: 'fee_apr_not_provided' },
    poolState: { sqrtPriceX96, tick, tickSpacing: 4, block: BLOCK, currency0: WETH, currency1: USDG, ...pool },
    provenance: {
      block: BLOCK,
      market: { status: 'available', reason: null, cacheAgeSeconds: 0, freshForSeconds: 60, receivedAt: received.wall, ...(received.monotonic === undefined ? {} : { receivedMonotonic: received.monotonic }) },
      metrics: 'not_requested',
      fixtures: [],
    },
  };
}

test('a usable price is the pool’s own ratio, currency1 per currency0, from the tick maths with its ≈', () => {
  const price = marketPoolPrice(row(), at(0));
  assert.deepEqual(
    { state: price.state, text: price.text, base: price.base.symbol, quote: price.quote.symbol, block: price.block, stale: price.stale, partial: price.partial },
    { state: 'usable', text: '≈2,492.18', base: 'WETH', quote: 'USDG', block: BLOCK, stale: false, partial: false },
  );
  assert.equal(`${price.text} ${price.quote.symbol} per ${price.base.symbol}`, '≈2,492.18 USDG per WETH');
  assert.doesNotMatch(price.text, /\$/, 'a ratio between two tokens, never dollars');
  // The row's token slots do not decide the orientation: the pool's currencies do, matched by address.
  const swapped = marketPoolPrice(row({ base: token(USDG, 'USDG', 6), quote: token(WETH, 'WETH', 18) }), at(0));
  assert.deepEqual([swapped.text, swapped.quote.symbol, swapped.base.symbol], ['≈2,492.18', 'USDG', 'WETH']);
});

test('the projection carries the verified pool’s state, and the package fixture reads TOKEN per ETH', () => {
  const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8'));
  const data = fixture('pool-market.success');
  const ok = (route, body) => ({ route, state: 'ok', data: body, provenance: { transport: 'fixture', contract: null, receivedAt: RECEIVED.wall, receivedMonotonic: RECEIVED.monotonic, attempts: 1 } });
  const tokens = new Map([
    [data.pool.currencies[0], ok('token', fixture('token.native'))],
    [data.pool.currencies[1], ok('token', fixture('token.success'))],
  ]);
  const market = projectMarketRow({ market: ok('pool-market', data), metrics: null, tokens });
  assert.deepEqual(market.poolState, {
    sqrtPriceX96: data.pool.sqrtPriceX96,
    tick: data.pool.tick,
    tickSpacing: data.pool.poolKey.tick_spacing,
    block: data.snapshot.number,
    currency0: data.pool.poolKey.currency0.toLowerCase(),
    currency1: data.pool.poolKey.currency1.toLowerCase(),
  });
  const price = marketPoolPrice(market, at(1000));
  assert.deepEqual([price.state, price.text, price.quote.symbol, price.base.symbol, price.block], ['usable', '≈1,000,000,000,000', 'TOKEN', 'ETH', 700]);
});

test('decimals that were not read make the price unavailable, never guessed', () => {
  assert.deepEqual(marketPoolPrice(row({ quote: token(USDG, null, null, 'unavailable') }), at(0)), { state: 'unavailable', problem: 'decimals_unknown', block: BLOCK });
  assert.deepEqual(marketPoolPrice(row({ base: token(WETH, 'WETH', null, 'partial') }), at(0)), { state: 'unavailable', problem: 'decimals_unknown', block: BLOCK });
  // A currency the row holds no token read for is not matched by position.
  const stranger = row({ pool: { currency1: '0x1111111111111111111111111111111111111111' } });
  assert.deepEqual(marketPoolPrice(stranger, at(0)), { state: 'unavailable', problem: 'decimals_unknown', block: BLOCK });
});

test('a tick that disagrees with the square-root price uses neither', () => {
  assert.deepEqual(marketPoolPrice(row({ sqrtPriceX96: sqrtPriceAtTick(TICK + 60).toString() }), at(0)), { state: 'unavailable', problem: 'tick_mismatch', block: BLOCK });
  assert.deepEqual(marketPoolPrice(row({ sqrtPriceX96: 'not a number' }), at(0)), { state: 'unavailable', problem: 'tick_mismatch', block: BLOCK });
  // The upper end is inclusive: a swap that stops on a boundary leaves the tick one below it.
  assert.equal(marketPoolPrice(row({ sqrtPriceX96: sqrtPriceAtTick(TICK + 1).toString() }), at(0)).state, 'usable');
});

test('a pool with no price yet is not initialised', () => {
  assert.deepEqual(marketPoolPrice(row({ sqrtPriceX96: '0' }), at(0)), { state: 'unavailable', problem: 'not_initialized', block: BLOCK });
});

test('a ratio too large or too small to write as a plain number is beyond display', () => {
  const six = (address, symbol) => token(address, symbol, 6);
  for (const tick of [800_000, -800_000]) {
    assert.deepEqual(marketPoolPrice(row({ tick, base: six(WETH, 'A'), quote: six(USDG, 'B') }), at(0)), { state: 'unavailable', problem: 'beyond_display', block: BLOCK }, `tick ${tick}`);
  }
});

test('a row without pool state has no price to show', () => {
  const { poolState, ...bare } = row();
  assert.ok(poolState);
  assert.deepEqual(marketPoolPrice(bare, at(0)), { state: 'unavailable', problem: 'not_read', block: null });
});

test('the price turns stale at exactly PRICE_STALE_MS on screen, counted on the monotonic clock when both readings have it', () => {
  assert.equal(PRICE_STALE_MS, 300_000);
  assert.equal(marketPoolPrice(row(), at(PRICE_STALE_MS - 1)).stale, false);
  assert.equal(marketPoolPrice(row(), at(PRICE_STALE_MS)).stale, true);
  // The wall clock stepped back an hour, the monotonic one did not: still five minutes on screen.
  assert.equal(marketPoolPrice(row(), { wall: RECEIVED.wall - 3_600_000, monotonic: RECEIVED.monotonic + PRICE_STALE_MS }).stale, true);
  // The wall clock jumped a day ahead: the monotonic clock says ten seconds.
  assert.equal(marketPoolPrice(row(), { wall: RECEIVED.wall + 86_400_000, monotonic: RECEIVED.monotonic + 10_000 }).stale, false);
  // A reply never stamped on the monotonic clock is aged on the wall clock.
  const wallOnly = row({ received: { wall: RECEIVED.wall } });
  assert.equal(marketPoolPrice(wallOnly, { wall: RECEIVED.wall + PRICE_STALE_MS - 1, monotonic: 1 }).stale, false);
  assert.equal(marketPoolPrice(wallOnly, { wall: RECEIVED.wall + PRICE_STALE_MS, monotonic: 1 }).stale, true);
});

test('a row retained after a failed refresh keeps the age of its own read', () => {
  const retained = retainAsStale({ source: 'live', chainId: 4663, network: 'Robinhood Chain', markets: [row()] }, RECEIVED.wall).markets[0];
  assert.equal(retained.tvlUsd.state, 'stale', 'its provider figures are marked stale');
  const minute = marketPoolPrice(retained, at(60_000));
  assert.deepEqual([minute.state, minute.text, minute.stale], ['usable', '≈2,492.18', false], 'kept, not aged by being kept');
  assert.equal(marketPoolPrice(retained, at(PRICE_STALE_MS + 1000)).stale, true, 'and stale once its own read is five minutes old');
});

test('a symbol that could not be read, or partial metadata, marks the price partial', () => {
  assert.equal(marketPoolPrice(row({ base: token(WETH, null, 18) }), at(0)).partial, true);
  assert.equal(marketPoolPrice(row({ quote: token(USDG, 'USDG', 6, 'partial') }), at(0)).partial, true);
  assert.equal(marketPoolPrice(row(), at(0)).partial, false);
});

// formatUsdPrice (lib/read/decimal.ts): the USD price the pool chart and the market cards write.
test('formatUsdPrice groups with commas and writes two places from one up, rounding half up on the string digits', () => {
  assert.equal(formatUsdPrice('2492.94'), '$2,492.94');
  assert.equal(formatUsdPrice('2492.9'), '$2,492.90');
  assert.equal(formatUsdPrice('2492'), '$2,492.00');
  assert.equal(formatUsdPrice('1'), '$1.00');
  assert.equal(formatUsdPrice('1.0003'), '$1.00');
  assert.equal(formatUsdPrice('105234.5678'), '$105,234.57');
  assert.equal(formatUsdPrice('2492.945'), '$2,492.95', 'half up');
  assert.equal(formatUsdPrice('2492.944999'), '$2,492.94');
  assert.equal(formatUsdPrice('999.995'), '$1,000.00', 'a carry regroups');
  assert.equal(formatUsdPrice('0002492.94'), '$2,492.94');
  assert.equal(
    formatUsdPrice('115792089237316195423570985008687907853269984665640564039457584007913129639935'),
    '$115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129,639,935.00',
    'no float ever holds the value',
  );
});

test('formatUsdPrice below one keeps up to six significant digits, never fewer than two places', () => {
  assert.equal(formatUsdPrice('0.0004123'), '$0.0004123');
  assert.equal(formatUsdPrice('0.000412345678'), '$0.000412346');
  assert.equal(formatUsdPrice('0.99985'), '$0.99985');
  assert.equal(formatUsdPrice('0.123456789'), '$0.123457');
  assert.equal(formatUsdPrice('0.5'), '$0.50');
  assert.equal(formatUsdPrice('0.500000'), '$0.50');
  assert.equal(formatUsdPrice('0.05'), '$0.05');
  assert.equal(formatUsdPrice('0.0500001'), '$0.0500001');
  assert.equal(formatUsdPrice('0.050000049'), '$0.05', 'the seventh significant digit rounds away');
  assert.equal(formatUsdPrice('0.9999995'), '$1.00', 'rounds up to one');
  assert.equal(formatUsdPrice('0.00000000000000000123'), '$0.00000000000000000123');
  assert.equal(formatUsdPrice('0'), '$0.00');
  assert.equal(formatUsdPrice('0.000'), '$0.00');
});

test('formatUsdPrice is null for anything but a non-negative decimal string', () => {
  for (const bad of ['', '-1', '-0.5', '1e6', '.5', '5.', ' 1', '1 ', '1,000.00', '$1', 'NaN', 'Infinity', '0x10', '+1']) {
    assert.equal(formatUsdPrice(bad), null, JSON.stringify(bad));
  }
});
