/**
 * Uniswap v3's position math (src/chains/v3math.ts, 2026-10-01, the chain2 workstream, audit item G7): the fee growth
 * inside a range as core computes it, the fees collect() would pay as the position manager computes them (Solidity 0.7:
 * subtraction wraps, uint128() truncates), the amounts a liquidity holds, the providers' share of a swap fee, and a v3
 * pool's price written the chain's way round.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const v3 = require('../.test-build/app/src/chains/v3math.js');
const pair = require('../.test-build/app/src/lib/create/pairAmount.js');
const { sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js');

const Q128 = 1n << 128n;
const U256 = (1n << 256n) - 1n;
const outside = (a, b) => ({ feeGrowthOutside0X128: a, feeGrowthOutside1X128: b });

test('fee growth inside: in range, below it and above it, as core\'s Tick.getFeeGrowthInside', () => {
  const lower = outside(10n, 20n);
  const upper = outside(3n, 4n);
  // In range: global − lower's outside − upper's outside.
  assert.deepEqual(v3.feeGrowthInside(0, -60, 60, lower, upper, 100n, 200n), [87n, 176n]);
  // Below the range: below = global − lower's outside, above = upper's outside.
  assert.deepEqual(v3.feeGrowthInside(-120, -60, 60, lower, upper, 100n, 200n), [7n, 16n]);
  // At or above the upper tick: above = global − upper's outside.
  assert.deepEqual(v3.feeGrowthInside(60, -60, 60, lower, upper, 100n, 200n), [(100n - 10n - (100n - 3n)) & U256, (200n - 20n - (200n - 4n)) & U256]);
  // At the lower tick counts as in range (lower ≤ tick).
  assert.deepEqual(v3.feeGrowthInside(-60, -60, 60, lower, upper, 100n, 200n), [87n, 176n]);
});

test('uncollected fees: tokensOwed plus liquidity × (inside − last) / 2^128, the manager\'s arithmetic', () => {
  const position = { liquidity: 1_000n, feeGrowthInside0LastX128: 5n * Q128, feeGrowthInside1LastX128: 0n, tokensOwed0: 11n, tokensOwed1: 0n };
  assert.deepEqual(v3.uncollectedFees(position, [12n * Q128, 3n * Q128]), [11n + 7_000n, 3_000n]);
  // Rounded down, as FullMath.mulDiv does.
  assert.deepEqual(v3.uncollectedFees({ ...position, tokensOwed0: 0n, feeGrowthInside0LastX128: 0n }, [Q128 / 3n, 0n]), [333n, 0n]);
  // No liquidity: only what was already owed.
  assert.deepEqual(v3.uncollectedFees({ ...position, liquidity: 0n }, [99n * Q128, 99n * Q128]), [11n, 0n]);
});

test('the manager\'s wrap and truncation are kept: a growth below its last reading wraps, the sum stays a uint128', () => {
  const position = { liquidity: 1n, feeGrowthInside0LastX128: 2n, feeGrowthInside1LastX128: 0n, tokensOwed0: 5n, tokensOwed1: Q128 - 1n };
  // (1 − 2) mod 2^256 × 1 / 2^128 = 2^128 − 1, truncated to uint128; 5 + that wraps to 4.
  const [owed0, owed1] = v3.uncollectedFees(position, [1n, 2n * Q128]);
  assert.equal(owed0, 4n);
  // (2^128 − 1) + 2 wraps in uint128 to 1.
  assert.equal(owed1, 1n);
});

test('amounts a liquidity holds: one token below the range, the other above it, both inside, as periphery computes them', () => {
  const [lo, hi] = [-600, 600];
  const L = 10n ** 18n;
  const sqrtA = sqrtPriceAtTick(lo);
  const sqrtB = sqrtPriceAtTick(hi);
  assert.deepEqual(v3.amountsForLiquidity(sqrtA - 1n, lo, hi, L), [pair.amount0ForLiquidity(sqrtA, sqrtB, L), 0n]);
  assert.deepEqual(v3.amountsForLiquidity(sqrtB, lo, hi, L), [0n, pair.amount1ForLiquidity(sqrtA, sqrtB, L)]);
  const mid = sqrtPriceAtTick(0);
  const [a0, a1] = v3.amountsForLiquidity(mid, lo, hi, L);
  assert.equal(a0, pair.amount0ForLiquidity(mid, sqrtB, L));
  assert.equal(a1, pair.amount1ForLiquidity(sqrtA, mid, L));
  // A symmetric range at price 1 holds about the same of each (TickMath rounds each bound's price, so not exactly).
  assert.ok(a0 > 0n && a1 > 0n && (a0 > a1 ? a0 - a1 : a1 - a0) * 10n ** 9n < a0, `${a0} ${a1}`);
  // The liquidity those amounts buy is the liquidity they came from, within rounding.
  const back = pair.liquidityForAmount0(mid, sqrtB, a0);
  assert.ok(L - back >= 0n && L - back < 10n ** 6n, `${L - back}`);
});

test('in range is lower ≤ tick < upper', () => {
  assert.equal(v3.inRange(-60, -60, 60), true);
  assert.equal(v3.inRange(59, -60, 60), true);
  assert.equal(v3.inRange(60, -60, 60), false);
  assert.equal(v3.inRange(-61, -60, 60), false);
});

test('the providers\' share of a swap fee: all of it while the protocol fee is off, all but 1/N of it while on', () => {
  assert.deepEqual(v3.providerFees([1_000_000n, 2_000_000n], 3000, 0), [3_000n, 6_000n]);
  // feeProtocol 0x44: 1/4 of each token's fee goes to the protocol.
  assert.deepEqual(v3.providerFees([1_000_000n, 2_000_000n], 3000, 0x44), [2_250n, 4_500n]);
  // Only token1's protocol fee on (high bits): token0's share is whole.
  assert.deepEqual(v3.providerFees([1_000_000n, 1_000_000n], 500, 0x50), [500n, 400n]);
  assert.equal(v3.providerShare(10n, 0, 0), 10n);
});

test('a v3 price, token1 per token0 or the other way round, exact, and null without decimals', () => {
  const one = 1n << 96n;
  assert.equal(v3.priceText(one, 18, 6, false), '1000000000000.000000000000000000');
  assert.equal(v3.priceText(one, 18, 6, true), '0.000000000001000000');
  assert.equal(v3.priceText(one, 6, 6, false), '1.000000000000000000');
  assert.equal(v3.priceText(one * 2n, 6, 6, false), '4.000000000000000000');
  assert.equal(v3.priceText(one * 2n, 6, 6, true), '0.250000000000000000');
  assert.equal(v3.priceText(one, null, 6, false), null);
  assert.equal(v3.priceText(0n, 6, 6, false), null);
});
