// The mint a funded setup operation gets from its balances at the pool's
// price (src/lib/create/mintPlan.ts): the liquidity both balances cover
// wherever the price lands inside the band, the slack kept back for the
// pool's round-up, and the band the owner's slippage draws. Checked against
// the same v4-core helpers the paired amount uses, at both edges of the band,
// so a plan never asks for more than was funded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIQUIDITY_SLACK_BPS, mintPlanFor } from '../.test-build/app/src/lib/create/mintPlan.js';
import { amount0ForLiquidity, amount1ForLiquidity, liquidityForAmount0, liquidityForAmount1 } from '../.test-build/app/src/lib/create/pairAmount.js';
import { sqrtPriceAtTick } from '../.test-build/app/src/lib/read/screens/poolRange.js';

// A price inside the range: tick 0, so 1:1.
const AT_PAR = String(sqrtPriceAtTick(0));

/** What `liquidity` takes of each token if the mint executes at `sqrtP` (v4-core, rounded down as the helpers are). */
function takes(sqrtP, lower, upper, liquidity) {
  const sL = sqrtPriceAtTick(lower), sU = sqrtPriceAtTick(upper);
  if (sqrtP <= sL) return [amount0ForLiquidity(sL, sU, liquidity), 0n];
  if (sqrtP >= sU) return [0n, amount1ForLiquidity(sL, sU, liquidity)];
  return [amount0ForLiquidity(sqrtP, sU, liquidity), amount1ForLiquidity(sL, sqrtP, liquidity)];
}

test('the plan fits the balances wherever the price lands inside the band, narrow range or wide, and keeps its slack', () => {
  for (const [lower, upper] of [[-600, 600], [-120, 120], [-3600, 4080]]) {
    for (const slippageBps of [10, 50, 100, 500]) {
      const balances = [1_000_000_000n, 1_000_000_000n];
      const plan = mintPlanFor({ sqrtPriceX96: AT_PAR, tickLower: lower, tickUpper: upper, balance0: balances[0], balance1: balances[1], slippageBps });
      assert.ok(plan, `${lower}..${upper} at ${slippageBps} bps`);
      assert.deepEqual([plan.maxAmount0, plan.maxAmount1, plan.initialSqrtPriceX96], [balances[0], balances[1], 0n]);
      for (const edge of [plan.minSqrtPriceX96, BigInt(AT_PAR), plan.maxSqrtPriceX96]) {
        const [need0, need1] = takes(edge, lower, upper, plan.liquidity);
        // The pool rounds each side up by at most a unit; the slack is far more than that.
        assert.ok(need0 + 1n <= balances[0] && need1 + 1n <= balances[1], `${lower}..${upper} at ${slippageBps} bps, sqrt ${edge}: needs ${need0}/${need1}`);
      }
    }
  }
});

test('in a wide range the band costs little: the plan is close to what the balances make at the price itself', () => {
  const plan = mintPlanFor({ sqrtPriceX96: AT_PAR, tickLower: -3600, tickUpper: 4080, balance0: 1_000_000_000n, balance1: 1_000_000_000n, slippageBps: 50 });
  const atPrice = [liquidityForAmount0(BigInt(AT_PAR), sqrtPriceAtTick(4080), 1_000_000_000n), liquidityForAmount1(sqrtPriceAtTick(-3600), BigInt(AT_PAR), 1_000_000_000n)];
  const best = atPrice[0] < atPrice[1] ? atPrice[0] : atPrice[1];
  assert.ok(plan.liquidity <= (best * (10000n - LIQUIDITY_SLACK_BPS)) / 10000n);
  assert.ok(plan.liquidity * 100n >= best * 98n, 'within 2% of the liquidity at the price itself');
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
  assert.equal(mintPlanFor({ ...base, balance0: 0n }), null, 'in range, one side alone makes no position');
  assert.equal(mintPlanFor({ ...base, slippageBps: 5 }), null, 'below the product bound');
  assert.equal(mintPlanFor({ ...base, slippageBps: 501 }), null, 'above it');
  assert.equal(mintPlanFor({ ...base, slippageBps: 50.5 }), null, 'whole basis points only');
});

// Added 2026-09-28 (one-sided). The study's edge case: a range whose upper edge is exactly today's price holds only
// currency1 (v4 takes currency1 alone at or above the upper edge), and Review planned it with no swap. The mint was
// sized for a band reaching into the range, found currency0 missing, and Create position swapped about 1% of the
// deposit for it, a swap Review never showed. A deposit of one token alone now keeps its band on that side of the range.
test('one token alone for a range that takes it alone: the band stops at the range’s edge, the edge touching the price included', () => {
  const MANY = 500_000n * 10n ** 18n;
  // The study's pool: tick 338460, and the sell range whose upper edge is exactly that price.
  const at = sqrtPriceAtTick(338460);
  const edge = mintPlanFor({ sqrtPriceX96: String(at), tickLower: 333360, tickUpper: 338460, balance0: 0n, balance1: MANY, slippageBps: 50 });
  assert.ok(edge, 'the deposit alone makes the position: nothing to swap');
  assert.equal(edge.minSqrtPriceX96, at, 'never below the upper edge, where the range would need currency0 too');
  assert.equal(edge.maxSqrtPriceX96, (at * 20050n + 19999n) / 20000n);
  assert.equal(edge.maxAmount0, 0n);
  assert.equal(edge.liquidity, (liquidityForAmount1(sqrtPriceAtTick(333360), at, MANY) * 9990n) / 10000n);
  // Wherever in its band it lands, the mint needs no currency0 and fits the deposit.
  for (const sqrt of [edge.minSqrtPriceX96, edge.maxSqrtPriceX96]) {
    const [need0, need1] = takes(sqrt, 333360, 338460, edge.liquidity);
    assert.ok(need0 === 0n && need1 + 1n <= MANY, `sqrt ${sqrt}: ${need0}/${need1}`);
  }
  // The mirror: currency0 alone for a range whose lower edge is exactly today's price.
  const low = mintPlanFor({ sqrtPriceX96: String(at), tickLower: 338460, tickUpper: 342060, balance0: 1_000_000_000n, balance1: 0n, slippageBps: 50 });
  assert.ok(low);
  assert.equal(low.maxSqrtPriceX96, at, 'never above the lower edge');
  assert.equal(low.minSqrtPriceX96, (at * 19950n) / 20000n);
  // Farther out the band is the plain one: nothing to clamp.
  const far = mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(-1200)), tickLower: -600, tickUpper: 600, balance0: 1_000_000n, balance1: 0n, slippageBps: 50 });
  assert.equal(far.maxSqrtPriceX96, (sqrtPriceAtTick(-1200) * 20050n + 19999n) / 20000n);
  // Once the price is inside the range, one token alone makes no position: the range needs both.
  assert.equal(mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(338400)), tickLower: 333360, tickUpper: 338460, balance0: 0n, balance1: MANY, slippageBps: 50 }), null);
  assert.equal(mintPlanFor({ sqrtPriceX96: String(sqrtPriceAtTick(338520)), tickLower: 338460, tickUpper: 342060, balance0: 1_000_000_000n, balance1: 0n, slippageBps: 50 }), null);
  // Both tokens: the plain band, as before.
  const both = mintPlanFor({ sqrtPriceX96: String(at), tickLower: 333360, tickUpper: 342060, balance0: 1_000_000_000n, balance1: MANY, slippageBps: 50 });
  assert.equal(both.minSqrtPriceX96, (at * 19950n) / 20000n);
});
