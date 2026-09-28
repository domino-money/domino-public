/**
 * Your APR (src/lib/positionApr.ts, the owner, 2026-09-27): one position's own fees as a yearly rate on the money that
 * was in it, from its fees history. These build small histories by hand, work the expected rate out independently
 * (the position's value from its liquidity and price, fees at each hour's price) and check the rate, the windows, the
 * liquidity added later, and every case where the page must say why there is no rate instead of a figure.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { APR_MIN_SECONDS, APR_MISSING, aprText, positionApr, spanText } = require('../.test-build/app/src/lib/positionApr.js');

const HOUR = 3_600;
const DAY = 86_400;
const YEAR = 365 * DAY;
const Q96 = 2n ** 96n;
const T0 = 1_790_000_000;
/** Both tokens 6 decimals, the price 1 (tick 0): a token of either side is worth one of the other. */
const STATE = { tickLower: -600, tickUpper: 600, currencies: [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: '0xb', symbol: 'B', decimals: 6 }] };
const L = 10n ** 12n;

/** The value of liquidity `l` at price 1 in -600..600, in whole tokens: the v4 amounts at sqrtP = 1. */
function worth(l) {
  const sqrtA = Math.pow(1.0001, -300);
  const sqrtB = Math.pow(1.0001, 300);
  return (Number(l) * (sqrtB - 1)) / sqrtB / 1e6 + (Number(l) * (1 - sqrtA)) / 1e6;
}

/**
 * A history of `hours` hours from T0: each hour earns `perHour(i)` whole tokens of B (cumulative in `earned`), at price 1.
 * `events`: [{ at (seconds after T0), delta }] besides the mint at T0 with `L`.
 */
function history({ hours, perHour = () => 1, events = [], sqrt = Q96 }) {
  const hourly = [];
  let earned = 0n;
  for (let i = 0; i < hours; i++) {
    earned += BigInt(Math.round(perHour(i) * 1e6));
    hourly.push({ anchor: i, t: T0 + (i + 1) * HOUR, earned: [0n, earned], collected: [0n, 0n], inRangeSeconds: HOUR, sqrtPriceX96Close: sqrt, tickClose: 0 });
  }
  const all = [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: L }, ...events.map((e, i) => ({ kind: e.delta > 0n ? 'increase' : 'decrease', block: 2 + i, timestamp: T0 + e.at, tx: `0x${i + 2}`, fees: [0n, 0n], liquidityDelta: e.delta }))];
  return { mintedAt: { block: 1, timestamp: T0 }, hourly, events: all };
}

const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9, `${what}: ${actual} against ${expected}`);

test('a steady position: the fees over its value, annualised', () => {
  const h = history({ hours: 48 });
  const apr = positionApr(h, STATE, 1, 'all');
  assert.equal(apr.ok, true);
  assert.equal(apr.seconds, 48 * HOUR);
  // 48 tokens earned over 48 hours on a constant value.
  close(apr.rate, (48 * YEAR) / (worth(L) * 48 * HOUR), 'rate');
  // Either side as the unit gives the same rate at price 1.
  close(positionApr(h, STATE, 0, 'all').rate, apr.rate, 'in the other side');
});

test('the 24-hour window counts only the last day’s fees and value', () => {
  // One token an hour the first day, three the second.
  const h = history({ hours: 48, perHour: (i) => (i < 24 ? 1 : 3) });
  const day = positionApr(h, STATE, 1, '24h');
  assert.equal(day.seconds, 24 * HOUR);
  close(day.rate, (72 * YEAR) / (worth(L) * 24 * HOUR), '24h');
  const all = positionApr(h, STATE, 1, 'all');
  close(all.rate, (96 * YEAR) / (worth(L) * 48 * HOUR), 'all');
  // A history under a day: the 24-hour window is all of it.
  const young = history({ hours: 10 });
  assert.equal(positionApr(young, STATE, 1, '24h').seconds, 10 * HOUR);
  close(positionApr(young, STATE, 1, '24h').rate, positionApr(young, STATE, 1, 'all').rate, 'young');
});

test('liquidity added later counts only from when it was added (an Increase, an Auto-compound)', () => {
  // The position doubles half an hour into hour 12.
  const at = 12 * HOUR + 1_800;
  const h = history({ hours: 24, events: [{ at, delta: L }] });
  const apr = positionApr(h, STATE, 1, 'all');
  const weighted = worth(L) * at + worth(2n * L) * (24 * HOUR - at);
  close(apr.rate, (24 * YEAR) / weighted, 'time-weighted');
  // Part taken out: the value after it is the smaller one.
  const out = history({ hours: 24, events: [{ at: 6 * HOUR, delta: -L / 2n }] });
  close(positionApr(out, STATE, 1, 'all').rate, (24 * YEAR) / (worth(L) * 6 * HOUR + worth(L / 2n) * 18 * HOUR), 'decrease');
});

test('fees are valued at each hour’s own price', () => {
  // Token A earned, worth 2 B at the hour's close (sqrtP = √2): the fees count double against a value at the same price.
  const sqrt = BigInt(Math.round(Math.SQRT2 * 2 ** 48)) * 2n ** 48n;
  const h = history({ hours: 12, sqrt });
  for (const hour of h.hourly) hour.earned = [hour.earned[1], 0n];
  const apr = positionApr(h, STATE, 1, 'all');
  const p = Number(sqrt) / 2 ** 96;
  const sqrtA = Math.pow(1.0001, -300);
  const sqrtB = Math.pow(1.0001, 300);
  const clamped = Math.min(Math.max(p, sqrtA), sqrtB);
  const price = p * p;
  const value = ((Number(L) * (sqrtB - clamped)) / (clamped * sqrtB) / 1e6) * price + (Number(L) * (clamped - sqrtA)) / 1e6;
  close(apr.rate, (12 * price * YEAR) / (value * 12 * HOUR), 'at the hour’s price');
});

test('no rate, with its reason, when it cannot honestly be said', () => {
  // Under six hours of history.
  const young = positionApr(history({ hours: 5 }), STATE, 1, 'all');
  assert.deepEqual(young, { ok: false, reason: 'short', seconds: 5 * HOUR });
  assert.equal(positionApr(history({ hours: 6 }), STATE, 1, 'all').ok, true, 'six hours is enough');
  assert.equal(APR_MIN_SECONDS, 6 * HOUR);
  // A token whose decimals were not read.
  const unknown = { ...STATE, currencies: [STATE.currencies[0], { ...STATE.currencies[1], decimals: null }] };
  assert.equal(positionApr(history({ hours: 12 }), unknown, 1, 'all').reason, 'no_price');
  // A price of zero.
  assert.equal(positionApr(history({ hours: 12, sqrt: 0n }), STATE, 1, 'all').reason, 'no_price');
  // Nothing earned.
  assert.equal(positionApr(history({ hours: 12, perHour: () => 0 }), STATE, 1, 'all').reason, 'zero');
  // Closed before the last day: nothing in the position in the 24-hour window.
  const closed = history({ hours: 48, perHour: (i) => (i < 20 ? 1 : 0), events: [{ at: 20 * HOUR, delta: -L }] });
  assert.equal(positionApr(closed, STATE, 1, '24h').reason, 'empty');
  assert.equal(positionApr(closed, STATE, 1, 'all').ok, true, 'but it earned while it was open');
  // No hours at all.
  assert.equal(positionApr({ mintedAt: { block: 1, timestamp: T0 }, hourly: [], events: [] }, STATE, 1, 'all').reason, 'short');
  for (const reason of ['short', 'no_price', 'empty', 'zero']) assert.match(APR_MISSING[reason], /^[A-Z][a-z0-9 ]+$/, `plain words for ${reason}`);
});

test('the rate and the window in words', () => {
  assert.equal(aprText(0.382), '38.2%');
  assert.equal(aprText(0.04), '4.0%');
  assert.equal(aprText(0.0004), '<0.1%');
  assert.equal(aprText(1.234), '123%');
  assert.equal(aprText(12.345), '1,235%');
  assert.equal(spanText(HOUR), '1 hour');
  assert.equal(spanText(18 * HOUR), '18 hours');
  assert.equal(spanText(47 * HOUR), '47 hours');
  assert.equal(spanText(3 * DAY + 2 * HOUR), '3 days');
});
