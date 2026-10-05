/**
 * The 0.65% assisted-swap fee rule (spec F7 §2.8), replicated in src/v2/feeRule.ts: the spec's vector table, its worked
 * examples with raw amounts, every case of contracts/test/v2/fees/DominoFeeRules.t.sol, and a randomized comparison
 * with that test's reference model.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const rule = require('../../.test-build/app/src/v2/feeRule.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const ROBINHOOD = chains.v2Chain(4663), BASE = chains.v2Chain(8453), ARBITRUM = chains.v2Chain(42161);
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ETH = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
// Not charge currencies anywhere: stand-ins for stock and memecoin tokens.
const TSLA = '0x00000000000000000000000000000000000075a1', MANY = '0x000000000000000000000000000000000000a4a1', NVDA = '0x0000000000000000000000000000000000000d1a';
const rh = (token) => chains.profileRank(ROBINHOOD, token);
const leg = (tokenIn, tokenOut, amountIn = 100n) => ({ tokenIn, tokenOut, amountIn });
const route = (...pairs) => pairs.map(([a, b]) => leg(a, b));
const pick = (legs, rankOf = rh) => { const { token, place } = rule.assistedSwapFeeToken(legs, rankOf); return [token, place]; };

test('the spec\'s vector table (§2.8, Robinhood ranks)', () => {
  assert.deepEqual(pick(route([USDG, MANY])), [USDG, 'input'], 'USDG → MANY');
  assert.deepEqual(pick(route([MANY, USDG])), [USDG, 'output'], 'MANY → USDG');
  assert.deepEqual(pick(route([TSLA, USDG], [USDG, MANY])), [USDG, 'hop'], 'TSLA → USDG, USDG → MANY');
  assert.deepEqual(pick(route([TSLA, MANY])), [TSLA, 'fallback'], 'TSLA → MANY');
  assert.deepEqual(pick(route([WETH, USDG])), [USDG, 'output'], 'WETH → USDG: the rank beats the place');
  assert.deepEqual(pick(route([ETH, MANY])), [ETH, 'input'], 'ETH → MANY');
  assert.deepEqual(pick(route([ETH, WETH])), [ETH, 'input'], 'ETH → WETH: a tie, the input wins');
  assert.deepEqual(pick(route([TSLA, WETH], [WETH, MANY], [NVDA, ETH])), [ETH, 'output'], 'an output beats a hop of the same rank');
});

test('every case of the contract\'s own test (DominoFeeRules.t.sol)', () => {
  assert.deepEqual(pick(route([NVDA, TSLA], [TSLA, MANY])), [NVDA, 'fallback'], 'never a hop that is no charge');
  assert.deepEqual(pick(route([ETH, USDG])), [USDG, 'output']);
  assert.deepEqual(pick(route([WETH, USDG], [USDG, MANY])), [USDG, 'hop'], 'a USDG hop beats a WETH input');
  assert.deepEqual(pick(route([WETH, ETH])), [WETH, 'input']);
  assert.deepEqual(pick(route([TSLA, WETH], [WETH, MANY], [NVDA, ETH], [ETH, MANY])), [WETH, 'hop'], 'two hops: the earlier');
  assert.deepEqual(pick(route([TSLA, WETH], [NVDA, ETH])), [WETH, 'output'], 'two outputs: the earlier');
  assert.deepEqual(pick(route([TSLA, ETH], [NVDA, WETH])), [ETH, 'output'], 'the earlier output, native');
  assert.deepEqual(pick(route([WETH, MANY], [ETH, TSLA])), [WETH, 'input'], 'two inputs: the earlier');
  assert.deepEqual(pick(route([USDG, MANY], [TSLA, USDG])), [USDG, 'input'], 'spent before delivered');
  assert.deepEqual(pick(route([MANY, WETH], [WETH, TSLA])), [WETH, 'hop'], 'delivered then spent');
  assert.deepEqual(pick(route([WETH, TSLA], [MANY, WETH])), [WETH, 'input'], 'spent, then delivered later');
  assert.throws(() => rule.assistedSwapFeeToken([], rh), /invalid_plan/, 'an empty route selects nothing');
});

test('Base and Arbitrum charge USDC first; USDG is no charge currency there', () => {
  for (const [chain, usdc, weth] of [[BASE, USDC_BASE, WETH_BASE], [ARBITRUM, USDC_ARB, '0x82af49447d8a07e3bd95bd0d56f35241523fbab1']]) {
    const rank = (token) => chains.profileRank(chain, token);
    assert.deepEqual(pick(route([ETH, usdc]), rank), [usdc, 'output']);
    assert.deepEqual(pick(route([weth, usdc]), rank), [usdc, 'output']);
    assert.deepEqual(pick(route([USDG, MANY]), rank), [USDG, 'fallback']);
    assert.deepEqual(pick(route([weth, MANY]), rank), [weth, 'input']);
  }
});

test('the fee terms an intent must carry: none without legs, 65 in the rule\'s token with them', () => {
  assert.deepEqual(rule.expectedFeeTerms([], rh), { feeBps: 0, feeToken: ETH, place: null });
  assert.deepEqual(rule.expectedFeeTerms(route([USDG, ETH]), rh), { feeBps: 65, feeToken: USDG, place: 'input' });
  assert.equal(rule.feeTermsMatch([], rh, 0, ETH), true);
  assert.equal(rule.feeTermsMatch([], rh, 65, USDG), false, 'no swap, no fee');
  assert.equal(rule.feeTermsMatch(route([USDG, ETH]), rh, 65, USDG.toUpperCase().replace('0X', '0x')), true, 'addresses compare in any case');
  assert.equal(rule.feeTermsMatch(route([USDG, ETH]), rh, 65, ETH), false, 'the wrong token');
  assert.equal(rule.feeTermsMatch(route([USDG, ETH]), rh, 64, USDG), false, 'the wrong rate');
  assert.equal(rule.feeTermsMatch(route([USDG, ETH]), rh, 0, ETH), false, 'a swap without its fee');
});

test('the swapped amount is what entered or what came out (the contract\'s cases)', () => {
  const two = (a, b, c, d) => [leg(a, b), leg(c, d)];
  let legs = two(USDG, MANY, USDG, TSLA); legs[1].amountIn = 50n;
  assert.equal(rule.swappedAmount(legs, [7n, 9n], USDG), 150n, 'input: 100 + 50 spent');
  legs = two(MANY, USDG, TSLA, USDG);
  assert.equal(rule.swappedAmount(legs, [70n, 30n], USDG), 100n, 'output: 70 + 30 delivered');
  legs = two(TSLA, USDG, USDG, MANY); legs[1].amountIn = 1n;
  assert.equal(rule.swappedAmount(legs, [1000n, 5n], USDG), 1000n, 'hop: 1000 carried, 1 spent');
  legs[1].amountIn = 1400n;
  assert.equal(rule.swappedAmount(legs, [1000n, 5n], USDG), 1400n, 'hop: 1400 spent, 1000 carried');
  assert.throws(() => rule.swappedAmount(route([USDG, MANY]), [1n, 2n], USDG), /invalid_plan/, 'one measured amount per leg');
});

test('fees round down in the payer\'s favour', () => {
  assert.equal(rule.feeOf(10_000n, 65), 65n);
  assert.equal(rule.feeOf(9_999n, 65), 64n);
  assert.equal(rule.feeOf(153n, 65), 0n, 'below one unit is free');
  assert.equal(rule.feeOf(1_000_000n, 400), 40_000n);
  const big = ((1n << 128n) - 1n) * 8n;
  assert.equal(rule.feeOf(big, 65), big * 65n / 10_000n, 'no overflow');
});

test('the spec\'s worked examples with raw amounts (§2.8)', () => {
  // 1. Robinhood, ETH/USDG v4 with 1,000 USDG; the leg USDG → ETH spends 500 USDG: 3.25 USDG on top, from the input.
  let fee = rule.assistedSwapFee([leg(USDG, ETH, 500_000_000n)], [200_000_000_000_000_000n], rh);
  assert.deepEqual(fee, { token: USDG, place: 'input', swapped: 500_000_000n, amount: 3_250_000n });
  // 2. Base, exit converting WETH → USDC; the leg delivered 1,352.50 USDC (measured): 8.79125 USDC from the output.
  const baseRank = (token) => chains.profileRank(BASE, token);
  fee = rule.assistedSwapFee([leg(WETH_BASE, USDC_BASE, 500_000_000_000_000_000n)], [1_352_500_000n], baseRank);
  assert.deepEqual(fee, { token: USDC_BASE, place: 'output', swapped: 1_352_500_000n, amount: 8_791_250n });
  assert.equal(1_352_500_000n - fee.amount, 1_343_708_750n, '1,343.70875 USDC left from the conversion');
  // 3. Robinhood, TSLA/MANY with TSLA only: TSLA → USDG delivers 1,000 USDG; USDG → MANY spends 990: 6.50 USDG from the hop.
  fee = rule.assistedSwapFee([leg(TSLA, USDG, 5n * 10n ** 18n), leg(USDG, MANY, 990_000_000n)], [1_000_000_000n, 77n], rh);
  assert.deepEqual(fee, { token: USDG, place: 'hop', swapped: 1_000_000_000n, amount: 6_500_000n });
  assert.equal(1_000_000_000n - 990_000_000n - fee.amount, 3_500_000n, '3.50 USDG come back');
  // 4. TSLA → MANY in one leg: the fallback, TSLA on top of the amountIn.
  fee = rule.assistedSwapFee([leg(TSLA, MANY, 2n * 10n ** 18n)], [1n], rh);
  assert.deepEqual(fee, { token: TSLA, place: 'fallback', swapped: 2n * 10n ** 18n, amount: 13n * 10n ** 15n });
  // 5. No swap: no fee.
  assert.equal(rule.assistedSwapFee([], [], rh), null);
});

test('randomized: the replica selects as the contract test\'s reference model does', () => {
  const tokens = [USDG, ETH, WETH, TSLA, MANY, NVDA];
  // The reference model of DominoFeeRules.t.sol, restated: every (place, leg, side) in scan order, the first lowest rank.
  const model = (rankOf, legs) => {
    let best = null, bestPlace = null, bestRank = 0;
    for (let place = 1; place <= 3; place++) {
      for (let i = 0; i < legs.length; i++) {
        for (let side = 0; side < 2; side++) {
          const token = side === 0 ? legs[i].tokenIn : legs[i].tokenOut;
          let hop = false;
          if (side === 0) for (let j = 0; j < i; j++) hop ||= legs[j].tokenOut === token;
          else for (let j = i + 1; j < legs.length; j++) hop ||= legs[j].tokenIn === token;
          const at = hop ? 3 : side === 0 ? 1 : 2;
          const rank = rankOf(token);
          if (at === place && rank !== 0 && (bestRank === 0 || rank < bestRank)) [best, bestPlace, bestRank] = [token, place, rank];
        }
      }
    }
    if (bestRank === 0) [best, bestPlace] = [legs[0].tokenIn, 4];
    return [best, ['input', 'output', 'hop', 'fallback'][bestPlace - 1]];
  };
  let seed = 0x2026_1002;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  for (let round = 0; round < 3000; round++) {
    const ranks = new Map(tokens.map((token) => [token, next() % 4]));
    const rankOf = (token) => ranks.get(token) ?? 0;
    const count = 1 + (next() % 5);
    const legs = [];
    for (let i = 0; i < count; i++) {
      const a = tokens[next() % 6];
      let b = tokens[next() % 6];
      if (a === b) b = tokens[(tokens.indexOf(b) + 1) % 6];
      legs.push(leg(a, b));
    }
    assert.deepEqual(pick(legs, rankOf), model(rankOf, legs), JSON.stringify({ legs: legs.map((l) => [l.tokenIn.slice(-4), l.tokenOut.slice(-4)]), ranks: [...ranks.values()] }));
  }
});
