import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { usdOfPoolAmounts, usdOfRaw } = require('../../.test-build/app/src/v2in/usd.js');
const { usdOf } = require('../../.test-build/app/src/components/create/valuation.js');
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
