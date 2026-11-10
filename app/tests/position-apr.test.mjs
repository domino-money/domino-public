/**
 * Your APR (src/lib/positionApr.ts, the owner, 2026-09-27): one position's own fees as a yearly rate on the money that
 * was in it, from its fees history. These build small histories by hand, work the expected rate out independently
 * (the position's value from its liquidity and the price now) and check the rate, the windows, the liquidity added later,
 * and every case where the page must say why there is no rate instead of a figure.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4: the history is the position's ledger, measured points only): every amount
 * is valued at today's price, and the last 24 hours start at a measured point 20 to 28 hours old.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { APR_MIN_SECONDS, APR_MISSING, DAY_POINT_SECONDS, aprText, positionApr, spanText } = require('../.test-build/app/src/lib/positionApr.js');

const HOUR = 3_600;
const DAY = 86_400;
const YEAR = 365 * DAY;
const Q96 = 2n ** 96n;
const T0 = 1_790_000_000;
/** Both tokens 6 decimals, the price now 1 (tick 0): a token of either side is worth one of the other. */
const currencies = [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: '0xb', symbol: 'B', decimals: 6 }];
const stateAt = (end, sqrtPriceX96 = Q96) => ({ tickLower: -600, tickUpper: 600, currencies, sqrtPriceX96, timestamp: end });
const L = 10n ** 12n;

/** The value of liquidity `l` at price 1 in -600..600, in whole tokens: the v4 amounts at sqrtP = 1. */
function worth(l) {
  const sqrtA = Math.pow(1.0001, -300);
  const sqrtB = Math.pow(1.0001, 300);
  return (Number(l) * (sqrtB - 1)) / sqrtB / 1e6 + (Number(l) * (1 - sqrtA)) / 1e6;
}

/**
 * A history of `hours` hours from T0, measured each hour (this browser's readings): each hour earns `perHour(i)` whole
 * tokens of B, cumulative. `events`: [{ at (seconds after T0), delta }] besides the mint at T0 with `L`.
 */
function history({ hours, perHour = () => 1, events = [] }) {
  const points = [{ block: 1, t: T0, earned: [0n, 0n], collected: [0n, 0n], kind: 'opened' }];
  let earned = 0n;
  for (let i = 0; i < hours; i++) {
    earned += BigInt(Math.round(perHour(i) * 1e6));
    points.push({ block: 2 + i, t: T0 + (i + 1) * HOUR, earned: [0n, earned], collected: [0n, 0n], kind: i === hours - 1 ? 'now' : 'reading' });
  }
  const all = [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: L }, ...events.map((e, i) => ({ kind: e.delta > 0n ? 'increase' : 'decrease', block: 2 + i, timestamp: T0 + e.at, tx: `0x${i + 2}`, fees: [0n, 0n], liquidityDelta: e.delta }))];
  return { mintedAt: { block: 1, timestamp: T0 }, points, events: all, earned: [0n, earned] };
}

const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9, `${what}: ${actual} against ${expected}`);

function firstReading(seconds, earned = [0n, 1n]) {
  const h = history({ hours: 0 });
  h.earned = earned;
  h.points.push({ block: 2, t: T0 + seconds, earned, collected: [0n, 0n], kind: 'now' });
  return h;
}

test('the first verified positive interval has its measured APR, without waiting six hours', () => {
  assert.equal(APR_MIN_SECONDS, 1, 'only zero elapsed chain time is excluded');
  const immediate = positionApr(firstReading(0), stateAt(T0), 1, 'all');
  assert.deepEqual(immediate, { ok: false, reason: 'short', seconds: 0 });
  for (const seconds of [1, 30, 60, 5 * HOUR]) {
    const apr = positionApr(firstReading(seconds), stateAt(T0 + seconds), 1, 'all');
    assert.equal(apr.ok, true);
    assert.equal(apr.seconds, seconds);
    assert.deepEqual(apr.from, { t: T0, block: 1 });
    close(apr.rate, (0.000001 * YEAR) / (worth(L) * seconds), `${seconds} seconds`);
  }
});

test('measured zero fees with capital and elapsed time are zero APR, not missing data', () => {
  for (const seconds of [1, 60, 12 * HOUR]) {
    const apr = positionApr(firstReading(seconds, [0n, 0n]), stateAt(T0 + seconds), 1, 'all');
    assert.equal(apr.ok, true);
    assert.equal(apr.rate, 0);
    assert.equal(aprText(apr.rate), '0%');
  }
  const zeroDay = history({ hours: 48, perHour: (i) => i < 24 ? 1 : 0 });
  const apr = positionApr(zeroDay, stateAt(T0 + 48 * HOUR), 1, '24h');
  assert.equal(apr.ok, true);
  assert.equal(apr.rate, 0, 'the measured last day earned zero although the first day earned fees');
});

test('capital added during the first minute is weighted only over its actual exposure', () => {
  const h = firstReading(60, [0n, 1_000_000n]);
  h.events.push({ kind: 'increase', block: 2, timestamp: T0 + 30, tx: '0x2', fees: [0n, 0n], liquidityDelta: L });
  const apr = positionApr(h, stateAt(T0 + 60), 1, 'all');
  assert.equal(apr.ok, true);
  close(apr.rate, YEAR / (worth(L) * 30 + worth(2n * L) * 30), 'first-minute exposure');
});

test('a steady position: the fees over its value, annualised', () => {
  const h = history({ hours: 48 });
  const state = stateAt(T0 + 48 * HOUR);
  const apr = positionApr(h, state, 1, 'all');
  assert.equal(apr.ok, true);
  assert.equal(apr.seconds, 48 * HOUR);
  // 48 tokens earned over 48 hours on a constant value.
  close(apr.rate, (48 * YEAR) / (worth(L) * 48 * HOUR), 'rate');
  // Either side as the unit gives the same rate at price 1.
  close(positionApr(h, state, 0, 'all').rate, apr.rate, 'in the other side');
});

test('the 24-hour window starts at the measured point nearest a day old, 20 to 28 hours back; with none, no figure', () => {
  // One token an hour the first day, three the second.
  const h = history({ hours: 48, perHour: (i) => (i < 24 ? 1 : 3) });
  const state = stateAt(T0 + 48 * HOUR);
  const day = positionApr(h, state, 1, '24h');
  assert.equal(day.seconds, 24 * HOUR);
  close(day.rate, (72 * YEAR) / (worth(L) * 24 * HOUR), '24h');
  const all = positionApr(h, state, 1, 'all');
  close(all.rate, (96 * YEAR) / (worth(L) * 48 * HOUR), 'all');
  assert.deepEqual(DAY_POINT_SECONDS, { min: 20 * HOUR, max: 28 * HOUR });
  // Only points 30 and 18 hours old: none within 20 to 28 hours, no figure.
  const sparse = { ...h, points: h.points.filter((point) => point.kind !== 'reading' || point.t === T0 + 18 * HOUR || point.t === T0 + 30 * HOUR) };
  assert.deepEqual(positionApr(sparse, state, 1, '24h'), { ok: false, reason: 'no_point', seconds: 0 });
  // Only one 21 hours old: the window is those 21 hours.
  const one = { ...h, points: h.points.filter((point) => point.kind !== 'reading' || point.t === T0 + 27 * HOUR) };
  assert.equal(positionApr(one, state, 1, '24h').seconds, 21 * HOUR);
  // A history under a day has no point a day old.
  assert.equal(positionApr(history({ hours: 10 }), stateAt(T0 + 10 * HOUR), 1, '24h').reason, 'no_point');
});

test('liquidity added later counts only from when it was added (an Increase, an Auto-compound)', () => {
  // The position doubles half an hour into hour 12.
  const at = 12 * HOUR + 1_800;
  const h = history({ hours: 24, events: [{ at, delta: L }] });
  const apr = positionApr(h, stateAt(T0 + 24 * HOUR), 1, 'all');
  const weighted = worth(L) * at + worth(2n * L) * (24 * HOUR - at);
  close(apr.rate, (24 * YEAR) / weighted, 'time-weighted');
  // Part taken out: the value after it is the smaller one.
  const out = history({ hours: 24, events: [{ at: 6 * HOUR, delta: -L / 2n }] });
  close(positionApr(out, stateAt(T0 + 24 * HOUR), 1, 'all').rate, (24 * YEAR) / (worth(L) * 6 * HOUR + worth(L / 2n) * 18 * HOUR), 'decrease');
});

test('every amount is valued at today’s price: the fees and the money in the position alike', () => {
  // Token A earned, worth 2 B now (sqrtP = √2): the fees count double, against the position's value at the same price.
  const sqrt = BigInt(Math.round(Math.SQRT2 * 2 ** 48)) * 2n ** 48n;
  const h = history({ hours: 12 });
  h.earned = [h.earned[1], 0n];
  for (const point of h.points) point.earned = [point.earned[1], 0n];
  const apr = positionApr(h, stateAt(T0 + 12 * HOUR, sqrt), 1, 'all');
  const p = Number(sqrt) / 2 ** 96;
  const sqrtA = Math.pow(1.0001, -300);
  const sqrtB = Math.pow(1.0001, 300);
  const clamped = Math.min(Math.max(p, sqrtA), sqrtB);
  const price = p * p;
  const value = ((Number(L) * (sqrtB - clamped)) / (clamped * sqrtB) / 1e6) * price + (Number(L) * (clamped - sqrtA)) / 1e6;
  close(apr.rate, (12 * price * YEAR) / (value * 12 * HOUR), 'at today’s price');
});

test('no rate, with its reason, when it cannot honestly be said', () => {
  // A token whose decimals were not read.
  const unknown = { ...stateAt(T0 + 12 * HOUR), currencies: [currencies[0], { ...currencies[1], decimals: null }] };
  assert.equal(positionApr(history({ hours: 12 }), unknown, 1, 'all').reason, 'no_price');
  // A price of zero.
  assert.equal(positionApr(history({ hours: 12 }), stateAt(T0 + 12 * HOUR, 0n), 1, 'all').reason, 'no_price');
  // Closed a day ago: nothing in the position over the last day.
  const closed = history({ hours: 48, perHour: (i) => (i < 20 ? 1 : 0), events: [{ at: 20 * HOUR, delta: -L }] });
  assert.equal(positionApr(closed, stateAt(T0 + 48 * HOUR), 1, '24h').reason, 'empty');
  assert.equal(positionApr(closed, stateAt(T0 + 48 * HOUR), 1, 'all').ok, true, 'but it earned while it was open');
  // No points at all.
  assert.equal(positionApr({ mintedAt: { block: 1, timestamp: T0 }, points: [], events: [], earned: [0n, 0n] }, stateAt(T0), 1, 'all').reason, 'short');
  for (const reason of ['short', 'no_price', 'empty', 'unavailable', 'no_point']) assert.match(APR_MISSING[reason], /^[A-Z][a-z0-9 ]+$/, `plain words for ${reason}`);
});

test('unusable prices, overflow and inconsistent amounts never become zero or infinite APR', () => {
  const h = firstReading(60, [0n, 1_000_000n]);
  const state = stateAt(T0 + 60);
  assert.equal(positionApr(h, { ...state, sqrtPriceX96: 10n ** 1_000n }, 1, 'all').reason, 'no_price');
  assert.equal(positionApr(h, { ...state, tickUpper: Infinity }, 1, 'all').reason, 'no_price');
  assert.equal(positionApr(h, { ...state, currencies: [{ ...currencies[0], decimals: NaN }, currencies[1]] }, 1, 'all').reason, 'no_price');
  const overflow = { ...h, events: [{ ...h.events[0], liquidityDelta: 10n ** 1_000n }] };
  assert.equal(positionApr(overflow, state, 1, 'all').reason, 'unavailable');
  assert.equal(positionApr({ ...h, earned: [0n, 10n ** 1_000n] }, state, 1, 'all').reason, 'unavailable');
  assert.equal(positionApr({ ...h, earned: [0n, -1n] }, state, 1, 'all').reason, 'unavailable');
  const noTime = { ...h, points: [{ ...h.points[1], t: NaN }] };
  assert.equal(positionApr(noTime, state, 1, 'all').reason, 'unavailable');
  const overdrawn = { ...h, events: [...h.events, { ...h.events[0], timestamp: T0 + 30, liquidityDelta: -2n * L }] };
  assert.equal(positionApr(overdrawn, state, 1, 'all').reason, 'unavailable');
});

test('the rate and the window in words', () => {
  assert.equal(aprText(0), '0%');
  assert.equal(aprText(0.382), '38.2%');
  assert.equal(aprText(0.04), '4.0%');
  assert.equal(aprText(0.0004), '<0.1%');
  assert.equal(aprText(1.234), '123%');
  assert.equal(aprText(12.345), '1,235%');
  assert.equal(spanText(0), '0 seconds');
  assert.equal(spanText(1), '1 second');
  assert.equal(spanText(59), '59 seconds');
  assert.equal(spanText(60), '1 minute');
  assert.equal(spanText(300), '5 minutes');
  assert.equal(spanText(HOUR), '1 hour');
  assert.equal(spanText(18 * HOUR), '18 hours');
  assert.equal(spanText(47 * HOUR), '47 hours');
  assert.equal(spanText(3 * DAY + 2 * HOUR), '3 days');
});

// 2026-10-02 (the chart's periods back): the last 24 hours start at the card's 24H start (lib/fees/periods.ts), which a
// read of the position a day ago gives when the history has no point there (lib/fees/pastReads.ts): a reading like any.
test('the last 24 hours from a read made a day ago, and the line says where it starts', () => {
  const h = history({ hours: 48 });
  // Only the read made 24 hours back (a past read), no other point in 20 to 28 hours.
  const readAt = T0 + 24 * HOUR;
  h.points = h.points.filter((point) => point.kind !== 'reading' || point.t === readAt || point.t < T0 + 20 * HOUR || point.t > T0 + 28 * HOUR);
  const day = positionApr(h, stateAt(T0 + 48 * HOUR), 1, '24h');
  assert.equal(day.ok, true);
  assert.equal(day.seconds, 24 * HOUR);
  assert.equal(day.from.t, readAt);
  assert.equal(day.from.block, h.points.find((point) => point.t === readAt).block);
  close(day.rate, (24 * YEAR) / (worth(L) * 24 * HOUR), 'the day from the read');
});

// ---------------------------------------------------------------------------
// Added on purpose 2026-11-09 (core flows: a position in a collapsed pool read "1.7,957…e+26%"): a rate is worked out on
// money, never on dust (positionApr.ts DUST_CAPITAL), and every rate is written in whole grouped digits (format/apr.ts).
// The owner's D9 stays: a rate from the first reading (APR_MIN_SECONDS = 1).
// ---------------------------------------------------------------------------
const { DUST_CAPITAL } = require('../.test-build/app/src/lib/positionApr.js');
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** A pair whose second side is USDG (6 decimals), the first `decimals0`: Robinhood Chain's pools. */
const usdgPair = (decimals0 = 6) => [{ address: '0x00000000000000000000000000000000000000a1', symbol: 'MEME', decimals: decimals0 }, { address: USDG, symbol: 'USDG', decimals: 6 }];

test('a pool whose price collapsed: the money in the position is dust at today’s price, so no rate (`empty`, the dash), never 1e+20', () => {
  // 1e18 of liquidity of an 18-decimal token below its range at a price of ~1.7e-18 USDG: ~1e-19 USDG in the position.
  // About 5 USDG earned over the week, before the price fell.
  const h = history({ hours: 7 * 24, perHour: () => 0.03 });
  h.events[0] = { ...h.events[0], liquidityDelta: 10n ** 18n };
  const state = { ...stateAt(T0 + 7 * 24 * HOUR, 10n ** 14n), currencies: usdgPair(18) };
  const apr = positionApr(h, state, 1, 'all');
  assert.deepEqual(apr, { ok: false, reason: 'empty', seconds: 7 * 24 * HOUR });
  assert.equal(APR_MISSING[apr.reason], 'Nothing in the position');
  assert.equal(positionApr(h, state, 1, '24h').reason, 'empty', 'the last day too');
});

test('the dust floor is one cent of USDG (a millionth of a token otherwise), on the time-weighted capital: just above it a rate, just under it the dash', () => {
  assert.deepEqual(DUST_CAPITAL, { usdg: 0.01, token: 0.000001 });
  const at = (l, pair) => {
    const h = firstReading(HOUR, [0n, 1n]);
    h.events[0] = { ...h.events[0], liquidityDelta: l };
    return positionApr(h, { ...stateAt(T0 + HOUR), currencies: pair }, 1, 'all');
  };
  // USDG: about two cents and about half a cent in the position.
  assert.ok(worth(340_000n) > 0.02 && worth(85_000n) < 0.0051);
  const cents = at(340_000n, usdgPair());
  assert.equal(cents.ok, true);
  close(cents.rate, (0.000001 * YEAR) / (worth(340_000n) * HOUR), 'two cents for an hour');
  assert.equal(at(85_000n, usdgPair()).reason, 'empty');
  // Another token: about two millionths, and under half of one.
  assert.equal(at(34n, currencies).ok, true);
  assert.equal(at(8n, currencies).reason, 'empty');
  // On the time-weighted capital: two cents for half the window is a cent on average, a rate; for a third of it, not.
  const half = firstReading(2 * HOUR, [0n, 1n]);
  half.events = [{ ...half.events[0], liquidityDelta: 340_000n }, { ...half.events[0], kind: 'decrease', block: 2, timestamp: T0 + HOUR, tx: '0x2', liquidityDelta: -340_000n }];
  assert.equal(positionApr(half, { ...stateAt(T0 + 2 * HOUR), currencies: usdgPair() }, 1, 'all').ok, true);
  const third = firstReading(3 * HOUR, [0n, 1n]);
  third.events = [{ ...half.events[0] }, { ...half.events[1] }];
  assert.equal(positionApr(third, { ...stateAt(T0 + 3 * HOUR), currencies: usdgPair() }, 1, 'all').reason, 'empty');
});

test('D9 stays: a position opened a second ago with money in it shows its early rate, however large, in whole grouped digits', () => {
  assert.equal(APR_MIN_SECONDS, 1);
  // About 59,000 USDG in it for one second, a dollar earned.
  const apr = positionApr(firstReading(1, [0n, 1_000_000n]), { ...stateAt(T0 + 1), currencies: usdgPair() }, 1, 'all');
  assert.equal(apr.ok, true);
  assert.equal(apr.seconds, 1);
  close(apr.rate, YEAR / (worth(L) * 1), 'a second of a big position');
  // Two cents for one second that earned a millionth of a dollar: about 157,000%, a real if early rate.
  const h = firstReading(1, [0n, 1n]);
  h.events[0] = { ...h.events[0], liquidityDelta: 340_000n };
  const early = positionApr(h, { ...stateAt(T0 + 1), currencies: usdgPair() }, 1, 'all');
  assert.equal(early.ok, true);
  assert.match(aprText(early.rate), /^\d{1,3}(,\d{3})+%$/);
  assert.doesNotMatch(aprText(early.rate), /e/i);
});

test('a rate of any size is written in whole grouped digits: never exponent notation', () => {
  assert.equal(aprText(1.7957e24), '179,570,000,000,000,000,000,000,000%');
  assert.equal(aprText(1e19), '1,000,000,000,000,000,000,000%');
  assert.equal(aprText(9.99e18), '999,000,000,000,000,000,000%');
  assert.equal(aprText(14.284), '1,428%');
  for (const rate of [1e19, 3.3e25, 1.2e40, Number.MAX_VALUE / 1000]) assert.doesNotMatch(aprText(rate), /e|E|\+/, String(rate));
});
