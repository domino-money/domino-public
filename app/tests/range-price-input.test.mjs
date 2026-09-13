import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { priceInputToTick, editablePrice } = require('../.test-build/app/src/lib/read/screens/RangePriceInput.js');
const { sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const range = { lower: -600, upper: 600 };
const price = { state: 'usable', tick: 0, tickSpacing: 60, decimals: [18, 18] };

// Q192 has a finite decimal expansion. This is an exact boundary value,
// independent of the UI's approximate six-significant-digit formatting.
function exactTickPrice(tick) {
  const sqrt = sqrtPriceAtTick(tick);
  const digits = (sqrt * sqrt * 5n ** 192n).toString().padStart(193, '0');
  return `${digits.slice(0, -192)}.${digits.slice(-192)}`;
}

test('decimal price snaps outward to a valid tick spacing without a Number price conversion', () => {
  assert.deepEqual(priceInputToTick('1.001', 'lower', range, price), { ok: true, tick: 0 });
  assert.deepEqual(priceInputToTick('1.001', 'upper', range, price), { ok: true, tick: 60 });
  assert.deepEqual(priceInputToTick('0.999', 'lower', range, price), { ok: true, tick: -60 });
  assert.deepEqual(priceInputToTick('0.999', 'upper', range, price), { ok: true, tick: 0 });
});

test('exact TickMath boundaries remain at the boundary on both sides', () => {
  for (const tick of [-540, -60, 0, 60, 540]) {
    for (const which of ['lower', 'upper']) {
      assert.deepEqual(priceInputToTick(exactTickPrice(tick), which, range, price), { ok: true, tick });
    }
  }
});

test('human decimals are applied in the correct quote per base direction', () => {
  assert.deepEqual(priceInputToTick('1000000000000', 'lower', range, { ...price, decimals: [18, 6] }), { ok: true, tick: 0 });
  assert.deepEqual(priceInputToTick('0.000000000001', 'upper', range, { ...price, decimals: [6, 18] }), { ok: true, tick: 0 });
  assert.deepEqual(priceInputToTick('1', 'lower', range, { ...price, decimals: [0, 0] }), { ok: true, tick: 0 });
});

test('invalid, zero, overlong and outside-range prices are rejected', () => {
  for (const value of ['', '0', '-1', '1e3', '1,000', ' 1', '1 ', '01', '1.', '.5', '9'.repeat(321), '0.' + '0'.repeat(99) + '1', '9'.repeat(100)]) {
    assert.equal(priceInputToTick(value, 'lower', range, price).ok, false, value);
  }
});

test('an input cannot silently move or cross the opposite bound', () => {
  assert.match(priceInputToTick('2', 'lower', range, price).message, /below max/);
  assert.match(priceInputToTick('0.5', 'upper', range, price).message, /above min/);
  assert.deepEqual(range, { lower: -600, upper: 600 });
});

test('display decorations are stripped only for editable presentation', () => {
  assert.equal(editablePrice('≈1,234.56'), '1234.56');
  assert.equal(editablePrice(null), '');
  assert.equal(editablePrice('≈0.000001'), '0.000001');
});
