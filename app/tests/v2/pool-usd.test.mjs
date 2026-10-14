import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { usdOfPoolAmounts, usdOfRaw, currentUsd, chainDollar, USD_CURRENT_SECONDS } = require('../../.test-build/app/src/v2in/usd.js');
const { usdOf } = require('../../.test-build/app/src/components/create/valuation.js');
const { basisOf, unitsText, valueUnits } = require('../../.test-build/app/src/components/positions/visual/value.js');
const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
const base = { amounts: [E18, 2n * E18], decimals: [18, 18], prices: ['3', '1.5'], sqrtPriceX96: 2n * Q96 };

test('two qualified prices keep the independent sum, ignoring the pool mark and its availability', () => {
  assert.deepEqual(usdOfPoolAmounts(base), { value: '6.000000000000000000', basis: 'qualified-prices' });
  assert.deepEqual(usdOfPoolAmounts({ ...base, sqrtPriceX96: null, allowPoolMark: false }), usdOfPoolAmounts(base));
  assert.equal(usdOfPoolAmounts({ ...base, decimals: [null, 18] }), null, 'missing required decimals cannot be replaced with the other qualified price');
});

test('one qualified currency marks principal and fees at this pool price in either direction', () => {
  const into0 = { ...base, prices: ['4000.12345678', null], amounts: [E18 / 2n, 2n * E18] };
  assert.deepEqual(usdOfPoolAmounts(into0), { value: '4000.123456780000000000', basis: 'pool-price', anchor: 0 });
  assert.deepEqual(usdOfPoolAmounts({ ...base, prices: [null, '0.5'], amounts: [E18, E18] }), { value: '2.500000000000000000', basis: 'pool-price', anchor: 1 });
  assert.deepEqual(usdOfPoolAmounts({ ...base, prices: [null, '0.5'], amounts: [E18 / 100n, E18 / 50n] }), { value: '0.030000000000000000', basis: 'pool-price', anchor: 1 });
});

test('a USDC anchor values an unpriced paired token without assigning it an independent price', () => {
  // A synthetic coherent USDC/token pool: 1 USDC = 100 token, expressed in raw units (6 versus 18 decimals).
  const source = { ...base, prices: ['1', null], decimals: [6, 18], amounts: [300_000n, 40n * E18], sqrtPriceX96: 10_000_000n * Q96 };
  const before = structuredClone(source);
  assert.deepEqual(usdOfPoolAmounts(source), { value: '0.700000000000000000', basis: 'pool-price', anchor: 0 });
  assert.equal(usdOfRaw(source.amounts.map((raw, index) => ({ raw, decimals: source.decimals[index], usd: source.prices[index] }))), null, 'independent token valuation stays unqualified');
  assert.deepEqual(source, before, 'the original null token price is preserved');
  assert.deepEqual(usdOfPoolAmounts({ ...source, decimals: [6, null] }), usdOfPoolAmounts(source), 'raw conversion does not guess the unpriced token decimals');
});

test('one-sided and zero amounts do not require an unrelated price or decimals', () => {
  assert.deepEqual(usdOfPoolAmounts({ ...base, prices: ['1', null], amounts: [0n, 4n * E18], decimals: [18, null] }), { value: '1.000000000000000000', basis: 'pool-price', anchor: 0 });
  assert.deepEqual(usdOfPoolAmounts({ ...base, prices: ['1', null], amounts: [E18, 0n], decimals: [18, null], sqrtPriceX96: null }), { value: '1.000000000000000000', basis: 'qualified-prices' });
  assert.deepEqual(usdOfPoolAmounts({ ...base, prices: [null, null], amounts: [0n, 0n], decimals: [null, null], sqrtPriceX96: null }), { value: '0.000000000000000000', basis: 'qualified-prices' });
  assert.equal(usdOfPoolAmounts({ ...base, amounts: null }), null, 'unread amounts are never zero');
});

test('no qualified anchor, invalid data, or a disallowed pool mark never produces a USD estimate', () => {
  const lone = { ...base, prices: ['1', null] };
  for (const prices of [[null, null], ['0', null], ['-1', null], ['not a price', null]]) {
    assert.equal(usdOfPoolAmounts({ ...base, prices }), null);
  }
  for (const sqrtPriceX96 of [null, 0n, -1n, 'unread', 1n << 160n]) assert.equal(usdOfPoolAmounts({ ...lone, sqrtPriceX96 }), null);
  for (const decimals of [null, -1, 1.5, 256, Infinity, NaN]) assert.equal(usdOfPoolAmounts({ ...lone, decimals: [decimals, 18] }), null);
  assert.equal(usdOfPoolAmounts({ ...lone, amounts: [-1n, E18] }), null);
  assert.equal(usdOfPoolAmounts({ ...lone, amounts: [E18, -1n] }), null);
  assert.equal(usdOfPoolAmounts({ ...lone, allowPoolMark: false }), null, 'hooked/unsupported pool cannot supply the mark');
});

test('changing the coherent pool observation changes the estimate without retaining a previous mark', () => {
  const source = { ...base, prices: ['1', null], amounts: [0n, 4n * E18] };
  assert.equal(usdOfPoolAmounts(source)?.value, '1.000000000000000000');
  assert.equal(usdOfPoolAmounts({ ...source, sqrtPriceX96: 4n * Q96 })?.value, '0.250000000000000000');
  assert.equal(usdOfPoolAmounts({ ...source, sqrtPriceX96: null }), null);
});

test('positions match the approved New position rule, including exact truncation, in both token orientations', () => {
  const currencies = [{ address: '0x' + '11'.repeat(20), decimals: 18 }, { address: '0x' + '22'.repeat(20), decimals: 18 }];
  for (const sqrtPriceX96 of [Q96 / 3n, Q96 * 2n + 179n]) {
    for (const prices of [['0.123456789876543210', null], [null, '4000.123456789876543210'], ['3.1', '4.2']]) {
      for (const amounts of [[E18 + 13n, 2n * E18 + 7n], [0n, E18], [E18, 0n]]) {
        const input = { ...base, prices, amounts, sqrtPriceX96 };
        const pool = { currencies, usdPrices: prices, sqrtPriceX96: String(sqrtPriceX96) };
        assert.equal(usdOfPoolAmounts(input)?.value, usdOf(pool, amounts));
      }
    }
  }
});

// Added 2026-10-14 (incident of 2026-10-13, package V1; the owner's decision D4): the one valuation a list row, the
// Robinhood page and the V2 page share. Current while the amounts and the prices are within about two minutes of each
// other; further apart nothing new is worked out (the last complete valuation is then shown with its time, valuation.ts).
const reading = { principal: [E18, 2n * E18], fees: [0n, E18], decimals: [18, 18], prices: ['3', '1.5'], sqrtPriceX96: 2n * Q96, readAt: 1_790_000_000, quotedAt: 1_790_000_090 };

test('one valuation: amounts read 90 s before their prices are still a current figure, dated by the older of the two', () => {
  assert.equal(USD_CURRENT_SECONDS, 120, 'about two minutes (decision D4)');
  assert.deepEqual(currentUsd(reading), {
    value: { value: '6.000000000000000000', basis: 'qualified-prices' },
    fees: { value: '1.500000000000000000', basis: 'qualified-prices' },
    at: 1_790_000_000,
  });
  assert.equal(currentUsd({ ...reading, readAt: 1_790_000_090, quotedAt: 1_790_000_000 }).at, 1_790_000_000, 'newer amounts than prices: still the older of the two');
  assert.notEqual(currentUsd({ ...reading, quotedAt: reading.readAt + USD_CURRENT_SECONDS }), null, 'two minutes apart, to the second');
});

test('one valuation: more than two minutes apart, or a side whose time is not known, works out nothing new', () => {
  assert.equal(currentUsd({ ...reading, quotedAt: reading.readAt + USD_CURRENT_SECONDS + 1 }), null, 'old amounts never meet new prices unsaid');
  assert.equal(currentUsd({ ...reading, readAt: reading.quotedAt + USD_CURRENT_SECONDS + 1 }), null, 'nor new amounts old prices');
  assert.equal(currentUsd({ ...reading, readAt: null }), null, 'a reading with no time is not current');
  assert.equal(currentUsd({ ...reading, quotedAt: null }), null, 'prices with no time are not current');
  assert.equal(currentUsd({ ...reading, readAt: NaN }), null);
});

test('one valuation: the same rule as usdOfPoolAmounts for each figure, the pool mark and a missing side included', () => {
  const marked = currentUsd({ ...reading, prices: ['4000.12345678', null], principal: [E18 / 2n, 2n * E18] });
  assert.deepEqual(marked.value, { value: '4000.123456780000000000', basis: 'pool-price', anchor: 0 });
  assert.deepEqual(marked.fees, usdOfPoolAmounts({ amounts: reading.fees, decimals: reading.decimals, prices: ['4000.12345678', null], sqrtPriceX96: reading.sqrtPriceX96 }));
  assert.equal(currentUsd({ ...reading, prices: ['4000', null], allowPoolMark: false }).value, null, 'a hooked pool gives no mark');
  const partial = currentUsd({ ...reading, principal: null });
  assert.equal(partial.value, null, 'unread principal is no figure, never a zero');
  assert.equal(partial.fees.value, '1.500000000000000000', 'and the fees are still worked out');
  assert.deepEqual(currentUsd({ ...reading, prices: [null, null] }), { value: null, fees: null, at: reading.readAt }, 'no basis: current, and no figure');
});

test('the chain dollar is Robinhood Chain USDG alone, and values a USDG pair exactly as the Robinhood page always has', () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  assert.equal(chainDollar(4663, USDG), '1');
  assert.equal(chainDollar(4663, USDG.toUpperCase().replace('0X', '0x')), '1', 'by address, any case');
  assert.equal(chainDollar(8453, USDG), null, 'the same address on another chain is not it');
  assert.equal(chainDollar(4663, '0x' + '00'.repeat(20)), null);
  // The page's own rule (components/positions/visual/value.ts): both amounts in USDG at the pool's price, 1 USDG = $1.
  const sqrtPriceX96 = 3926780305788164395585478n;
  const amounts = [E18 / 10n, 250_000_000n];
  const state = { currencies: [{ address: '0x' + '00'.repeat(20), symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }], sqrtPriceX96, block: 1 };
  const page = unitsText(valueUnits(basisOf(state), amounts));
  assert.deepEqual(usdOfPoolAmounts({ amounts, decimals: [18, 6], prices: [chainDollar(4663, state.currencies[0].address), chainDollar(4663, USDG)], sqrtPriceX96 }), { value: page, basis: 'pool-price', anchor: 1 });
});
