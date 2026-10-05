/**
 * A new pool's starting price (src/v2/plan/initialPrice.ts, spec F7 rev2 §2.6.5, §7.5, decision #7): the typed price,
 * either way round, to the exact initSqrtPriceX96 and tick, and back from the integer in both orientations. The §7.5
 * vector is pinned, the plan API's own new-pool fixture agrees, and TickMath's port agrees with the package's runtime.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const { initialSqrtPrice, parsePriceText, pricesAtSqrt, sqrtPriceAtTick, tickAtSqrtPrice, typedBothWays, fractionText, MIN_SQRT_PRICE, MAX_SQRT_PRICE } = require(`${BUILD}v2/plan/initialPrice.js`);

test('§7.5: 2,500 USDG per ETH (18 and 6 decimals), stated either way, is 3961408125713216879677197 at tick -198080', () => {
  const forward = initialSqrtPrice({ price: parsePriceText('2,500'), base: 'currency0', decimals0: 18, decimals1: 6 });
  assert.deepEqual(forward, { sqrtPriceX96: 3961408125713216879677197n, tick: -198080 });
  const inverse = initialSqrtPrice({ price: parsePriceText('0.0004'), base: 'currency1', decimals0: 18, decimals1: 6 });
  assert.deepEqual(inverse, forward);
  // The round trip the review shows, from the integer.
  assert.deepEqual(pricesAtSqrt(forward.sqrtPriceX96, 18, 6), { price0In1: '2,499.99', price1In0: '0.0004' });
  assert.deepEqual(typedBothWays(parsePriceText('2500')), { forward: '2,500', inverse: '0.0004' });
});

test('the plan API\'s new-pool fixture: 1.25 of currency0 per currency1 is its sqrt price and tick', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../api-contracts/position-plan-v1/fixtures/variants/plan.create-new-pool-direct.json', import.meta.url), 'utf8')).plan;
  const asked = fixture.request.initialPrice;
  const base = asked.baseToken.toLowerCase() === fixture.pool.currency0 ? 'currency0' : 'currency1';
  const mine = initialSqrtPrice({ price: parsePriceText(asked.price), base, decimals0: asked.decimals0, decimals1: asked.decimals1 });
  assert.equal(String(mine.sqrtPriceX96), fixture.initialPrice.sqrtPriceX96);
  assert.equal(mine.tick, fixture.initialPrice.tick);
  assert.equal(String(mine.sqrtPriceX96), fixture.zapPlan.initSqrtPriceX96);
});

test('TickMath: the port is the package runtime\'s, and the tick is the largest whose price is at most the value', () => {
  for (const tick of [-887272, -400000, -198080, -2232, -1, 0, 1, 60, 123457, 887272]) {
    assert.equal(sqrtPriceAtTick(tick), runtime.sqrtAtTick(tick), String(tick));
  }
  for (const tick of [-887271, -198080, -2233, 0, 5000, 887271]) {
    const at = sqrtPriceAtTick(tick);
    assert.equal(tickAtSqrtPrice(at), tick);
    assert.equal(tickAtSqrtPrice(at + 1n), tick);
    assert.equal(tickAtSqrtPrice(at - 1n), tick - 1);
  }
  assert.equal(tickAtSqrtPrice(MIN_SQRT_PRICE), -887272);
  assert.throws(() => tickAtSqrtPrice(MAX_SQRT_PRICE), /sqrt_price_out_of_bounds/);
});

test('what a person types: plain positive decimals only; outside TickMath\'s bounds there is no price', () => {
  assert.deepEqual(parsePriceText(' 1,234.5000 '), { num: 12345n, den: 10n, text: '1234.5' });
  assert.equal(parsePriceText('007').text, '7');
  for (const bad of ['', '0', '0.000', '-1', '1e5', '1.2.3', 'abc', '1.' + '1'.repeat(37)]) assert.equal(parsePriceText(bad), null, bad);
  assert.equal(initialSqrtPrice({ price: parsePriceText('1'), base: 'currency0', decimals0: 0, decimals1: 77 }), null, 'too high');
  assert.equal(initialSqrtPrice({ price: parsePriceText('1'), base: 'currency0', decimals0: 77, decimals1: 0 }), null, 'too low');
  assert.equal(initialSqrtPrice({ price: parsePriceText('1'), base: 'currency0', decimals0: 78, decimals1: 0 }), null, 'decimals');
  assert.equal(fractionText(1n, 3n), '0.333333');
  assert.equal(fractionText(12345678n, 1n), '12,345,678');
});
