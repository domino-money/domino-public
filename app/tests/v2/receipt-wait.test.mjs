/**
 * Added 2026-10-14 (incident C3: waiting never locks; screens finish at inclusion). How the integrated screens wait for a
 * transaction the person sent (src/v2in/receiptWait.ts): which failures end a wait, and the pause before each read.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const wait = require('../../.test-build/app/src/v2in/receiptWait.js');

test('only the codes that say the transaction read back is not the one reviewed end a wait; every other failure is "ask again"', () => {
  for (const code of ['receipt_not_from_this_review', 'transaction_does_not_match_review', 'invalid_receipt', 'receipt_duplicate_action']) assert.equal(wait.receiptSettled(new Error(code)), true, code);
  // A refused, busy, lost or unreadable read, a wallet gone, busy or on another chain: asked again, never a lock.
  for (const code of ['confirmation_unavailable', 'confirmation_busy', 'confirmation_not_served', 'invalid_confirmation', 'invalid_confirmation_read', 'wallet_wrong_chain', 'wallet_identity_changed', 'wallet_action_busy', 'wallet_action_expired', 'wallet_timeout', 'connect_wallet', 'invalid_wallet_reply']) {
    assert.equal(wait.receiptSettled(new Error(code)), false, code);
  }
  for (const thrown of [null, undefined, 'invalid_receipt', { message: 'invalid_receipt' }, { retryAfterMs: 5000 }]) assert.equal(wait.receiptSettled(thrown), false);
});

test('the pause grows 0.4, 0.8, 1.5, 3, 5, then 10 s, up to a quarter more at random; a failure lifts it to 1 s, doubling to a minute', () => {
  const none = () => 0, half = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map((attempt) => wait.receiptPause(attempt, 0, none)), [400, 800, 1500, 3000, 5000, 10000, 10000, 10000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempt) => wait.receiptPause(attempt, 0, half)), [450, 900, 1688, 3375, 5625, 11250]);
  assert.ok([0, 5].every((attempt) => wait.receiptPause(attempt, 0, () => 0.99999) <= [400, 10000][attempt ? 1 : 0] * 1.25), 'never more than a quarter more');
  assert.ok(wait.receiptPause(0, 0, () => 5) <= 500 && wait.receiptPause(0, 0, () => -1) === 400, 'a stray random value stays within the quarter');
  // Failures in a row: never sooner than 1 s, then 2, 4 … a minute, and never under the pace itself.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 30].map((failures) => wait.receiptPause(0, failures, none)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(wait.receiptPause(5, 1, none), 10000);
  assert.equal(wait.RECEIPT_STILL_WAITING_MS, 20000);
});
