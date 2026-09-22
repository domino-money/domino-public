// The mint plan a funded setup operation gets from its balances at the pool's
// price (src/lib/create/mintPlan.ts): the liquidity both balances cover, the
// slack kept back for the pool's round-up, and the price band the owner's
// slippage draws. Checked against the same v4-core helpers the paired amount
// uses, so a plan's amounts never exceed what was funded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIQUIDITY_SLACK_BPS, mintPlanFor } from '../.test-build/app/src/lib/create/mintPlan.js';
import { amount0ForLiquidity, amount1ForLiquidity, liquidityForAmount0, liquidityForAmount1 } from '../.test-build/app/src/lib/create/pairAmount.js';
import { sqrtPriceAtTick } from '../.test-build/app/src/lib/read/screens/poolRange.js';

// A price inside the range: tick 0, so 1:1, between ticks -600 and 600.
const AT_PAR = String(sqrtPriceAtTick(0));

test('inside the range the plan takes the smaller liquidity of the two balances, less the slack, and caps at the balances', () => {
  const plan = mintPlanFor({ sqrtPriceX96: AT_PAR, tickLower: -600, tickUpper: 600, balance0: 1_000_000n, balance1: 5_000_000n, slippageBps: 50 });
  assert.ok(plan);
  const from0 = liquidityForAmount0(sqrtPriceAtTick(0), sqrtPriceAtTick(600), 1_000_000n);
  const from1 = liquidityForAmount1(sqrtPriceAtTick(-600), sqrtPriceAtTick(0), 5_000_000n);
  assert.ok(from0 < from1, 'currency0 is the scarce side here');
  assert.equal(plan.liquidity, (from0 * (10000n - LIQUIDITY_SLACK_BPS)) / 10000n);
  assert.deepEqual([plan.maxAmount0, plan.maxAmount1, plan.initialSqrtPriceX96], [1_000_000n, 5_000_000n, 0n]);
  // What that liquidity takes of each side is within what was funded.
  assert.ok(amount0ForLiquidity(sqrtPriceAtTick(0), sqrtPriceAtTick(600), plan.liquidity) <= 1_000_000n);
  assert.ok(amount1ForLiquidity(sqrtPriceAtTick(-600), sqrtPriceAtTick(0), plan.liquidity) <= 5_000_000n);
});

test('the band is the slippage limit halved for a square-root price, around the price given', () => {
  const plan = mintPlanFor({ sqrtPriceX96: AT_PAR, tickLower: -600, tickUpper: 600, balance0: 1n << 40n, balance1: 1n << 40n, slippageBps: 100 });
  assert.ok(plan);
  const sqrt = BigInt(AT_PAR);
  assert.equal(plan.minSqrtPriceX96, (sqrt * 19900n) / 20000n);
  assert.equal(plan.maxSqrtPriceX96, (sqrt * 20100n + 19999n) / 20000n);
  assert.ok(plan.minSqrtPriceX96 < sqrt && sqrt < plan.maxSqrtPriceX96);
});

test('below the range only currency0 funds the position; above it only currency1', () => {
  const below = mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(-1200)), tickLower: -600, tickUpper: 600, balance0: 1_000_000n, balance1: 0n, slippageBps: 50 });
  assert.ok(below);
  assert.equal(below.liquidity, (liquidityForAmount0(sqrtPriceAtTick(-600), sqrtPriceAtTick(600), 1_000_000n) * 9990n) / 10000n);
  const above = mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(1200)), tickLower: -600, tickUpper: 600, balance0: 0n, balance1: 1_000_000n, slippageBps: 50 });
  assert.ok(above);
  assert.equal(above.liquidity, (liquidityForAmount1(sqrtPriceAtTick(-600), sqrtPriceAtTick(600), 1_000_000n) * 9990n) / 10000n);
  // The wrong side alone buys nothing there.
  assert.equal(mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(-1200)), tickLower: -600, tickUpper: 600, balance0: 0n, balance1: 1_000_000n, slippageBps: 50 }), null);
});

test('inputs that make no plan are refused as null, never as a zero or a throw', () => {
  const base = { sqrtPriceX96: AT_PAR, tickLower: -600, tickUpper: 600, balance0: 1_000_000n, balance1: 1_000_000n, slippageBps: 50 };
  assert.equal(mintPlanFor({ ...base, sqrtPriceX96: 'not a number' }), null);
  assert.equal(mintPlanFor({ ...base, sqrtPriceX96: '0' }), null);
  assert.equal(mintPlanFor({ ...base, tickLower: 600, tickUpper: -600 }), null, 'an inverted range');
  assert.equal(mintPlanFor({ ...base, balance0: 0n, balance1: 0n }), null, 'nothing funded');
  assert.equal(mintPlanFor({ ...base, slippageBps: 5 }), null, 'below the product bound');
  assert.equal(mintPlanFor({ ...base, slippageBps: 501 }), null, 'above it');
  assert.equal(mintPlanFor({ ...base, slippageBps: 50.5 }), null, 'whole basis points only');
});
