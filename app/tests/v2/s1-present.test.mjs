/**
 * What the S1 screens say, as pure functions (src/v2/plan/present.ts, consent.ts): amounts rounded down and never
 * guessed without decimals, typed amounts and slippage, prices in both orientations, ranges on the spacing, the minimum
 * liquidity as token amounts, leftovers (WETH on v3), the network fee rounded up, and the consent path of spec §2.5.4.
 * Since 2026-10-06 (the owner's point 4): the rounding defaults, Review's one network fee line, and the review kept
 * while the same choices are quoted again.
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

// Added 2026-10-30 (QA round 2, N2: "10,345.741134 PRIORS" on Review): six significant digits, as the rest of the app writes
// an amount (lib/format/amount.ts shortAmount): the whole part whole and grouped, rounded down, or up for a fee or an
// amount to allow; below one, at most six decimals (the owner's point 4), so dust stays "<0.000001".
test('amounts at six significant digits: the whole part kept, rounded down or up, dust a bound', () => {
  assert.equal(p.significantUnitsText(10_345_741_134n, 6), '10,345.7');
  assert.equal(p.significantUnitsText(2_018_590_753_780_000_000_000_000n, 18), '2,018,590');
  assert.equal(p.significantUnitsText(190_000_000_000_000_000n, 18), '0.19');
  assert.equal(p.significantUnitsText(1_000_000_000n, 6), '1,000');
  assert.equal(p.significantUnitsText(123_456_789n, 18), '<0.000001');
  assert.equal(p.significantUnitsText(1n, 18), '<0.000001', 'dust stays a bound, never 18 digits (owner point 4)');
  assert.equal(p.significantUnitsText(12_345_678_900_000n, 18), '0.000012', 'below one: six decimals at most');
  assert.equal(p.significantUnitsText(0n, 18), '0');
  assert.equal(p.significantUnitsText(10_345_741_134n, 6, 'up'), '10,345.8', 'a fee or an amount to allow: never shown lower');
  assert.equal(p.significantUnitsText(2_018_590_753_780_000_000_000_000n, 18, 'up'), '2,018,591');
  assert.equal(p.significantUnitsText(123_456_789n, 18, 'up'), '0.000001');
  assert.equal(p.significantUnitsText(999_999_95n, 2, 'up'), '1,000,000', 'rounding up may carry into a new digit');
  assert.equal(p.significantUnitsText(123456789n, null), '123,456,789', 'no decimals: raw units, never a guess');
  assert.throws(() => p.significantUnitsText(1n, 78), /invalid_decimals/);
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
  // QA round 2, N99: only thousands separators are dropped; a decimal comma is refused, never read as ten times the amount.
  assert.equal(p.parseUnitsText('0,5', 18), null, 'a decimal comma is refused, never read as 5');
  assert.equal(p.parseUnitsText('1,000.50', 6), 1_000_500_000n);
  assert.equal(p.parseUnitsText(' 0.5 ', 18), 500_000_000_000_000_000n, 'spaces around it are dropped');
  assert.equal(p.parseUnitsText('-1.5', 18), null);
  assert.equal(p.parseUnitsText('10,00', 6), null, 'commas that do not group thousands');
  assert.equal(p.parseUnitsText('1,000,000', null), 1_000_000n, 'raw units may be grouped too');
  // Changed on purpose 2026-11-02 (review M4): one group and no dot is 1 or 1000, never guessed (tests/v2/typed-figure.test.mjs).
  assert.equal(p.parseUnitsText('1,000', null), null);
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
  // Changed on purpose 2026-10-30 (QA round 2, N2): the fee format of every other screen (lib/read/screens/fee.ts
  // fixedFeePercent), at least two decimals ("0.30%", "1.00%"), never "0.3%" beside "0.30%".
  assert.deepEqual([p.feeTierText(3000), p.feeTierText(500), p.feeTierText(100), p.feeTierText(200), p.feeTierText(10000)], ['0.30%', '0.05%', '0.01%', '0.02%', '1.00%']);
  assert.deepEqual([p.feeTierText(50), p.feeTierText(1), p.feeTierText(2690), p.feeTierText(8000), p.feeTierText(0)], ['0.005%', '0.0001%', '0.269%', '0.80%', '0.00%']);
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
  // Changed on purpose 2026-10-30 (QA round 2, N2: "1,590.87" beside "3,411.8"): two decimals from 1,000 up; at least two
  // from 1 to 1,000 (six significant digits); below 1 as before.
  assert.equal(p.priceText(3411.8), '3,411.80');
  assert.equal(p.priceText(1590.87), '1,590.87');
  assert.equal(p.priceText(1234567.891), '1,234,567.89');
  assert.equal(p.priceText(3.4), '3.40');
  assert.equal(p.priceText(1), '1.00');
  assert.equal(p.priceText(1.00045), '1.00045');
  assert.equal(p.priceText(999.9999), '1,000.00');
  assert.equal(p.priceText(0.5), '0.5');
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

// Added 2026-10-06 (the owner's point 4: no 18-digit amounts on screen): an amount shows at most 6 decimals, rounded
// down; its title says every digit (EXACT_FRACTION), whatever the token's decimals.
test('rounding defaults: at most 6 decimals shown, every digit in the exact form', () => {
  assert.equal(p.SHOWN_FRACTION, 6);
  assert.equal(p.formatUnitsText(99_395_417_139_745_917n, 18), '0.099395', 'the owner’s print: 0.099395417139745917 WETH');
  assert.equal(p.formatUnitsText(99_395_417_139_745_917n, 18, p.EXACT_FRACTION), '0.099395417139745917');
  assert.equal(p.formatUnitsText(99_571_446n, 6), '99.571446', 'six decimals keep a 6-decimal token exact (spec §3.5’s 99.571446 USDG)');
  assert.equal(p.formatUnitsText(3_250_000n, 6, p.EXACT_FRACTION), '3.25', 'trailing zeros dropped in the exact form too');
  assert.equal(p.formatUnitsText(1n, 30, p.EXACT_FRACTION), `0.${'0'.repeat(29)}1`, 'more than 18 decimals, still exact');
});

// Added 2026-10-06 (the review of point 4, the study's correction: rounding down suits "about" and "at least", never a
// fee or an amount to allow): `round` 'up' raises the last digit shown whenever a digit is dropped.
test('a fee or an amount to allow rounds up: never shown lower than it is; nothing changes when no digit is dropped', () => {
  assert.equal(p.formatUnitsText(8_024_690_700_000_000n, 18, p.SHOWN_FRACTION, 'up'), '0.008025', 'the review’s 0.0080246907 WETH');
  assert.equal(p.formatUnitsText(8_024_690_700_000_000n, 18), '0.008024', 'rounded down by default');
  assert.equal(p.formatUnitsText(3_250_000n, 6, p.SHOWN_FRACTION, 'up'), '3.25', 'exact already: as it is');
  assert.equal(p.formatUnitsText(1_000_000_000n, 6, p.SHOWN_FRACTION, 'up'), '1,000');
  assert.equal(p.formatUnitsText(999_999_999_999_999_999n, 18, p.SHOWN_FRACTION, 'up'), '1', 'carried into the whole');
  assert.equal(p.formatUnitsText(1n, 18, p.SHOWN_FRACTION, 'up'), '0.000001', 'the smallest figure shown, never "<0.000001"');
  assert.equal(p.formatUnitsText(0n, 18, p.SHOWN_FRACTION, 'up'), '0');
  assert.equal(p.formatUnitsText(123n, null, p.SHOWN_FRACTION, 'up'), '123', 'raw units are exact');
  assert.equal(p.formatUnitsText(1_999_999_999_999_999_999n, 18, 4, 'up'), '2');
  assert.equal(p.formatUnitsText(5n, 0, p.SHOWN_FRACTION, 'up'), '5', 'a token without decimals');
});

// Added 2026-10-06 (the owner's point 4): Review's one network fee line.
test('the one network fee line: the plan’s cost “about”, a batch’s ceiling “up to”, else unknown; the L1 part flagged when the plan could not read it', () => {
  // Robinhood: a measured zero L1 fee is a figure like any other (spec §2.4), nothing to flag.
  const robinhood = p.planNetworkCost({ gasUnits: 500_000n, feePerGas: 10n, l1: { source: 'nitro_node_interface', wei: 0n, l1GasUnits: 0n } });
  assert.deepEqual(p.networkFeeLine({ cost: robinhood, l1Available: true, batchFee: null }), { kind: 'about', wei: 5_000_000n, ceiling: null, l1Missing: false, othersMissing: false });
  // Base without its L1 data fee: the total is the L2 part alone, and the line says the L1 part is missing (never 0).
  const base = p.planNetworkCost({ gasUnits: 500_000n, feePerGas: 10n, l1: null });
  assert.deepEqual(p.networkFeeLine({ cost: base, l1Available: false, batchFee: 9n }), { kind: 'about', wei: 5_000_000n, ceiling: null, l1Missing: true, othersMissing: false }, 'the plan’s own cost wins over a batch ceiling');
  // Before the wallet's fee per gas is known: a batch's own ceiling (its calls together, L1 ceiling included), else nothing.
  assert.deepEqual(p.networkFeeLine({ cost: null, l1Available: true, batchFee: 7_000_000n }), { kind: 'upTo', wei: 7_000_000n, ceiling: null, l1Missing: false, othersMissing: false });
  assert.deepEqual(p.networkFeeLine({ cost: null, l1Available: false, batchFee: null }), { kind: 'unknown' });
});

// Added 2026-10-06 (the review of point 4): an approval is a wallet transaction of its own, so the one line counts the
// approvals still to send, each at its prepared figure; one not prepared yet is flagged (a dash on screen), never left
// out; Base's ceiling under Details carries the same approvals, so it is never below the line in view.
test('the one network fee line counts the approvals still to send; one not prepared yet is flagged, never left out', () => {
  const robinhood = p.planNetworkCost({ gasUnits: 500_000n, feePerGas: 200_000_000n, l1: { source: 'nitro_node_interface', wei: 0n, l1GasUnits: 0n } });
  // The journey's own test (c): 0.0001 ETH for the plan, and the approval prepared at 600,000 gas × 0.2 gwei.
  assert.deepEqual(p.networkFeeLine({ cost: robinhood, l1Available: true, batchFee: null, others: [120_000_000_000_000n] }), { kind: 'about', wei: 220_000_000_000_000n, ceiling: null, l1Missing: false, othersMissing: false });
  assert.equal(p.ethAboutText(220_000_000_000_000n), '0.00022 ETH');
  // Two tokens to allow: the second is prepared only once the first is on chain.
  assert.deepEqual(p.networkFeeLine({ cost: robinhood, l1Available: true, batchFee: null, others: [120_000_000_000_000n, null] }), { kind: 'about', wei: 220_000_000_000_000n, ceiling: null, l1Missing: false, othersMissing: true });
  // Base: its ceiling with the same approvals.
  const base = p.planNetworkCost({ gasUnits: 500_000n, feePerGas: 10n, l1: { source: 'op_gas_price_oracle', wei: 1_000n, upperBoundWei: 4_000n } });
  assert.deepEqual(p.networkFeeLine({ cost: base, l1Available: true, batchFee: null, others: [700n] }), { kind: 'about', wei: 5_001_700n, ceiling: 5_004_700n, l1Missing: false, othersMissing: false });
  // feesToCome: the transactions other than the action, still to be included; a signature costs nothing.
  const step = (kind, status, feeWei = null) => ({ kind, status, feeWei });
  assert.deepEqual(p.feesToCome([step('approve', 'ready', 9n), step('action', 'waiting')]), [9n]);
  assert.deepEqual(p.feesToCome([step('approve-reset', 'included', 5n), step('approve', 'preparing'), step('sign-permit', 'waiting'), step('action', 'waiting', 99n)]), [null], 'one on chain is paid; one not prepared yet is null');
  assert.deepEqual(p.feesToCome([step('approve-nft', 'ready', 3n), step('action', 'ready', 7n)]), [3n], 'the position’s approval too');
  assert.deepEqual(p.feesToCome([step('batch', 'ready', 11n)]), [], 'a batch is its own figure');
  assert.deepEqual(p.feesToCome([step('approve', 'finalized', 4n), step('approve', 'sent', 6n)]), [6n], 'one sent but not included yet still counts');
});

// Added 2026-10-06 (the review of point 4, ux #1: one network fee line, never "+ other steps —"): the approvals after the
// current step are read at the review for their fee only, one after another; one that cannot be read yet stays null (the
// line then says the rest in words), and a new quote stops the reads.
test('the approvals still to come are read at the review for their fee: later ones only, a failure left unread, stopped by a new quote', async () => {
  const step = (kind, index, status = 'waiting', feeWei = null) => ({ kind, index, status, feeWei });
  const steps = [step('approve-reset', 0, 'preparing', 5n), step('approve', 1), step('approve', 2), step('approve-nft', 3), step('sign-permit', 4), step('action', 5)];
  const asked = [];
  await p.readFeesToCome(steps, 0, async (index) => {
    asked.push(index);
    if (index === 1) throw new Error('step_out_of_order');
    return BigInt(index) * 100n;
  }, () => true);
  assert.deepEqual(asked, [1, 2, 3], 'only the approvals after the current one: never a signature or the action');
  assert.deepEqual(steps.map((s) => s.feeWei), [5n, null, 200n, 300n, null, null], 'the approval after a reset to zero stays unread');
  assert.deepEqual(p.feesToCome(steps), [5n, null, 200n, 300n]);
  // One already read, or no longer waiting, is not asked again.
  const again = [];
  await p.readFeesToCome(steps, 0, async (index) => { again.push(index); return 1n; }, () => true);
  assert.deepEqual(again, [1], 'only the one still unread');
  // A new quote while a read is out: what comes back is dropped and nothing more is asked.
  let alive = true;
  const fresh = [step('approve', 0, 'preparing', 9n), step('approve', 1), step('approve', 2), step('action', 3)];
  const late = [];
  await p.readFeesToCome(fresh, 0, async (index) => { late.push(index); alive = false; return 7n; }, () => alive);
  assert.deepEqual([late, fresh.map((s) => s.feeWei)], [[1], [9n, null, null, null]]);
});

// Added 2026-10-06 (the review of the owner's point 5): Auto-exit at New position's success on every network: never for a
// range covering every price (nothing to close it at), recommended for a range beside the price (a buy or a sell).
test('Auto-exit at the success: none for a full range, recommended beside the price, offered around it or with no price', () => {
  // Spacing 10: the usable ends are -887270 and 887270.
  assert.equal(p.exitOffer(-887270, 887270, 10, 0), 'none', 'every price: no end to close at');
  assert.equal(p.exitOffer(-887272, 887272, 1, 5), 'none');
  assert.equal(p.exitOffer(-887260, 887270, 10, 0), 'offered', 'one end short of the edge can close');
  assert.equal(p.exitOffer(-200, 200, 10, 0), 'offered', 'the price inside');
  assert.equal(p.exitOffer(-200, 200, 10, -200), 'offered', 'at the lower tick is inside (v3 and v4 count it so)');
  assert.equal(p.exitOffer(-200, 200, 10, 200), 'recommended', 'at the upper tick is beside');
  assert.equal(p.exitOffer(100, 200, 10, 0), 'recommended', 'a sell range above the price');
  assert.equal(p.exitOffer(-200, -100, 10, 0), 'recommended', 'a buy range below the price');
  assert.equal(p.exitOffer(100, 200, 10, null), 'offered', 'an unknown price: offered, never recommended');
});

// Added 2026-10-06 (the owner's point 4: a small cue, never a blank).
test('a review kept while the same choices are quoted again: the last one, stale; nothing for new choices or a first quote', () => {
  assert.deepEqual(p.keptWhileRequoting('now', true, 'last'), { shown: 'now', stale: false }, 'a review in hand is drawn as it is');
  assert.deepEqual(p.keptWhileRequoting(null, true, 'last'), { shown: 'last', stale: true });
  assert.deepEqual(p.keptWhileRequoting(null, false, 'last'), { shown: null, stale: false }, 'a quote for new choices starts blank');
  assert.deepEqual(p.keptWhileRequoting(null, true, null), { shown: null, stale: false }, 'nothing to keep');
});

test('spans and ETH fees (rounded up)', () => {
  assert.deepEqual([p.spanText(59), p.spanText(600), p.spanText(3900), p.spanText(7200)], ['59 s', '10 min', '1 h 5 min', '2 h']);
  assert.equal(p.ethText(48_000_000_000_000n), '0.000048 ETH');
  assert.equal(p.ethText(1n), '0.00000001 ETH', 'a ceiling is never shown lower');
  assert.equal(p.ethText(0n), '0 ETH');
  // Added 2026-10-06 (the owner's point 4): an estimate said "about", three significant digits, to the nearest.
  assert.equal(p.ethAboutText(100_020_000_000_000n), '0.0001 ETH', 'not 0.00010002');
  assert.equal(p.ethAboutText(123_456_789_012_345n), '0.000123 ETH');
  assert.equal(p.ethAboutText(999_600_000_000_000n), '0.001 ETH', 'rounded to the nearest, carried over');
  assert.equal(p.ethAboutText(1_234_000_000_000_000_000n), '1.23 ETH');
  assert.equal(p.ethAboutText(55n), '0.000000000000000055 ETH', 'a figure with three digits or fewer stays as it is');
  assert.equal(p.ethAboutText(0n), '0 ETH');
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
