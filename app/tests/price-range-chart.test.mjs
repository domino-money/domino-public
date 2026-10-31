/**
 * The Price range chart's maths (src/lib/chart/priceRange.ts), from the owner's point 10 (2026-10-03: "The Price range
 * chart doesn't work. Tokens go from $0.001 to $1,000,000 and none of these charts work. Sometimes it sits way down at
 * the bottom, sometimes it doesn't show the history … no beginner will understand it"): every failure reproduced on
 * the chart as it stood (c3b41b8b, its axis copied below as `oldDomainOf`), and what the chart does now, for prices from
 * 10^-12 to 10^9, decimals 6/8/9/18 in both orders, the pool's limits, one-sided ranges, prices inside, under and over
 * the range, and closed positions.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CASES, OWNER, TOKENS, decimalText, historyFor, rangeCase } from './support/price-range-cases.mjs';

const require = createRequire(import.meta.url);
const chart = require('../.test-build/app/src/lib/chart/priceRange.js');
const { ledgerClosedAt, ledgerOpenedAt, ledgerOpenedBefore, activityOpenedAt, activityMint } = require('../.test-build/app/src/lib/chart/positionOpened.js');
const { SETUP_DEPLOY_BLOCK, SETUP_DEPLOYED_BY } = require('../.test-build/app/src/config/chainRobinhood.js');
const { spacedTimeTicks } = require('../.test-build/app/src/components/positions/visual/ticks.js');
const { walletCard } = require('../.test-build/app/src/lib/walletCards.js');
const { chainPoolPrice } = require('../.test-build/app/src/lib/read/screens/positions.js');
const { sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const { readablePrice, priceFigure, rangeFacts, statusWords, moveText, priceDomain, placeLabels, figureWidth, historyLine, EDGE_ROOM, MIN_SPAN } = chart;
const { symbolInText, SYMBOL_CHARS } = require('../.test-build/app/src/lib/chart/priceFacts.js');

test('closed NFT history stops at its confirmed final zero-liquidity interval; later pool trades never extend it', () => {
  const view = { phase: 'verified', state: { liquidity: 0n }, history: { events: [
    { liquidityDelta: 10n, timestamp: 100 }, { liquidityDelta: -10n, timestamp: 200 },
    { liquidityDelta: 20n, timestamp: 300 }, { liquidityDelta: -20n, timestamp: 400 },
  ] } };
  assert.equal(ledgerClosedAt(view), 400, 'a reopened NFT uses its later close');
  assert.equal(ledgerClosedAt({ ...view, state: { liquidity: 1n } }), null);
  assert.equal(ledgerClosedAt({ phase: 'unavailable' }), null, 'absence is not a close');
  const points = [100, 200, 300, 500].map(t => ({ t, price: t, exact: String(t), text: String(t), inRange: true }));
  const verdict = { kind: 'line', history: { start: 100, end: 600, points, runs: [points], stale: false, missing: false } };
  const clipped = chart.closedPriceLine(verdict, 400);
  assert.equal(clipped.history.end, 400);
  assert.deepEqual(clipped.history.points.map(p => p.t), [100, 200, 300]);
  assert.ok(clipped.history.runs.flat().every(p => p.t <= 400));
  assert.deepEqual(chart.closedPriceLine(verdict, 99), { kind: 'none', reason: 'no_position_history' });
});

/** The card and the page's price of a case, exactly as a position's page makes them (chainCardPrice's own read). */
function factsOf(item) {
  const position = item.spec.position;
  const sqrtPriceX96 = position.tick === null ? null : sqrtPriceAtTick(position.tick).toString();
  const card = walletCard({ ...position, sqrtPriceX96 }, OWNER);
  return { card, price: chainPoolPrice(card, { sqrtPriceX96, tick: position.tick, block: item.spec.block }), facts: rangeFacts(card, chainPoolPrice(card, { sqrtPriceX96, tick: position.tick, block: item.spec.block })) };
}

/** The chart's axis at c3b41b8b (PriceVsRange.tsx domainOf), and how its band landed in a 208 px plot: the failures, measured. */
function oldDomainOf(prices, lower, upper) {
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const open = [lower > 0 && !Number.isFinite(upper) ? lower * 1.25 : 0, upper > 0 && Number.isFinite(upper) && !(lower > 0) ? upper / 1.25 : 0];
  const ends = [lower, upper, ...open].filter((end) => end > 0 && Number.isFinite(end)).map((end) => Math.min(hi * 4, Math.max(lo / 4, end)));
  const floor = Math.min(lo, ...ends);
  const ceiling = Math.max(hi, ...ends);
  const span = Math.log(ceiling / floor) || 0.02;
  return [floor / Math.exp(span * 0.14), ceiling * Math.exp(span * 0.14)];
}
/** Where a price sits on a log axis, 0 at its foot and 1 at its top. */
const share = ([lo, hi], value) => (Math.log(value) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
/** The band's part of the plot, its edges held inside the plot as the chart drew them. */
function band(domain, lower, upper) {
  const top = Number.isFinite(upper) ? Math.min(1, Math.max(0, share(domain, upper))) : 1;
  const foot = lower > 0 ? Math.min(1, Math.max(0, share(domain, lower))) : 0;
  return { height: top - foot, topShown: Number.isFinite(upper) && share(domain, upper) <= 1 && share(domain, upper) >= 0, footShown: lower > 0 && share(domain, lower) >= 0 && share(domain, lower) <= 1 };
}

test('root cause (b): the old axis pinned a far range to one edge with no height, filled the plot with a wide one, and gave any range around the price 1/1.28 of it', () => {
  // A range ten times over the price, one far under it, a range a hundred times wide, and the owner's ETH/MANY position.
  const far = band(oldDomainOf([1], 10, 20), 10, 20);
  assert.equal(far.height, 0, 'a range far over the price had no height at all');
  assert.ok(!far.topShown && !far.footShown, 'and no number on either edge');
  assert.ok(share(oldDomainOf([1], 10, 20), 1) < 0.15, 'the price alone near the plot’s foot ("it sits way down at the bottom")');
  assert.equal(band(oldDomainOf([1], 0.05, 0.1), 0.05, 0.1).height, 0, 'and under it, the same');
  const wide = band(oldDomainOf([1], 0.01, 100), 0.01, 100);
  assert.equal(wide.height, 1, 'a wide range filled the plot edge to edge');
  assert.ok(!wide.topShown && !wide.footShown, 'with no number at all');
  const owner = band(oldDomainOf([7.10148e-7], 3.66503e-7, 7.99485e-7), 3.66503e-7, 7.99485e-7);
  assert.ok(Math.abs(owner.height - 1 / 1.28) < 1e-9, `the owner's closed ETH/MANY band took ${owner.height} of the plot`);
});

test('the axis now holds the whole band, the whole line and the price now, with room above and below, at any price', () => {
  const room = 1 / (1 + 2 * EDGE_ROOM);
  for (const scale of [1e-12, 1e-7, 0.0025, 1, 120_345, 2.5e9]) {
    for (const [lower, upper, now] of [[0.7, 1.5, 1], [10, 20, 1], [0.05, 0.1, 1], [0.01, 100, 1], [0.9995, 1.0005, 1.0001], [0.99999, 1.00001, 1]]) {
      const [lo, hi, at] = [lower * scale, upper * scale, now * scale];
      const line = [0.97, 1.02, 1.05, 0.95].map((move) => at * move);
      const domain = priceDomain(lo, hi, [at, ...line]);
      const what = `${lo}..${hi} at ${at}`;
      assert.ok(domain.every((end) => end > 0 && Number.isFinite(end)), `a usable axis for ${what}`);
      for (const value of [lo, hi, at, ...line]) {
        const where = share(domain, value);
        assert.ok(where > 0.05 && where < 0.95, `${value} away from the plot's edges (${where}) for ${what}`);
      }
      const drawn = band(domain, lo, hi);
      assert.ok(drawn.topShown && drawn.footShown, `both edges of ${what} are on the plot`);
      assert.ok(drawn.height <= room + 1e-9, `the band never fills the plot: ${drawn.height} for ${what}`);
      assert.ok(drawn.height > 0, `and always has a height: ${what}`);
    }
  }
});

test('an end at 0 or ∞ is no place on the axis: the band runs off that edge, and the price and the line still have room', () => {
  for (const [lower, upper] of [[0, Infinity], [0, 0.004], [0.0018, Infinity]]) {
    const prices = [0.0025, 0.0024, 0.0027];
    const domain = priceDomain(lower, upper, prices);
    for (const price of prices) assert.ok(share(domain, price) > 0.05 && share(domain, price) < 0.95);
    if (lower > 0) assert.ok(share(domain, lower) > 0.05, 'a price end is on the plot');
    if (Number.isFinite(upper)) assert.ok(share(domain, upper) < 0.95, 'a price end is on the plot');
  }
  // A flat line in a full range: the narrowest window, the price in the middle.
  const flat = priceDomain(0, Infinity, [5, 5, 5]);
  assert.ok(Math.abs(Math.log(flat[1] / flat[0]) - MIN_SPAN * (1 + 2 * EDGE_ROOM)) < 1e-12);
  assert.ok(Math.abs(share(flat, 5) - 0.5) < 1e-9);
  assert.deepEqual(priceDomain(0, Infinity, []), [1 / 1.1, 1.1], 'nothing to draw still gives an axis');
});

test('root cause (a): the chart is drawn for every price the page can write, decimals 6/8/9/18 either way round, ticks at the pool’s limits', () => {
  const tokens = [
    { address: '0x1000000000000000000000000000000000000001', symbol: 'SIX', decimals: 6 },
    { address: '0x2000000000000000000000000000000000000002', symbol: 'EIGHT', decimals: 8 },
    { address: '0x3000000000000000000000000000000000000003', symbol: 'NINE', decimals: 9 },
    { address: '0x4000000000000000000000000000000000000004', symbol: 'EIGHTEEN', decimals: 18 },
  ];
  const quotes = [TOKENS.USDG, TOKENS.ETH, ...tokens];
  let id = 1;
  for (const base of tokens) {
    for (const quote of quotes) {
      if (base === quote || (quote !== TOKENS.USDG && quote !== TOKENS.ETH && base.address > quote.address)) continue;
      for (const now of [1e-12, 3.2e-9, 7.1e-7, 0.0025, 1, 120_345, 2.5e9]) {
        for (const [low, high, where] of [[now * 0.7, now * 1.5, 'inside'], [now * 2, now * 3, 'under'], [now / 3, now / 2, 'over'], [0, Infinity, 'inside'], [0, now * 2, 'inside'], [now / 2, Infinity, 'inside']]) {
          const item = rangeCase({ id: id++, base, quote, low, high, now, spacing: 10 });
          const { price, facts } = factsOf(item);
          const what = `${base.symbol}/${quote.symbol} at ${now}, ${low}..${high}`;
          assert.equal(price.state, 'usable', what);
          assert.ok(facts, `a chart for ${what}`);
          assert.equal(facts.where, where, what);
          assert.ok(Math.abs(facts.now / now - 1) < 0.001, `the price now as written: ${facts.now} for ${what}`);
          assert.ok(facts.lower === 0 ? low === 0 : Math.abs(facts.lower / low - 1) < 0.01, `its low end ${facts.lower} for ${what}`);
          assert.ok(facts.upper === Infinity ? high === Infinity : Math.abs(facts.upper / high - 1) < 0.01, `its high end ${facts.upper} for ${what}`);
          assert.equal(facts.lowerText, low === 0 ? '0' : facts.lowerText);
          assert.equal(facts.upperText, high === Infinity ? '∞' : facts.upperText);
          assert.doesNotMatch(`${facts.nowText} ${facts.lowerText} ${facts.upperText}`, /e[+-]?\d|NaN|Infinity/, `plain figures for ${what}`);
          const domain = priceDomain(facts.lower, facts.upper, [facts.now]);
          assert.ok(share(domain, facts.now) > 0.05 && share(domain, facts.now) < 0.95, `the price now on the plot for ${what}`);
        }
      }
    }
  }
});

test('the chart stands aside only where the page cannot write the price: a decimal unread, or beyond 10^±24 (the bar and its ends stand in)', () => {
  const item = CASES.inside;
  const unread = { ...item.spec.position, currencies: [item.spec.position.currencies[0], { ...item.spec.position.currencies[1], decimals: null }] };
  const sqrt = sqrtPriceAtTick(unread.tick).toString();
  const card = walletCard({ ...unread, sqrtPriceX96: sqrt }, OWNER);
  const price = chainPoolPrice(card, { sqrtPriceX96: sqrt, tick: unread.tick, block: 1 });
  assert.equal(price.state, 'unavailable');
  assert.equal(rangeFacts(card, price), null);
  // A price of 10^30: 1.0001^tick × 10^(d0 − d1) far past what the page writes as a plain number.
  const beyond = rangeCase({ id: 9, base: { address: '0x1000000000000000000000000000000000000001', symbol: 'A', decimals: 18 }, quote: { address: '0x2000000000000000000000000000000000000002', symbol: 'B', decimals: 18 }, low: 1e29, high: 1e31, now: 1e30, spacing: 10 });
  const { price: far, facts } = factsOf(beyond);
  assert.equal(far.state, 'unavailable');
  assert.equal(far.problem, 'beyond_display');
  assert.equal(facts, null);
  assert.equal(rangeFacts(card, null), null, 'no price, no chart');
});

test('the owner’s closed ETH/MANY position: MANY’s price in ETH, closed, inside where its range was', () => {
  const { facts } = factsOf(CASES.closed);
  assert.equal(facts.where, 'closed');
  assert.equal(facts.base.symbol, 'MANY');
  assert.equal(facts.quote.symbol, 'ETH');
  assert.equal(readablePrice(facts.nowText), '0.0₆710148');
  assert.match(readablePrice(facts.lowerText), /^0\.0₆36\d+$/);
  assert.match(readablePrice(facts.upperText), /^0\.0₆79\d+$/);
  assert.deepEqual(statusWords(facts), { tone: 'closed', title: 'Closed', detail: 'this position no longer earns fees', move: null });
});

test('readablePrice: tiny prices count their zeros in a subscript, huge ones in billions, trillions or a power of ten, the rest as the page writes them', () => {
  assert.equal(readablePrice('0.000000710148'), '0.0₆710148');
  assert.equal(readablePrice('≈0.000000710148'), '0.0₆710148', 'its "≈" dropped, as the key figures drop it');
  assert.equal(readablePrice('0.0000123'), '0.0₄123', 'from four zeros');
  assert.equal(readablePrice('0.000123'), '0.000123', 'three zeros stay as they are');
  assert.equal(readablePrice('0.0000000000032003'), '0.0₁₁32003');
  assert.equal(readablePrice('0.00252025'), '0.00252025');
  assert.equal(readablePrice('350.55'), '350.55');
  assert.equal(readablePrice('120,345'), '120,345');
  assert.equal(readablePrice('999,999,000'), '999,999,000');
  assert.equal(readablePrice('2,500,000,000'), '2.5B');
  assert.equal(readablePrice('2,499,940,000'), '2.49994B');
  assert.equal(readablePrice('123,457,000,000'), '123.457B');
  assert.equal(readablePrice('12,345,700,000,000'), '12.3457T');
  assert.equal(readablePrice('1,000,000,000,000,000,000'), '1 × 10¹⁸');
  assert.equal(readablePrice('1,234,570,000,000,000,000,000'), '1.23457 × 10²¹');
  for (const kept of ['0', '∞', 'Tick 4', '1', '0.5']) assert.equal(readablePrice(kept), kept);
  assert.equal(priceFigure(7.10148e-7), '0.0₆710148');
  assert.equal(priceFigure(0.00252025123), '0.00252025');
  assert.equal(priceFigure(2.5e9), '2.5B');
  assert.equal(priceFigure(0), '—');
  assert.equal(priceFigure(Number.NaN), '—');
  assert.ok(figureWidth('0.0₆710148') < figureWidth('0.000000710148'), 'shorter on the plot too');
});

test('the status says in plain words where the price is, and how far it must move to come back', () => {
  const at = (where, lower, upper, now = 1) => statusWords({ where, lower, upper, now });
  assert.deepEqual(at('inside', 0.5, 2), { tone: 'in', title: 'Earning fees', detail: 'the price is inside your range', move: null });
  assert.deepEqual(at('under', 1.25, 2), { tone: 'out', title: 'Not earning', detail: 'the price is below your range', move: 'It must rise 25% to come back into your range.' });
  assert.deepEqual(at('over', 0.5, 0.8), { tone: 'out', title: 'Not earning', detail: 'the price is above your range', move: 'It must fall 20% to come back into your range.' });
  assert.equal(at('over', 0.00001, 0.00002).move, 'It must fall more than 99% to come back into your range.');
  assert.equal(at('under', 15, 20).move, 'It must rise 1,400% to come back into your range.');
  assert.equal(at('under', 1.042, 2).move, 'It must rise 4.2% to come back into your range.');
  assert.equal(at('under', 1.002, 2).move, 'It must rise less than 1% to come back into your range.');
  assert.equal(moveText(0.6), '60%');
  assert.equal(moveText(0), 'less than 1%');

  // Changed on purpose 2026-10-30 (QA round 2, N68, the owner's decision): in range and within 10% of an end, what
  // happens past that end, with the end as the key figures write it and the token the position then holds. The ends
  // are named as Auto-exit names them (Lower end, Upper end), and the symbol is isolated as TokenLabel's <bdi> isolates
  // it (U+2068 … U+2069) and cut at its 14 characters.
  const near = (lower, upper, now, { lowerText = String(lower), upperText = String(upper), base = 'ETH', quote = 'USDG' } = {}) =>
    statusWords({ where: 'inside', lower, upper, now, lowerText, upperText, base: { symbol: base }, quote: { symbol: quote } });
  const iso = (symbol) => `\u2068${symbol}\u2069`;
  assert.deepEqual(near(100, 200, 105), { tone: 'in', title: 'Earning fees', detail: 'the price is inside your range', move: `Near the lower end: below 100, it stops earning and becomes all ${iso('ETH')}.` });
  assert.equal(near(100, 200, 190).move, `Near the upper end: above 200, it stops earning and becomes all ${iso('USDG')}.`);
  assert.equal(near(100, 200, 150).move, null, 'away from both ends');
  assert.equal(near(100, 200, 111).move, null, 'more than 10% above the lower end');
  assert.equal(near(0, 200, 5, { lowerText: '0' }).move, null, 'the lower end at the pool’s limit says nothing');
  assert.equal(near(0, 200, 190, { lowerText: '0' }).move, `Near the upper end: above 200, it stops earning and becomes all ${iso('USDG')}.`);
  assert.equal(near(100, Infinity, 105, { upperText: '∞' }).move, `Near the lower end: below 100, it stops earning and becomes all ${iso('ETH')}.`);
  assert.equal(near(100, 200, 105, { lowerText: null }).move, null, 'an end written as its tick');
  assert.equal(near(100, 200, 190, { quote: null }).move, null, 'a token with no symbol');
  assert.equal(near(3.66503e-7, 7.99485e-7, 3.7e-7, { lowerText: '0.000000366503', base: 'MANY' }).move, `Near the lower end: below 0.0₆366503, it stops earning and becomes all ${iso('MANY')}.`, 'the end as the key figures write it');
  // A long symbol cut as TokenLabel cuts it on screen; a right-to-left one isolated; one with a format character not said.
  assert.equal(SYMBOL_CHARS, 14);
  assert.equal(near(100, 200, 105, { base: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }).move, `Near the lower end: below 100, it stops earning and becomes all ${iso('ABCDEFGHIJKLM…')}.`);
  assert.equal(near(100, 200, 105, { base: 'ABCDEFGHIJKLMN' }).move, `Near the lower end: below 100, it stops earning and becomes all ${iso('ABCDEFGHIJKLMN')}.`, '14 characters kept whole');
  assert.equal(near(100, 200, 105, { base: 'שקל' }).move, `Near the lower end: below 100, it stops earning and becomes all ${iso('שקל')}.`);
  assert.equal(near(100, 200, 105, { base: 'ETH\u202e' }).move, null, 'a right-to-left override in the symbol');
  assert.equal(near(100, 200, 190, { quote: 'US\u2069DG' }).move, null, 'an isolate’s end in the symbol');
  assert.equal(symbolInText(null), null);
  assert.equal(symbolInText(''), null);
  assert.equal(symbolInText('🦄'.repeat(20)), iso(`${'🦄'.repeat(13)}…`), 'cut by character, never inside one');
  // The owner’s narrow stable range, near both ends: the lower end is said.
  const { facts: narrow } = factsOf(CASES.narrow);
  assert.equal(narrow.where, 'inside');
  assert.match(statusWords(narrow).move, new RegExp(`^Near the lower end: below ${readablePrice(narrow.lowerText).replaceAll('.', '[.]')}, it stops earning and becomes all \u2068${narrow.base.symbol}\u2069[.]$`));
  assert.equal(statusWords(factsOf(CASES.huge).facts).move, null, 'WBTC 20% from its ends');
});

test('the labels at the plot’s right never overlap, keep their order and the price now’s place, and stay inside', () => {
  const asks = (max, now, min) => [{ key: 'max', at: max, size: 30 }, { key: 'now', at: now, size: 36, fixed: true }, { key: 'min', at: min, size: 30 }];
  const check = (placed, list, from, to) => {
    const order = list.map((ask) => placed[ask.key]);
    for (let index = 1; index < list.length; index += 1) {
      assert.ok(order[index] - order[index - 1] >= (list[index].size + list[index - 1].size) / 2 + 2 - 1e-9, `${list[index - 1].key} and ${list[index].key} apart: ${JSON.stringify(placed)}`);
    }
    list.forEach((ask) => assert.ok(placed[ask.key] - ask.size / 2 >= from - 1e-9 && placed[ask.key] + ask.size / 2 <= to + 1e-9, `${ask.key} inside: ${JSON.stringify(placed)}`));
  };
  // Room enough: everything where it is.
  assert.deepEqual(placeLabels(asks(40, 100, 160), 0, 220), { max: 40, now: 100, min: 160 });
  // The price just under the top end: the Max label steps up, the chip stays.
  const tight = placeLabels(asks(90, 100, 160), 0, 220);
  assert.equal(tight.now, 100);
  check(tight, asks(90, 100, 160), 0, 220);
  // A thin band far from the price (far over): Max and Min step apart, the chip where it is.
  const thin = [{ key: 'now', at: 40, size: 36, fixed: true }, { key: 'max', at: 180, size: 30 }, { key: 'min', at: 186, size: 30 }];
  const apart = placeLabels(thin, 0, 220);
  assert.equal(apart.now, 40);
  check(apart, thin, 0, 220);
  // Squeezed at the foot: everything stays inside, in order.
  const foot = placeLabels(asks(200, 210, 215), 0, 220);
  check(foot, asks(200, 210, 215), 0, 220);
  // At the very top.
  const top = placeLabels(asks(0, 2, 5), 0, 220);
  check(top, asks(0, 2, 5), 0, 220);
  assert.deepEqual(placeLabels([], 0, 10), {});
});

const HOUR = 3_600;
const END = 1_790_000_000 - (1_790_000_000 % HOUR) + 1_200;
const BODY = (item) => ({ poolId: item.poolId, currency: item.base.address, windowSeconds: 604_800, resolutionSeconds: HOUR });
const range = (facts) => ({ lower: facts.lower, upper: facts.upper });

test('first-hour history starts at the measured creation-block price, including when hourly history has not arrived', () => {
  const item = CASES.inside;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END });
  const mint = END - 900;
  const observations = {
    poolId: item.poolId, currencies: [item.pool.currency0, item.pool.currency1],
    opened: { t: mint, sqrtPriceX96: item.spec.position.sqrtPriceX96 },
    current: { t: END + 20, sqrtPriceX96: item.spec.position.sqrtPriceX96 },
  };
  const ask = { poolId: item.poolId, base: item.base.address, quote: item.quote.address };
  const stored = historyLine(data, ask, range(facts), END, mint);
  assert.equal(stored.history.points.length, 1, 'hourly closes alone produced the screenshot’s lone point');
  const result = chart.observedPriceLine(stored, data, ask, range(facts), mint, observations).history;
  assert.equal(result.points[0].t, mint);
  assert.equal(result.points.at(-1).t, END + 20);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0][0].t, mint);
  assert.ok(Math.abs(result.points[0].price / facts.now - 1) < 0.0002, 'chain order and decimals match the displayed orientation');
  assert.ok(result.runs[0].length >= 2, 'an actual line, not two isolated right-edge dots');
  assert.equal(result.observed, true);
  const fallback = chart.observedPriceLine(null, null, ask, range(facts), mint, observations).history;
  assert.deepEqual(fallback.points.map(p => p.t), [mint, END + 20]);
  assert.equal(fallback.runs.length, 1);
  assert.equal(chart.observedPriceLine(stored, data, ask, range(facts), mint, null), stored, 'missing archive result does not invent an anchor');
  assert.equal(chart.observedPriceLine(stored, data, { ...ask, poolId: 'other' }, range(facts), mint, observations), stored);
  assert.equal(chart.observedPriceLine(stored, data, ask, range(facts), mint + 1, observations), stored);
});

test('observed prices preserve missing intervals and validate decimals, orientation and uint160', () => {
  const currencies = [{ address: 'a', decimals: 18 }, { address: 'b', decimals: 6 }];
  const sqrt = (2n ** 96n).toString();
  const observed = { poolId: 'pool', currencies, opened: { t: END - 900, sqrtPriceX96: sqrt }, current: { t: END, sqrtPriceX96: sqrt } };
  const run = (patch = {}, ask = { poolId: 'pool', base: 'a', quote: 'b' }) => chart.observedPriceLine(null, null, ask, { lower: 0, upper: Infinity }, observed.opened.t, { ...observed, ...patch });
  assert.equal(run().history.points[0].price, 1e12);
  assert.equal(run({}, { poolId: 'pool', base: 'b', quote: 'a' }).history.points[0].price, 1e-12);
  assert.equal(run({ currencies: [{ ...currencies[0], decimals: null }, currencies[1]] }), null);
  for (const invalid of ['0', '-1', 'not-a-price', (1n << 160n).toString()]) assert.equal(run({ opened: { ...observed.opened, sqrtPriceX96: invalid } }), null);
  const gap = run({ current: { t: END + 7200, sqrtPriceX96: sqrt } }).history;
  assert.deepEqual(gap.runs.map(r => r.length), [1, 1], 'two snapshots cannot invent hours of missing history');
  assert.equal(gap.missing, true);
});

test('root cause (c): the line is the pool’s stored hourly closes (read-v3 history), in the page’s orientation, never altered', () => {
  const item = CASES.inside;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END });
  const verdict = historyLine(data, { base: item.base.address, quote: item.quote.address }, range(facts), END + 30);
  assert.equal(verdict.kind, 'line');
  const { history } = verdict;
  assert.equal(history.points.length, data.candles.length, 'one point per hourly close');
  history.points.forEach((point, index) => {
    const candle = data.candles[index];
    assert.equal(point.price, Number(candle.close), 'the close as stored');
    assert.equal(point.t, Math.min(candle.startTimestamp + HOUR, END), 'at the end of its hour');
    assert.equal(point.inRange, point.price >= facts.lower && point.price < facts.upper);
  });
  assert.equal(history.runs.length, 1, 'every hour collected: one line');
  assert.equal(history.points.at(-1).price, Number(data.candles.at(-1).close), 'the line ends at its own last close, not at the page’s price now');
  assert.equal(history.start, data.requestedWindow.startTimestamp);
  assert.equal(history.end, END + 30, 'to the page’s clock');
  assert.equal(history.missing, false);
  assert.equal(history.stale, false);
});

test('an hour with no trade keeps the last close (a flat step, never a slope), and an hour not collected breaks the line', () => {
  const item = CASES.tiny;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END, quiet: 0.6, gap: [60, 40] });
  assert.equal(data.status, 'partial');
  const verdict = historyLine(data, { base: item.base.address, quote: item.quote.address }, range(facts), END);
  assert.equal(verdict.kind, 'line');
  const { history } = verdict;
  assert.equal(history.missing, true);
  const gap = data.gaps[0];
  assert.ok(history.runs.length >= 2, 'the line breaks at the hours not collected');
  for (const run of history.runs) {
    for (const point of run) assert.ok(point.t <= gap.startTimestamp || point.t >= gap.endTimestamp, `nothing drawn inside the gap: ${point.t}`);
    for (let index = 1; index < run.length; index += 1) {
      const [a, b] = [run[index - 1], run[index]];
      // A move happens only within an hour that traded; any longer stretch is flat.
      if (b.t - a.t > HOUR) assert.equal(b.price, a.price, `flat across quiet hours: ${a.t}→${b.t}`);
    }
  }
  const closes = new Set(data.candles.map((candle) => Number(candle.close)));
  for (const point of history.runs.flat()) assert.ok(closes.has(point.price), 'every price drawn is one of the closes');
});

test('the history is used only for the page’s pair and orientation, and says why when there is no line', () => {
  const item = CASES.inside;
  const { facts } = factsOf(item);
  const ask = { base: item.base.address, quote: item.quote.address };
  const data = historyFor(item, BODY(item), { end: END });
  assert.deepEqual(historyLine({ ...data, currency: item.quote.address, quoteCurrency: item.base.address }, ask, range(facts), END), { kind: 'none', reason: 'mismatch' });
  assert.deepEqual(historyLine({ ...data, quoteCurrency: '0x9999999999999999999999999999999999999999' }, ask, range(facts), END), { kind: 'none', reason: 'mismatch' });
  assert.deepEqual(historyLine({ ...data, status: 'not_built', candles: [], covered: [], snapshot: null }, ask, range(facts), END), { kind: 'none', reason: 'not_built' });
  assert.deepEqual(historyLine({ ...data, status: 'unavailable', candles: [] }, ask, range(facts), END), { kind: 'none', reason: 'unavailable' });
  assert.deepEqual(historyLine({ ...data, candles: [] }, ask, range(facts), END), { kind: 'none', reason: 'no_trades' });
  // A stale snapshot is said, and the window reaches the page's clock (a day at the most).
  const stale = historyLine(data, ask, range(facts), END + 600);
  assert.equal(stale.history.stale, true);
  assert.equal(stale.history.end, END + 600);
  assert.equal(historyLine(data, ask, range(facts), END + 10 * 86_400).history.end, END + 86_400);
});

test('stretches the service collected that touch are one stretch, and the last close holds to the end of what was collected', () => {
  const item = CASES.huge;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END });
  const middle = data.requestedWindow.startTimestamp + 50 * HOUR;
  const split = { ...data, covered: [{ startTimestamp: data.requestedWindow.startTimestamp, endTimestamp: middle }, { startTimestamp: middle, endTimestamp: END }] };
  const verdict = historyLine(split, { base: item.base.address, quote: item.quote.address }, range(facts), END);
  assert.equal(verdict.history.runs.length, 1);
  // Only an hour long ago traded, and every hour since was collected: its close holds, flat, to the end.
  const lone = { ...data, candles: [data.candles[3]] };
  const held = historyLine(lone, { base: item.base.address, quote: item.quote.address }, range(facts), END).history;
  assert.equal(held.runs.length, 1);
  assert.deepEqual(held.runs[0].map((point) => point.t), [data.candles[3].startTimestamp + HOUR, END]);
  assert.equal(held.runs[0][1].price, held.runs[0][0].price);
});

test('closes as the read service writes them (no exponent) are read exactly for tiny and huge prices', () => {
  assert.equal(decimalText(7.10148e-7), '0.000000710148');
  assert.equal(decimalText(3.2e-12), '0.0000000000032');
  assert.equal(decimalText(2.5e9), '2500000000');
  for (const name of ['micro', 'giant', 'narrow']) {
    const item = CASES[name];
    const { facts } = factsOf(item);
    const verdict = historyLine(historyFor(item, BODY(item), { end: END }), { base: item.base.address, quote: item.quote.address }, range(facts), END);
    assert.equal(verdict.kind, 'line', name);
    for (const point of verdict.history.points) assert.doesNotMatch(point.text, /e[+-]?\d|NaN/, `${name}: ${point.text}`);
  }
});

test('a new NFT never borrows pre-mint pool history, even the carried close of a quiet hour', () => {
  const item = CASES.inside;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END, quiet: 0.6, gap: [70, 40] });
  const minted = END - 6 * HOUR + 537;
  const result = historyLine(data, { base: item.base.address, quote: item.quote.address }, range(facts), END, minted);
  assert.equal(result.kind, 'line');
  const line = result.history;
  assert.equal(line.start, minted);
  assert.ok(line.points.length < data.candles.length);
  assert.ok(line.points.every((point) => point.t >= minted));
  assert.ok(line.runs.flat().every((point) => point.t >= line.points[0].t), 'no borrowed pre-mint close and no estimated mint price');
  assert.equal(line.missing, false, 'a gap before mint does not belong to this position');
  const expected = data.candles.filter((candle) => Math.min(candle.startTimestamp + HOUR, END) >= minted).map((candle) => Number(candle.close));
  assert.deepEqual(line.points.map((point) => point.price), expected, 'kept prices are unchanged');
});

test('time labels keep space after the right-edge alignment: Opened and the latest time survive on a narrow plot', () => {
  const narrow = [{ x: 0, label: 'Opened' }, { x: 95, label: '18:00' }, { x: 143, label: '20:00' }];
  assert.deepEqual(spacedTimeTicks(narrow, 0, 148), [narrow[0], narrow[2]], '18:00 must not collide with the end-aligned 20:00');
  const wide = [{ x: 0, label: 'Opened' }, { x: 100, label: '18:00' }, { x: 230, label: '20:00' }];
  assert.deepEqual(spacedTimeTicks(wide, 0, 240), wide);
  assert.deepEqual(spacedTimeTicks([narrow[0]], 0, 148), [narrow[0]]);
  assert.deepEqual(spacedTimeTicks([], 0, 148), []);
});

test('time labels reserve the desktop 16px face before keeping a tick near Opened', () => {
  const ticks = [{ x: 0, label: 'Opened' }, { x: 84.6, label: '17:00' }, { x: 200, label: '18:00' }, { x: 400, label: '19:00' }];
  assert.deepEqual(spacedTimeTicks(ticks, 0, 440, 12), ticks, 'the compact face has enough room');
  assert.deepEqual(spacedTimeTicks(ticks, 0, 440, 16), [ticks[0], ticks[2], ticks[3]], 'the larger face needs the first hourly label omitted, not squeezed against Opened');
});

test('an unknown mint, or a mint newer than stored prices, never produces a position-history line', () => {
  const item = CASES.inside;
  const { facts } = factsOf(item);
  const data = historyFor(item, BODY(item), { end: END });
  const run = (mint) => historyLine(data, { base: item.base.address, quote: item.quote.address }, range(facts), END, mint);
  for (const mint of [null, 0, NaN, -1, 1.5]) assert.deepEqual(run(mint), { kind: 'none', reason: 'unknown_mint' });
  assert.deepEqual(run(END + 1), { kind: 'none', reason: 'no_position_history' });
  assert.equal(run(END - 30 * 86400).history.start, data.requestedWindow.startTimestamp, 'an older NFT still shows only the stored seven-day window');
});

test('the V1 opening time is the ledger mint, including a ledger with inexact settlements; never the current read or first visible event', () => {
  assert.equal(ledgerOpenedAt({ phase: 'verified', history: { mintedAt: { timestamp: END } } }), END);
  assert.equal(ledgerOpenedAt({ phase: 'cached', history: { mintedAt: { timestamp: END } } }), END);
  assert.equal(ledgerOpenedAt({ phase: 'unclaimed-only', mintedAt: { block: 80000000, timestamp: END }, events: [] }), END, 'an inexact fees verdict does not discard the verified mint');
  assert.equal(ledgerOpenedAt({ phase: 'loading', mintedAt: { block: 80000000, timestamp: END } }), END, 'the price chart can start while financial history continues');
  assert.equal(ledgerOpenedAt({ phase: 'unclaimed-only', events: [{ kind: 'increase', timestamp: END + 1 }, { kind: 'mint', timestamp: END }] }), END);
  assert.equal(ledgerOpenedAt({ phase: 'unclaimed-only', state: { timestamp: END }, events: [{ kind: 'increase', timestamp: END }] }), null);
  for (const phase of ['idle', 'loading', 'unavailable']) assert.equal(ledgerOpenedAt({ phase, state: { timestamp: END } }), null);
});

// (2026-10-15, pack 7): every close is an owner's withdrawal ('manual'), so the ledger's view of a closed NFT is never
// exact and the chart waited on its closing history forever. A complete inexact ledger ('manual', 'native', 'shared':
// the scan reached the head and found the mint) still dates the close from the NFT's own settlements.
test('a closed NFT whose ledger is complete but inexact (manual, native, shared) is dated by its own settlements; never one that cannot be', () => {
  const events = [
    { kind: 'mint', liquidityDelta: 10n, timestamp: 100, fees: [0n, 0n] },
    { kind: 'collect', liquidityDelta: 0n, timestamp: 150, fees: [1n, 2n] },
    { kind: 'decrease', liquidityDelta: -4n, timestamp: 200, fees: null },
    { kind: 'close', liquidityDelta: -6n, timestamp: 300, fees: null },
  ];
  const view = (why, more = {}) => ({ phase: 'unclaimed-only', state: { liquidity: 0n }, reason: 'not_exact', why, events, ...more });
  for (const why of ['manual', 'native', 'shared']) assert.equal(ledgerClosedAt(view(why)), 300, `${why}: the close's own block time`);
  for (const why of ['liquidity', 'unseen', 'before_floor', 'too_many', 'reading', undefined]) assert.equal(ledgerClosedAt(view(why)), null, `${why}: never a close`);
  assert.equal(ledgerClosedAt(view('manual', { state: { liquidity: 1n } })), null, 'liquidity left now is not closed');
  assert.equal(ledgerClosedAt(view('manual', { events: events.slice(1) })), null, 'no mint in the events: no close');
  assert.equal(ledgerClosedAt(view('manual', { events: events.slice(0, 3) })), null, 'the deltas must sum to the state’s zero');
  assert.equal(ledgerClosedAt(view('manual', { events: [events[0], { ...events[3], liquidityDelta: -11n }, { kind: 'increase', liquidityDelta: 1n, timestamp: 400 }] })), null, 'never negative');
  assert.equal(ledgerClosedAt(view('manual', { events: undefined })), null, 'no events: no close');
  assert.equal(ledgerClosedAt({ phase: 'unclaimed-only', state: { liquidity: 0n }, reason: 'rpc_unavailable', events }), null, 'a read that failed is no ledger');
  assert.equal(ledgerClosedAt(view('manual', { events: [...events, { kind: 'increase', liquidityDelta: 5n, timestamp: 400 }, { kind: 'close', liquidityDelta: -5n, timestamp: 500 }] })), 500, 'a reopened NFT uses its later close');
});

// (2026-10-15, pack 7): a position minted before Domino's release (the ledger's 'before_floor') has no mint to date, but
// it was minted before SETUP_DEPLOY_BLOCK, so at or before SETUP_DEPLOYED_BY: once that is at or before the window's
// start, the last 7 days are all this NFT's own, drawn with no opening mark.
test('a position minted before the release gets the stored 7-day window from a proven bound, never an opening time', () => {
  assert.equal(SETUP_DEPLOY_BLOCK, 69_249_061);
  // docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json: verifiedBlock 69,250,734 (a later block) at this time.
  assert.equal(SETUP_DEPLOYED_BY, 1_790_039_242);
  const before = { phase: 'unclaimed-only', state: { liquidity: 1n, timestamp: END }, reason: 'not_exact', why: 'before_floor', events: [{ kind: 'collect', liquidityDelta: 0n, timestamp: END - 10 }] };
  assert.equal(ledgerOpenedBefore(before), SETUP_DEPLOYED_BY);
  assert.equal(ledgerOpenedAt(before), null, 'never an opening time');
  for (const why of ['manual', 'native', 'shared', 'liquidity', 'unseen', 'too_many', 'reading', undefined]) assert.equal(ledgerOpenedBefore({ ...before, why }), null, `${why}: no bound`);
  assert.equal(ledgerOpenedBefore({ ...before, mintedAt: { block: 80_000_000, timestamp: END } }), null, 'a known mint is an opening time, not a bound');
  assert.equal(ledgerOpenedBefore({ ...before, events: [{ kind: 'mint', liquidityDelta: 1n, timestamp: END }] }), null);
  assert.equal(ledgerOpenedBefore({ ...before, reason: 'rpc_unavailable' }), null);
  for (const phase of ['idle', 'loading', 'verified', 'cached', 'unavailable']) assert.equal(ledgerOpenedBefore({ ...before, phase }), null, phase);

  const item = CASES.inside;
  const { facts } = factsOf(item);
  // A window that starts after the bound (today's), and one that does not (a window ending on END, before the release).
  const late = END + 30 * 86_400;
  const data = historyFor(item, BODY(item), { end: late });
  const start = data.requestedWindow.startTimestamp;
  assert.ok(start >= SETUP_DEPLOYED_BY);
  const run = (mint, bound, answer = data, now = late) => historyLine(answer, { base: item.base.address, quote: item.quote.address }, range(facts), now, mint, bound);
  const line = run(null, SETUP_DEPLOYED_BY);
  assert.equal(line.kind, 'line', 'a bound at or before the window’s start draws');
  assert.equal(line.history.start, start, 'the stored window, from its start');
  assert.deepEqual(line, run(SETUP_DEPLOYED_BY - 86_400), 'the same line an older known mint draws');
  assert.equal(run(null, start).kind, 'line', 'a bound at the start itself');
  assert.deepEqual(run(null, start + 1), { kind: 'none', reason: 'unknown_mint' }, 'a bound inside the window proves nothing about it');
  assert.deepEqual(run(null, SETUP_DEPLOYED_BY, historyFor(item, BODY(item), { end: END }), END), { kind: 'none', reason: 'unknown_mint' }, 'a window that starts before the release');
  for (const bound of [null, undefined, 0, NaN, -1, 1.5]) assert.deepEqual(run(null, bound), { kind: 'none', reason: 'unknown_mint' });
  assert.equal(run(late - 3600, SETUP_DEPLOYED_BY).history.start, late - 3600, 'a known mint wins over a bound');
});

test('only an identified V2 creation with a valid block and transaction supplies a ledger hint', () => {
  const position = { chainId: 4663, dex: 4, tokenId: 42n, vault: null };
  const hash = `0x${'ab'.repeat(32)}`;
  const create = { kind: 's1_action', chainId: 4663, action: 'create', tokenId: '42', tx: { hash, snapshot: { timestamp: END, number: '82863189' } }, steps: [{ tokenId: '42', pool: { dex: 4 } }] };
  assert.deepEqual(activityMint({ items: [create] }, position), { tokenId: '42', block: 82863189, tx: hash, timestamp: END });
  assert.equal(activityMint({ items: [create] }, { ...position, chainId: 8453 }), null);
  assert.equal(activityMint({ items: [create] }, { ...position, dex: 3 }), null);
  assert.equal(activityMint({ items: [{ ...create, action: 'increase' }] }, position), null);
  for (const number of ['0', '-1', 'NaN', '9007199254740992']) assert.equal(activityMint({ items: [{ ...create, tx: { ...create.tx, snapshot: { ...create.tx.snapshot, number } } }] }, position), null);
  assert.equal(activityMint({ items: [{ ...create, tx: { ...create.tx, hash: 'unknown' } }] }, position), null);
});

test('V2 creation is matched by chain, DEX and new token ID; vault registration and the previous range are never its mint', () => {
  const position = { chainId: 4663, dex: 4, tokenId: 42n, vault: null };
  const create = { kind: 's1_action', chainId: 4663, action: 'create', tokenId: '42', previousTokenId: null, tx: { snapshot: { timestamp: END } }, steps: [{ tokenId: '42', pool: { dex: 4 } }] };
  const run = (item, p = position) => activityOpenedAt({ items: [item] }, p);
  assert.equal(run(create), END);
  assert.equal(run({ ...create, action: 'change_range', previousTokenId: '41' }), END);
  assert.equal(run({ ...create, action: 'increase' }), null);
  assert.equal(run({ ...create, chainId: 8453 }), null);
  assert.equal(run(create, { ...position, dex: 3 }), null);
  assert.equal(run({ ...create, tokenId: '43', previousTokenId: '42' }), null);
  assert.equal(run({ ...create, kind: 'vault_created', rootTokenId: '42' }), null);
  const mint = { kind: 'vault_execution', chainId: 4663, action: 'mint', vault: '0xA', successor: { tokenId: '42', parentTokenId: '41' }, tx: create.tx };
  assert.equal(run(mint), null);
  assert.equal(run(mint, { ...position, vault: { address: '0xa', role: 'successor' } }), END);
  assert.equal(run(mint, { ...position, vault: { address: '0xb', role: 'successor' } }), null);
  assert.equal(run(mint, { ...position, vault: { address: '0xa', role: 'root' } }), null);
});
