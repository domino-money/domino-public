/**
 * What the S1 screens say, as pure functions (src/v2/plan/present.ts, consent.ts): amounts rounded down and never
 * guessed without decimals, typed amounts and slippage, prices in both orientations, ranges on the spacing, the minimum
 * liquidity as token amounts, leftovers (WETH on v3), the network fee rounded up, and the consent path of spec §2.5.4.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const p = require(`${BUILD}v2/plan/present.js`);
const { chooseConsent } = require(`${BUILD}v2/plan/consent.js`);

const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

test('amounts: grouped, rounded down at the shown decimals, "<0.000001" for a dust amount, raw digits without decimals', () => {
  assert.equal(p.formatUnitsText(1_234_567_891n, 6), '1,234.567891');
  assert.equal(p.formatUnitsText(3_250_000n, 6), '3.25');
  assert.equal(p.formatUnitsText(1_999_999_999_999_999_999n, 18, 4), '1.9999', 'rounded down, never up');
  assert.equal(p.formatUnitsText(1n, 18), '<0.000001');
  assert.equal(p.formatUnitsText(0n, 18), '0');
  assert.equal(p.formatUnitsText(123456789n, null), '123,456,789', 'no decimals: raw units, never a guess');
  assert.equal(p.formatUnitsText(10n ** 24n, 18), '1,000,000');
  assert.throws(() => p.formatUnitsText(1n, 78), /invalid_decimals/);
});

test('typed amounts and slippage', () => {
  assert.equal(p.parseUnitsText('1,000.5', 6), 1_000_500_000n);
  assert.equal(p.parseUnitsText('.25', 18), 250_000_000_000_000_000n);
  assert.equal(p.parseUnitsText('0', 6), null);
  assert.equal(p.parseUnitsText('1.1234567', 6), null, 'more decimals than the token has');
  assert.equal(p.parseUnitsText('-1', 6), null);
  assert.equal(p.parseUnitsText('1e5', 6), null);
  assert.equal(p.parseUnitsText('', 6), null);
  assert.equal(p.parseUnitsText('42', null), 42n);
  assert.equal(p.parseUnitsText('4.2', null), null);
  assert.equal(p.slippageBpsOf('0.5', 10, 500), 50);
  assert.equal(p.slippageBpsOf('5%', 10, 500), 500);
  assert.equal(p.slippageBpsOf('0.1', 10, 500), 10);
  assert.equal(p.slippageBpsOf('0.09', 10, 500), null);
  assert.equal(p.slippageBpsOf('5.01', 10, 500), null);
  assert.equal(p.slippageBpsOf('abc', 10, 500), null);
});

test('labels: symbols, ETH for native, short addresses; fee tiers as a percent', () => {
  assert.equal(p.tokenText({ address: USDG, symbol: 'USDG' }), 'USDG');
  assert.equal(p.tokenText({ address: ZERO, symbol: null }), 'ETH');
  assert.equal(p.tokenText({ address: USDG, symbol: null }), '0x5fc5…d168');
  assert.deepEqual([p.feeTierText(3000), p.feeTierText(500), p.feeTierText(100), p.feeTierText(200), p.feeTierText(10000)], ['0.3%', '0.05%', '0.01%', '0.02%', '1%']);
});

test('prices: currency1 per currency0 from a tick with decimals, both orientations, null without decimals', () => {
  // ETH (18) / USDG (6): tick −199000 is about 2,280 USDG per ETH.
  const price = p.priceAtTick(-199000, 18, 6);
  assert.ok(price > 2279 && price < 2282, String(price));
  assert.equal(p.priceAtTick(0, 18, 18), 1);
  assert.equal(p.priceAtTick(-199000, null, 6), null);
  const both = p.rangeBothWays(-201060, -198060, 18, 6);
  assert.ok(both.forward.low < both.forward.high);
  assert.ok(Math.abs(both.inverse.low - 1 / both.forward.high) < 1e-12);
  assert.ok(Math.abs(both.inverse.high - 1 / both.forward.low) < 1e-12);
  assert.deepEqual(p.rangeBothWays(-60, 60, null, 6), { forward: { low: null, high: null }, inverse: { low: null, high: null } });
  assert.equal(p.priceText(2272.123456789), '2,272.12');
  assert.equal(p.priceText(0.000440123456), '0.000440123');
  assert.equal(p.priceText(null), null);
  assert.equal(p.priceText(0), null);
});

test('ranges: on the spacing, the lower down and the upper up, never empty, inside the bounds', () => {
  assert.equal(p.usableTick(-199031, 60), -199020);
  assert.equal(p.usableTick(900000, 60), 887220);
  const r = p.rangeAround(-199000, 60, 5);
  assert.ok(r.tickLower % 60 === 0 && r.tickUpper % 60 === 0);
  assert.ok(r.tickLower < -199000 && r.tickUpper > -199000);
  // About ±5% in price.
  assert.ok(Math.abs(1.0001 ** (r.tickUpper - -199000) - 1.05) < 0.01);
  const narrow = p.rangeAround(0, 200, 0.01);
  assert.ok(narrow.tickLower < narrow.tickUpper);
  assert.ok(p.rangeValid(r.tickLower, r.tickUpper, 60));
  assert.equal(p.rangeValid(-61, 60, 60), false);
  assert.equal(p.rangeValid(60, 60, 60), false);
  assert.throws(() => p.rangeAround(0, 60, 0), /invalid_range_width/);
});

test('the minimum liquidity as token amounts, and the leftovers (WETH for unused ETH on v3)', () => {
  assert.deepEqual(p.minimumTokens([1000n, 2000n], 10_000n, 9_950n), [995n, 1990n]);
  assert.equal(p.minimumTokens([1n, 1n], 0n, 0n), null);
  // Spec §2.8 example 1: 1,000 USDG in, 500 swapped to ETH (0.2 expected), the fee 3.25 USDG on top.
  const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const legs = [{ kind: 3, router: ZERO, tokenIn: USDG, tokenOut: ZERO, amountIn: 500_000_000n, minAmountOut: 1n, data: '0x' }];
  const left = p.leftovers({ pool, weth: WETH, inputs: [{ token: USDG, amount: 1_000_000_000n }], legs, quotedOut: [200_000_000_000_000_000n], fee: { token: USDG, amount: 3_250_000n }, added: [190_000_000_000_000_000n, 490_000_000n] });
  assert.deepEqual(left, [{ token: USDG, amount: 6_750_000n }, { token: ZERO, amount: 10_000_000_000_000_000n }]);
  // v3 WETH pool, ETH in: what is left of the ETH comes back as WETH.
  const v3 = { dex: 3, currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
  assert.deepEqual(p.leftovers({ pool: v3, weth: WETH, inputs: [{ token: ZERO, amount: 10n }], legs: [], quotedOut: [], fee: null, added: [7n, 0n] }), [{ token: WETH, amount: 3n }]);
  assert.equal(p.leftovers({ pool, weth: WETH, inputs: [{ token: USDG, amount: 1n }], legs: [], quotedOut: [], fee: null, added: [0n, 2n] }), null, 'a plan that does not add up shows nothing');
});

test('spans and ETH fees (rounded up)', () => {
  assert.deepEqual([p.spanText(59), p.spanText(600), p.spanText(3900), p.spanText(7200)], ['59 s', '10 min', '1 h 5 min', '2 h']);
  assert.equal(p.ethText(48_000_000_000_000n), '0.000048 ETH');
  assert.equal(p.ethText(1n), '0.00000001 ETH', 'a ceiling is never shown lower');
  assert.equal(p.ethText(0n), '0 ETH');
});

test('the consent path (spec §2.5.4): a batch first, then Permit2 for a plain account with ERC-20 only, else direct', () => {
  const facts = (over) => ({ action: 'create', atomic: 'unsupported', account: 'plain', inputs: [{ token: USDG }], chosenRecipient: false, ...over });
  assert.deepEqual(chooseConsent(facts({ atomic: 'supported' })), { path: 'batch', planConsent: 'direct', reason: 'wallet_batches' });
  assert.deepEqual(chooseConsent(facts({ atomic: 'ready', inputs: [{ token: ZERO }] })), { path: 'batch', planConsent: 'direct', reason: 'wallet_batches' });
  assert.deepEqual(chooseConsent(facts({})), { path: 'permit2', planConsent: 'permit2', reason: 'plain_account_erc20' });
  assert.deepEqual(chooseConsent(facts({ action: 'increase' })).path, 'permit2');
  assert.deepEqual(chooseConsent(facts({ inputs: [{ token: USDG }, { token: ZERO }] })), { path: 'direct', planConsent: 'direct', reason: 'native_input' });
  assert.deepEqual(chooseConsent(facts({ account: 'delegated' })), { path: 'direct', planConsent: 'direct', reason: 'account_has_code' });
  assert.deepEqual(chooseConsent(facts({ account: 'contract' })).reason, 'account_has_code');
  assert.deepEqual(chooseConsent(facts({ chosenRecipient: true })).reason, 'chosen_recipient');
  assert.deepEqual(chooseConsent(facts({ action: 'exit' })), { path: 'direct', planConsent: 'direct', reason: 'position_action' });
  assert.deepEqual(chooseConsent(facts({ action: 'changeRange' })).path, 'direct');
  assert.deepEqual(chooseConsent(facts({ action: 'changeRange', atomic: 'supported' })).path, 'batch');
});

test('item 9: a handed-over deposit fills the amount exactly, as the token this pool can take', () => {
  assert.equal(p.exactUnitsText(1_234_567_891n, 6), '1234.567891');
  assert.equal(p.exactUnitsText(10n ** 18n, 18), '1');
  assert.equal(p.exactUnitsText(1n, 18), '0.000000000000000001', 'every decimal kept');
  assert.equal(p.exactUnitsText(42n, null), '42');
  assert.equal(p.parseUnitsText(p.exactUnitsText(123_456_789_012_345_678n, 18), 18), 123_456_789_012_345_678n, 'reads back to the same raw amount');
  assert.throws(() => p.exactUnitsText(-1n, 6), /invalid_amount/);
  const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
  assert.deepEqual(p.handoffPlace(USDG.toUpperCase().replace('0X', '0x'), pool, [WETH]), { mode: 'one', token: USDG });
  assert.deepEqual(p.handoffPlace(ZERO, pool, [WETH]), { mode: 'one', token: ZERO });
  assert.deepEqual(p.handoffPlace(WETH, pool, [WETH]), { mode: 'other', token: WETH });
  assert.equal(p.handoffPlace('0x00000000000000000000000000000000000075a1', pool, [WETH]), null, 'a token this pool cannot start from: the person types');
});
