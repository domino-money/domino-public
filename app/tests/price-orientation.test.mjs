/**
 * One way round for every pool price in the app, and a range that takes one token alone (2026-09-28, one-sided).
 *
 * The owner: "UFG's price is falling, but the range on my UFG position is rising. It must be the opposite", and "if I
 * hold only MANY and want to sell it, I put the range above today's price; to buy MANY with USDG, below it. No swap."
 * The app writes every price "1 BASE = X QUOTE", USDG the quote wherever a pool holds it, then ETH, otherwise the
 * pool's own order (src/lib/read/orientation.ts). The chain is never read the other way round: ticks, square-root
 * prices, amounts and every contract call stay in the pool's order. Both kinds of pool are checked: USDG/MANY, where
 * USDG is currency0 and the page reads the pool the other way round, and WETH/USDG, which already read right.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const orientation = require('../.test-build/app/src/lib/read/orientation.js');
const poolRange = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const positions = require('../.test-build/app/src/lib/read/screens/positions.js');
const { priceInputToTick } = require('../.test-build/app/src/lib/read/screens/RangePriceInput.js');
const { awayFrom } = require('../.test-build/app/src/lib/create/plain.js');
const { pairedAmount, rangeTakesOnly } = require('../.test-build/app/src/lib/create/pairAmount.js');
const { mintPlanFor } = require('../.test-build/app/src/lib/create/mintPlan.js');
const { priceFromSqrt, priceFromSqrtIn } = require('../.test-build/app/src/lib/format/price.js');
const cards = require('../.test-build/app/src/lib/walletCards.js');
const { rangeView } = require('../.test-build/app/src/lib/automate/picker.js');

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ETH = '0x0000000000000000000000000000000000000000';
const MANY = '0xa26992c4268a8a78a4d872fe4bdad2ed03ac287d';
const UFG = '0xe1f3c5e4b3a0b5c7d8e9f0a1b2c3d4e5f6a7b8c9';
const token = (address, symbol, decimals) => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });

/** A pool option as New position and the pool page hold one, at `tick` exactly. */
const option = (currencies, tick, spacing = 60) => ({
  key: `0x${'a'.repeat(64)}`, currencies, tick, sqrtPriceX96: String(poolRange.sqrtPriceAtTick(tick)), tickSpacing: spacing, readAt: 0, block: 1, tokenMetadata: 'available',
});
// USDG (6 decimals) sorts before MANY (18): USDG is currency0. Tick 338460 is about 499 MANY per USDG, MANY about $0.002.
const USDG_MANY = option([token(USDG, 'USDG', 6), token(MANY, 'MANY', 18)], 338460);
// WETH (18) sorts before USDG (6): WETH is currency0, and the pool's own order already reads "1 WETH = 2,492 USDG".
const WETH_USDG = option([token(WETH, 'WETH', 18), token(USDG, 'USDG', 6)], -198120);
const number = (text) => Number(text.replace(/^≈/, '').replace(/,/g, ''));

test('the rule: USDG is the quote wherever a pool holds it, then ETH or WETH, otherwise the pool’s own order', () => {
  assert.deepEqual([USDG, WETH, ETH, MANY].map(orientation.quoteRank), [2, 1, 1, 0]);
  assert.equal(orientation.quoteRank(USDG.toUpperCase().replace('0X', '0x')), 2, 'an address in any case');
  const cases = [
    [[USDG, MANY], true, 'USDG/MANY: "1 MANY = 0.002 USDG"'],
    [[WETH, USDG], false, 'WETH/USDG: "1 WETH = 2,492 USDG", as it always read'],
    [[ETH, MANY], true, 'ETH/MANY: "1 MANY = x ETH"'],
    [[WETH, MANY], true, 'WETH/MANY: "1 MANY = x WETH"'],
    [[MANY, UFG], false, 'two ordinary tokens: the pool’s own order'],
    [[ETH, WETH], false, 'ETH and WETH: the same rank, the pool’s own order'],
    [[ETH, USDG], false, 'ETH/USDG: "1 ETH = 2,500 USDG"'],
  ];
  for (const [[c0, c1], inverted, why] of cases) {
    assert.equal(orientation.priceInverted(c0, c1), inverted, why);
    assert.equal(orientation.baseIndex(c0, c1), inverted ? 1 : 0, why);
    assert.equal(orientation.quoteIndex(c0, c1), inverted ? 0 : 1, why);
  }
});

test('a pool whose first token is USDG reads "1 MANY = 0.00200264 USDG", its tick and decimals still the pool’s own', () => {
  const price = poolRange.poolPrice(USDG_MANY, 0);
  assert.deepEqual([price.state, price.text, price.base.symbol, price.quote.symbol, price.inverted, price.tick, price.decimals], ['usable', '≈0.00200264', 'MANY', 'USDG', true, 338460, [6, 18]]);
  // The same tick read from the other side: 1 / (1.0001^tick × 10^(6 − 18)).
  assert.ok(Math.abs(number(price.text) - 1 / (Math.pow(1.0001, 338460) * 1e-12)) < 1e-8);
  // WETH/USDG is unchanged.
  const weth = poolRange.poolPrice(WETH_USDG, 0);
  assert.deepEqual([weth.text, weth.base.symbol, weth.quote.symbol, weth.inverted, weth.decimals], [positions.tickPriceText(-198120, 18, 6), 'WETH', 'USDG', false, [18, 6]]);
  assert.equal(poolRange.shownPrice(weth), weth, 'a pool read in its own order is its own frame');
});

test('in the page’s frame "above today" is always the priced token dearer, and a preset reads −30% and +50% whichever way the pool is', () => {
  for (const [pool, name] of [[USDG_MANY, 'USDG/MANY'], [WETH_USDG, 'WETH/USDG']]) {
    const price = poolRange.poolPrice(pool, 0);
    const shown = poolRange.shownPrice(price);
    const closer = poolRange.presetFor(price, 'standard');
    // The kept range is the pool's own ticks, on its spacing, holding its tick (v4: lower ≤ tick < upper).
    assert.equal(Math.abs(closer.lower % 60), 0, name);
    assert.equal(Math.abs(closer.upper % 60), 0, name);
    assert.equal(poolRange.rangePosition(closer, price.tick), 'inside', name);
    // Drawn in the page's frame: lowest price first, 30% under today's and 50% over it.
    const view = poolRange.shownRange(closer, price.inverted);
    assert.deepEqual([awayFrom(view.lower, shown.tick), awayFrom(view.upper, shown.tick)], [{ side: 'below', percent: '30%' }, { side: 'above', percent: '50%' }], name);
    const [low, now, high] = [poolRange.boundPrice(view.lower, shown), shown.text, poolRange.boundPrice(view.upper, shown)].map(number);
    assert.ok(low < now && now < high, `${name}: ${low} < ${now} < ${high}`);
    // The written price of a bound is the pool's own tick read the page's way.
    assert.equal(poolRange.boundPrice(view.lower, shown), poolRange.boundPrice(price.inverted ? closer.upper : closer.lower, price), name);
    // The frame is its own inverse: nothing is lost going back to the pool's ticks.
    assert.deepEqual(poolRange.shownRange(view, price.inverted), closer, name);
    assert.equal(poolRange.rangeMode(view, shown.tick, shown.tickSpacing), 'standard', `${name}: the kept preset reopens as Closer`);
  }
  // In its own order the preset is the plain one; the other way round it differs from the pool-order preset.
  assert.deepEqual(poolRange.presetFor(poolRange.poolPrice(WETH_USDG, 0), 'wide'), poolRange.presetRange(-198120, 60, 'wide'));
  assert.notDeepEqual(poolRange.presetFor(poolRange.poolPrice(USDG_MANY, 0), 'standard'), poolRange.presetRange(338460, 60, 'standard'));
});

/** A range typed as the page writes prices ("1 MANY = low to high USDG"), kept in the pool's ticks. */
function typedRange(pool, low, high) {
  const price = poolRange.poolPrice(pool, 0);
  const shown = poolRange.shownPrice(price);
  const start = poolRange.shownRange(poolRange.presetFor(price, 'wide'), price.inverted);
  const lower = priceInputToTick(low, 'lower', { lower: -887220, upper: start.upper }, shown);
  const upper = priceInputToTick(high, 'upper', { lower: lower.tick, upper: 887220 }, shown);
  assert.ok(lower.ok && upper.ok, `${low} to ${high}`);
  return { price, shown, range: poolRange.shownRange({ lower: lower.tick, upper: upper.tick }, price.inverted) };
}

test('to sell MANY the range goes above today’s price and takes MANY alone; to buy it, below, and takes USDG alone: no swap either way', () => {
  // Today 1 MANY = 0.0020 USDG. Sell: 0.0025 to 0.004. Buy: 0.001 to 0.0015.
  const sell = typedRange(USDG_MANY, '0.0025', '0.004');
  const buy = typedRange(USDG_MANY, '0.001', '0.0015');
  for (const { range } of [sell, buy]) assert.ok(range.lower < range.upper && Math.abs(range.lower % 60) === 0 && Math.abs(range.upper % 60) === 0, JSON.stringify(range));
  // The typed prices come back, rounded outward to the pool's spacing.
  const words = ({ range, price, shown }) => {
    const view = poolRange.shownRange(range, price.inverted);
    return [number(poolRange.boundPrice(view.lower, shown)), number(poolRange.boundPrice(view.upper, shown))];
  };
  const [sellLow, sellHigh] = words(sell);
  assert.ok(sellLow <= 0.0025 && sellLow > 0.0024 && sellHigh >= 0.004 && sellHigh < 0.00403, `${sellLow} to ${sellHigh}`);
  // Where today's price sits, the page's way: below the sell range, above the buy range.
  assert.equal(poolRange.shownPosition(sell.range, sell.price), 'below');
  assert.equal(poolRange.shownPosition(buy.range, buy.price), 'above');
  // Which token each takes, on the pool's own ticks and square-root price: MANY (currency1, the priced token) to sell,
  // USDG (currency0, the quote) to buy.
  const takes = ({ range }) => rangeTakesOnly({ sqrtPriceX96: USDG_MANY.sqrtPriceX96, tickLower: range.lower, tickUpper: range.upper });
  assert.equal(takes(sell), 1);
  assert.equal(takes(buy), 0);
  // The amounts: MANY alone for the sell range, USDG alone for the buy range, and a mint the setup contract takes as it is.
  const manyIn = pairedAmount({ sqrtPriceX96: USDG_MANY.sqrtPriceX96, tickLower: sell.range.lower, tickUpper: sell.range.upper, independent: 1, amountRaw: String(500_000n * 10n ** 18n) });
  assert.deepEqual(manyIn, { kind: 'amount', raw: '0', only: 1 });
  const sold = mintPlanFor({ sqrtPriceX96: USDG_MANY.sqrtPriceX96, tickLower: sell.range.lower, tickUpper: sell.range.upper, balance0: 0n, balance1: 500_000n * 10n ** 18n, slippageBps: 50 });
  assert.ok(sold && sold.liquidity > 0n && sold.maxAmount0 === 0n);
  const bought = mintPlanFor({ sqrtPriceX96: USDG_MANY.sqrtPriceX96, tickLower: buy.range.lower, tickUpper: buy.range.upper, balance0: 1_000n * 10n ** 6n, balance1: 0n, slippageBps: 50 });
  assert.ok(bought && bought.liquidity > 0n && bought.maxAmount1 === 0n);
  // The same on WETH/USDG, which already read right: above today takes WETH (currency0, the priced token), below USDG.
  const wethPrice = number(poolRange.poolPrice(WETH_USDG, 0).text);
  const up = typedRange(WETH_USDG, String(Math.round(wethPrice * 1.2)), String(Math.round(wethPrice * 1.6)));
  const down = typedRange(WETH_USDG, String(Math.round(wethPrice * 0.5)), String(Math.round(wethPrice * 0.8)));
  assert.equal(poolRange.shownPosition(up.range, up.price), 'below');
  assert.equal(rangeTakesOnly({ sqrtPriceX96: WETH_USDG.sqrtPriceX96, tickLower: up.range.lower, tickUpper: up.range.upper }), 0);
  assert.equal(poolRange.shownPosition(down.range, down.price), 'above');
  assert.equal(rangeTakesOnly({ sqrtPriceX96: WETH_USDG.sqrtPriceX96, tickLower: down.range.lower, tickUpper: down.range.upper }), 1);
});

test('a price as the page writes it is exact from the square-root price, and a falling token draws a falling line', () => {
  for (const [tick, d0, d1] of [[338460, 6, 18], [-198120, 18, 6], [0, 18, 18], [69082, 18, 18]]) {
    const sqrt = poolRange.sqrtPriceAtTick(tick);
    const forward = Number(priceFromSqrt(sqrt, d0, d1));
    const back = Number(priceFromSqrtIn(sqrt, d0, d1, true));
    assert.ok(Math.abs(forward * back - 1) < 1e-9, `tick ${tick}: ${forward} × ${back}`);
    assert.equal(priceFromSqrtIn(sqrt, d0, d1, false), priceFromSqrt(sqrt, d0, d1));
  }
  // USDG/UFG: UFG getting cheaper is more UFG per USDG, a higher pool tick; the page's price of UFG goes down with it.
  const hours = [300_000, 300_500, 301_000, 302_000].map((tick) => Number(priceFromSqrtIn(poolRange.sqrtPriceAtTick(tick), 6, 18, true)));
  for (let i = 1; i < hours.length; i++) assert.ok(hours[i] < hours[i - 1], `falls: ${hours}`);
  assert.throws(() => priceFromSqrtIn(0n, 6, 18, true), RangeError);
});

test('a position’s card reads the same way round: the lowest price of the priced token first, 0 and ∞ at the pool’s limits', () => {
  const position = (currencies, tickLower, tickUpper, tick) => cards.walletCard({
    tokenId: '7', status: 'open', poolId: `0x${'b'.repeat(64)}`, currencies, fee: 3000, tickSpacing: 60, hooks: ETH, tickLower, tickUpper, liquidity: '1',
    sqrtPriceX96: String(poolRange.sqrtPriceAtTick(tick)), tick, unclaimedFees: ['0', '0'], principal: ['0', '0'],
  }, `0x${'c'.repeat(40)}`);
  // USDG/UFG, a range of 250 to 500 UFG per USDG, today 400: the page writes 1 UFG = 0.002 to 0.004 USDG.
  const card = position([{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: UFG, symbol: 'UFG', decimals: 18 }], 331980, 338940, 336900);
  const shown = positions.shownCardRange(card);
  assert.deepEqual([shown.base.symbol, shown.quote.symbol, shown.inverted, shown.low.tick, shown.high.tick], ['UFG', 'USDG', true, 338940, 331980]);
  assert.deepEqual([shown.low.end, shown.high.end], [{ kind: 'price', text: positions.tickPriceText(-338940, 18, 6) }, { kind: 'price', text: positions.tickPriceText(-331980, 18, 6) }]);
  assert.ok(number(shown.low.end.text) < number(shown.high.end.text));
  assert.deepEqual(shown.ticks, { lower: -338940, upper: -331980 });
  const price = positions.chainPoolPrice(card, { sqrtPriceX96: String(poolRange.sqrtPriceAtTick(336900)), tick: 336900, block: 1 });
  assert.deepEqual([price.text, price.position, price.inverted, positions.shownCardTick(price)], [positions.tickPriceText(-336900, 18, 6), 'inside', true, -336900]);
  assert.ok(number(shown.low.end.text) < number(price.text) && number(price.text) < number(shown.high.end.text));
  // The pool's own ticks stay the card's: the chain's range is never turned round.
  assert.deepEqual([card.range.tickLower, card.range.tickUpper], [331980, 338940]);
  // A full-range position is 0 to ∞ either way round.
  const full = positions.shownCardRange(position([{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: UFG, symbol: 'UFG', decimals: 18 }], -887220, 887220, 0));
  assert.deepEqual([full.low.end, full.high.end], [{ kind: 'limit', text: '0' }, { kind: 'limit', text: '∞' }]);
  // WETH/USDG, read in its own order: the card's ends as they always were.
  const weth = position([{ address: WETH, symbol: 'WETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }], -201600, -195600, -198120);
  const wethShown = positions.shownCardRange(weth);
  assert.deepEqual([wethShown.base.symbol, wethShown.inverted, wethShown.low, wethShown.high], ['WETH', false, { end: weth.range.ends.lower, tick: -201600 }, { end: weth.range.ends.upper, tick: -195600 }]);
});

test('the automation picker’s mini bar puts the price’s dot the page’s way round', () => {
  const at = (currencies, tick) => rangeView({ tickLower: -600, tickUpper: 600, tick, currencies });
  const usdgFirst = [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: MANY, symbol: 'MANY', decimals: 18 }];
  const own = [{ address: MANY, symbol: 'MANY', decimals: 18 }, { address: UFG, symbol: 'UFG', decimals: 18 }];
  assert.deepEqual(at(own, -300), { lower: 0.25, upper: 0.75, current: 0.375, inRange: true });
  assert.deepEqual(at(usdgFirst, -300), { lower: 0.25, upper: 0.75, current: 0.625, inRange: true }, 'mirrored: MANY dearer is further right');
  assert.equal(at(usdgFirst, null).current, null);
});
