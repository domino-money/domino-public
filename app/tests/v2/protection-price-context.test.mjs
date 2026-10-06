import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { positionExitPrice, exitTokenMeta, freshSqrtPrice, snapshotSqrtPrice } = require('../../.test-build/app/src/v2in/autoexit/priceContext.js');
const { sqrtPriceX96FromPrice } = require('../../.test-build/app/src/v2/trigger.js');
const pool = { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x0000000000000000000000000000000000000001' };

test('position reference stays tied to its own chain read, even when Auto-exit cannot currently be offered', () => {
  // A USDG / arbitrary ERC-20 pair as /state and WalletPosition actually carry it: decimals differ,
  // the stable is currency0, and the user-facing quote is inverted from the pool integer.
  const result = sqrtPriceX96FromPrice('0.0956429', { decimals0: 6, decimals1: 18 }, 'token0PerToken1');
  assert.equal(result.ok, true);
  const read = { sqrtPriceX96: result.sqrtPriceX96.toString() };
  const snapshot = positionExitPrice(read, { block: 1356798, saved: false });
  assert.equal(snapshot.sqrtPriceX96, read.sqrtPriceX96);
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

// Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit chooses its edges by the page's own current read only; an
// old copy could say an edge is still ahead when the price has crossed it, and arming it would close the position at once.
test('Auto-exit takes only the page\'s current read of the price: never a saved copy, never a missing or malformed one', () => {
  const sqrt = sqrtPriceX96FromPrice('2500', { decimals0: 18, decimals1: 6 }, 'token1PerToken0').sqrtPriceX96;
  assert.equal(freshSqrtPrice({ sqrtPriceX96: sqrt.toString(), block: 7, saved: false }), sqrt);
  assert.equal(freshSqrtPrice({ sqrtPriceX96: sqrt.toString(), block: 7, saved: true }), null, 'a saved copy');
  assert.equal(freshSqrtPrice({ sqrtPriceX96: null, block: 7, saved: false }), null);
  assert.equal(freshSqrtPrice({ sqrtPriceX96: '0', block: 7, saved: false }), null);
  assert.equal(freshSqrtPrice({ sqrtPriceX96: '12ab', block: 7, saved: false }), null);
  assert.equal(freshSqrtPrice(null), null);
  assert.equal(freshSqrtPrice(undefined), null);
});

// Changed on purpose 2026-10-06 (the review of point 5): the page's price only draws the dialog until the pool's own price,
// read through the wallet, is in (the edges a review arms are chosen against that one); under the preview, where nothing
// is armed, the page's read is all there is, saved or not, so the dialog never waits for a read that is not coming.
test('the page\'s price as a number, saved or not, for what the dialog shows before the pool\'s own price', () => {
  const sqrt = sqrtPriceX96FromPrice('2500', { decimals0: 18, decimals1: 6 }, 'token1PerToken0').sqrtPriceX96;
  assert.equal(snapshotSqrtPrice({ sqrtPriceX96: sqrt.toString(), block: 7, saved: true }), sqrt, 'a saved copy is still a number');
  assert.equal(snapshotSqrtPrice({ sqrtPriceX96: sqrt.toString(), block: 7, saved: false }), sqrt);
  for (const bad of [null, '0', '12ab', '-5']) assert.equal(snapshotSqrtPrice({ sqrtPriceX96: bad, block: 7, saved: false }), null, String(bad));
  assert.equal(snapshotSqrtPrice(undefined), null);
});
