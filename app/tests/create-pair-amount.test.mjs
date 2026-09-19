/**
 * The other token's amount for a position (src/lib/create/pairAmount.ts).
 *
 * A concentrated position holds both of a pool's currencies in a ratio the
 * range and the price fix, so an amount of one determines the other. These
 * check the arithmetic against v4-core's LiquidityAmounts, computed here the
 * same way and in exact integers, and check the two edges where a range is
 * wholly on one side of the price and takes one currency only.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { pairedAmount } = require('../.test-build/app/src/lib/create/pairAmount.js');
const { sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js');

const Q96 = 1n << 96n;
/** sqrt(1) × 2^96: tick 0. */
const SQRT_ONE = String(Q96);

/** The same formulas the module uses, written out independently for the expectation. */
const order = (a, b) => (a > b ? [b, a] : [a, b]);
function amount1From0(sqrtP, sqrtLower, sqrtUpper, amount0) {
  const [lo, hi] = order(sqrtP, sqrtUpper);
  const liquidity = (amount0 * ((lo * hi) / Q96)) / (hi - lo);
  const [lo1, hi1] = order(sqrtLower, sqrtP);
  return (liquidity * (hi1 - lo1)) / Q96;
}

test('inside the range, an amount of currency0 fixes the liquidity and currency1 follows', () => {
  // A symmetric range around tick 0: at the pool price the two sides are equal in value.
  const lower = -60;
  const upper = 60;
  const result = pairedAmount({ sqrtPriceX96: SQRT_ONE, tickLower: lower, tickUpper: upper, independent: 0, amountRaw: '1000000000000000000' });
  assert.equal(result.kind, 'amount');
  assert.equal(result.only, null);
  const expected = amount1From0(Q96, sqrtPriceAtTick(lower), sqrtPriceAtTick(upper), 1000000000000000000n);
  assert.equal(result.raw, String(expected));
  // Equal ticks either side of the price: the two amounts are within a rounding step of each other.
  const difference = 1000000000000000000n - BigInt(result.raw);
  assert.ok(difference >= 0n && difference < 100000000000n, `symmetric range, near-equal sides: got ${result.raw}`);
});

test('the same range answers both directions, and the round trip returns what was typed', () => {
  const input = { sqrtPriceX96: SQRT_ONE, tickLower: -600, tickUpper: 600 };
  const forward = pairedAmount({ ...input, independent: 0, amountRaw: '5000000000000000000' });
  assert.equal(forward.kind, 'amount');
  const back = pairedAmount({ ...input, independent: 1, amountRaw: forward.raw });
  assert.equal(back.kind, 'amount');
  // Integer division truncates at each step, so the round trip returns the amount or one step under it.
  const difference = 5000000000000000000n - BigInt(back.raw);
  assert.ok(difference >= 0n && difference < 1000000n, `round trip within truncation: ${back.raw}`);
});

test('a range wholly above the price takes currency0 only; an amount of currency1 buys nothing there', () => {
  // Price at tick 0, range from tick 60 upward: the position is all currency0.
  const above = { sqrtPriceX96: SQRT_ONE, tickLower: 60, tickUpper: 600 };
  const typed0 = pairedAmount({ ...above, independent: 0, amountRaw: '1000000' });
  assert.deepEqual(typed0, { kind: 'amount', raw: '0', only: 0 }, 'currency1 is zero, and the row says which currency the range takes');
  assert.deepEqual(pairedAmount({ ...above, independent: 1, amountRaw: '1000000' }), { kind: 'unused', only: 0 });
});

test('a range wholly below the price takes currency1 only; an amount of currency0 buys nothing there', () => {
  const below = { sqrtPriceX96: SQRT_ONE, tickLower: -600, tickUpper: -60 };
  assert.deepEqual(pairedAmount({ ...below, independent: 1, amountRaw: '1000000' }), { kind: 'amount', raw: '0', only: 1 });
  assert.deepEqual(pairedAmount({ ...below, independent: 0, amountRaw: '1000000' }), { kind: 'unused', only: 1 });
});

test('nothing is claimed for a price, a range or an amount that cannot be used', () => {
  const ok = { sqrtPriceX96: SQRT_ONE, tickLower: -60, tickUpper: 60, independent: 0, amountRaw: '1' };
  assert.equal(pairedAmount({ ...ok, sqrtPriceX96: 'not a number' }).kind, 'unknown');
  assert.equal(pairedAmount({ ...ok, sqrtPriceX96: '0' }).kind, 'unknown');
  assert.equal(pairedAmount({ ...ok, amountRaw: '-1' }).kind, 'unknown');
  assert.equal(pairedAmount({ ...ok, amountRaw: '1.5' }).kind, 'unknown');
  assert.equal(pairedAmount({ ...ok, tickLower: 60, tickUpper: -60 }).kind, 'unknown', 'bounds the wrong way round');
  assert.equal(pairedAmount({ ...ok, tickLower: 60, tickUpper: 60 }).kind, 'unknown', 'a range of no width');
  assert.equal(pairedAmount({ ...ok, tickLower: -1000000 }).kind, 'unknown', 'a tick outside what the pool allows');
});

test('an amount of zero is an amount, not a refusal: the other side is zero too', () => {
  const result = pairedAmount({ sqrtPriceX96: SQRT_ONE, tickLower: -60, tickUpper: 60, independent: 0, amountRaw: '0' });
  assert.deepEqual(result, { kind: 'amount', raw: '0', only: null });
});
