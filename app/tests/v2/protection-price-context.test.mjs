import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { exitReferencePrice, exitShortcutPrice, exitPriceDistance, reorientExitForm, positionExitPrice, exitTokenMeta } = require('../../.test-build/app/src/v2in/autoexit/priceContext.js');
const { defaultMandateForm, mandateTermsFrom } = require('../../.test-build/app/src/v2in/autoexit/form.js');
const { sqrtPriceX96FromPrice } = require('../../.test-build/app/src/v2/trigger.js');
const decimals = { decimals0: 18, decimals1: 6 };
const pool = { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x0000000000000000000000000000000000000001' };

test('position reference stays tied to its own chain read, even when an order cannot currently be offered', () => {
  // A USDG / arbitrary ERC-20 pair as /state and WalletPosition actually carry it: decimals differ,
  // the stable is currency0, and the user-facing quote is inverted from the pool integer.
  const result = sqrtPriceX96FromPrice('0.0956429', { decimals0: 6, decimals1: 18 }, 'token0PerToken1');
  assert.equal(result.ok, true);
  const read = { sqrtPriceX96: result.sqrtPriceX96.toString() };
  const snapshot = positionExitPrice(read, { block: 1356798, saved: false });
  assert.equal(exitReferencePrice(snapshot, { decimals0: 6, decimals1: 18 }, 'token0PerToken1'), '0.0956429');
  assert.equal(snapshot.block, 1356798);
  assert.equal(snapshot.saved, false);
  assert.deepEqual(positionExitPrice(read, { block: 1356798, saved: true }), { ...snapshot, saved: true });
  assert.equal(positionExitPrice(null, { block: 999, saved: false }), null, 'another page with no position never inherits a price');
  assert.equal(positionExitPrice({ sqrtPriceX96: null }, null), null);
  assert.equal(positionExitPrice(read, null).saved, true, 'missing provenance cannot become a current price');
});

test('missing page decimals can be completed by the same indexed token, never another address or a guessed 18', () => {
  const partial = { address: pool.currency1, symbol: 'ORB', decimals: null };
  const indexed = { ...partial, decimals: 18 };
  assert.deepEqual(exitTokenMeta(partial, indexed), indexed);
  assert.deepEqual(exitTokenMeta({ ...partial, decimals: 0 }, indexed), { ...partial, decimals: 0 });
  assert.deepEqual(exitTokenMeta(partial, { ...indexed, address: pool.currency0 }), partial);
  assert.deepEqual(exitTokenMeta(partial, null), partial);
  assert.equal(exitTokenMeta(null, null), null);
});

test('protection reference uses the pool integer and actual decimals in either orientation; missing data is never zero', () => {
  const result = sqrtPriceX96FromPrice('2500', decimals, 'token1PerToken0');
  assert.equal(result.ok, true);
  const snapshot = { sqrtPriceX96: result.sqrtPriceX96.toString(), block: 123, saved: false };
  assert.equal(exitReferencePrice(snapshot, decimals, 'token1PerToken0'), '2500');
  assert.equal(exitReferencePrice(snapshot, decimals, 'token0PerToken1'), '0.0004');
  assert.equal(exitReferencePrice(null, decimals, 'token1PerToken0'), null);
  assert.equal(exitReferencePrice({ ...snapshot, sqrtPriceX96: '0' }, decimals, 'token1PerToken0'), null);
  assert.equal(exitReferencePrice(snapshot, { decimals0: null, decimals1: 6 }, 'token1PerToken0'), null);
});

test('explicit percentage shortcuts produce exact decimal prices and never invent an unavailable reference', () => {
  assert.equal(exitShortcutPrice('2500', 'falls', 10), '2250');
  assert.equal(exitShortcutPrice('0.0004', 'rises', 20), '0.00048');
  assert.equal(exitShortcutPrice(null, 'falls', 10), null);
  assert.equal(exitShortcutPrice('0', 'falls', 10), null);
  assert.equal(exitShortcutPrice('2500', 'falls', 100), null);
  assert.deepEqual(exitPriceDistance('2250', '2500'), { text: '−10% from pool price', percent: -10 });
  assert.equal(exitPriceDistance('', '2500'), null);
});

test('switching units keeps both signed trigger integers and swaps direction, without losing a single-sided exit', () => {
  for (const prices of [{ fallsTo: '2000', risesTo: '3200' }, { fallsTo: '0.0000357', risesTo: '' }]) {
    const original = { ...defaultMandateForm('token1PerToken0'), ...prices };
    const before = mandateTermsFrom(original, pool, decimals, 123);
    assert.equal(before.ok, true);
    const inverted = reorientExitForm(original, decimals, 'token0PerToken1');
    assert.ok(inverted);
    const after = mandateTermsFrom(inverted, pool, decimals, 123);
    assert.equal(after.ok, true);
    assert.equal(after.terms.triggerBelowSqrtPriceX96, before.terms.triggerBelowSqrtPriceX96);
    assert.equal(after.terms.triggerAboveSqrtPriceX96, before.terms.triggerAboveSqrtPriceX96);
    if (!original.risesTo) assert.equal(inverted.fallsTo, '');
    const back = reorientExitForm(inverted, decimals, 'token1PerToken0');
    const roundTrip = mandateTermsFrom(back, pool, decimals, 123);
    assert.equal(roundTrip.terms.triggerBelowSqrtPriceX96, before.terms.triggerBelowSqrtPriceX96);
    assert.equal(roundTrip.terms.triggerAboveSqrtPriceX96, before.terms.triggerAboveSqrtPriceX96);
  }
  const invalid = { ...defaultMandateForm('token1PerToken0'), fallsTo: 'unfinished.' };
  assert.equal(reorientExitForm(invalid, decimals, 'token0PerToken1'), null);
  assert.equal(invalid.fallsTo, 'unfinished.', 'an incomplete typed value is not silently cleared');
});
