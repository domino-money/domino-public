import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { fundingNeverSent, canDiscardFunding, fundingDepositKey, fundingTerminal, fundingOwnsDeposit, fundingFinished, openHoldFor } = require('../../.test-build/app/src/v2in/funds/fundingLifecycle.js');
const { parseFunding } = require('../../.test-build/app/src/v2in/funds/fundingIntent.js');
const OWNER = `0x${'11'.repeat(20)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const empty = { running: false, deposits: 0, pending: 0, unsettled: 0 };
const intent = (state = 'ready', hash = null) => ({
  version: 1, id: 'previous-position', owner: OWNER, destinationChainId: 4663,
  destinationToken: '0x0000000000000000000000000000000000000000', scope: 'pool-A:range:10',
  requiredRaw: '1000', createdAt: 1,
  legs: [{ id: 'arb', originChainId: 42161, originToken: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH', decimals: 18, maxInputRaw: '1200', minimumOutputRaw: '1000',
    destinationGas: false, state, depositTxHash: hash }],
});

test('an accepted but never sent request can be replaced only for a different position scope', () => {
  for (const state of ['ready', 'stopped']) {
    const old = intent(state);
    assert.equal(fundingNeverSent(old), true);
    assert.equal(canDiscardFunding(old, 'pool-B:range:10', empty), true);
    assert.equal(canDiscardFunding(old, old.scope, empty), false, 'same-scope resumable consent is preserved');
  }
  assert.equal(canDiscardFunding(null, 'pool-B:range:10', empty), false);
});

test('a send, unresolved wallet prompt, known hash or completed transfer is never classified as an unsent quote', () => {
  for (const state of ['sending', 'unknown', 'sent', 'settled']) {
    assert.equal(fundingNeverSent(intent(state)), false, state);
    assert.equal(canDiscardFunding(intent(state), 'pool-B', empty), false, state);
  }
  for (const state of ['ready', 'stopped']) {
    assert.equal(canDiscardFunding(intent(state, HASH), 'pool-B', empty), false, `${state} with a hash is retained`);
  }
  const partial = intent('stopped');
  partial.legs.push({ ...intent('sent', HASH).legs[0], id: 'already-sent', originChainId: 8453 });
  assert.equal(canDiscardFunding(partial, 'pool-B', empty), false, 'a remaining stopped leg cannot erase the sent leg');
});

test('each freshly read journal and an active run prevents cleanup, even if intent metadata still says ready', () => {
  for (const source of ['deposits', 'pending', 'unsettled']) {
    assert.equal(canDiscardFunding(intent(), 'pool-B', { ...empty, [source]: 1 }), false, source);
  }
  assert.equal(canDiscardFunding(intent(), 'pool-B', { ...empty, running: true }), false);
  assert.equal(fundingNeverSent({ ...intent(), legs: [] }), false, 'an empty/corrupt intent is not proof that nothing was sent');
});

test('a restored sending state becomes unknown and cannot be discarded after switching pools', () => {
  const restored = parseFunding(JSON.stringify(intent('sending')), OWNER, 4663);
  assert.equal(restored.legs[0].state, 'unknown');
  assert.equal(canDiscardFunding(restored, 'pool-B', empty), false);
});

test('the frozen position payment excludes gas and survives storage without changing the transfer budget', () => {
  const stored = { ...intent('settled', HASH), paymentRaw: '900', secretQuote: { calldata: 'must be removed' } };
  const restored = parseFunding(JSON.stringify(stored), OWNER, 4663);
  assert.equal(restored.requiredRaw, '1000');
  assert.equal(restored.paymentRaw, '900');
  assert.equal(restored.secretQuote, undefined);
  assert.equal(parseFunding(JSON.stringify(intent()), OWNER, 4663).paymentRaw, undefined, 'legacy intents remain readable');
});

test('untrusted payment metadata cannot spend the gas reserve or inject non-integer amounts', () => {
  for (const paymentRaw of [null, 900, '', '0', '-1', '01', '1.5', '1e2', '1001', '9'.repeat(79), {}, []]) {
    assert.equal(parseFunding(JSON.stringify({ ...intent(), paymentRaw }), OWNER, 4663), null, JSON.stringify(paymentRaw));
  }
  assert.equal(parseFunding(JSON.stringify({ ...intent(), paymentRaw: '1000' }), OWNER, 4663).paymentRaw, '1000');
});

const record = (lastState = 'filled') => ({ provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: HASH, requestId: null, lastState });

test('arrival ownership requires the exact intent hash, origin and destination, never just the wallet network', () => {
  assert.equal(fundingOwnsDeposit(null, record()), false);
  assert.equal(fundingOwnsDeposit(intent('sent', HASH), record()), true);
  for (const changed of [{ originChainId: 8453 }, { destinationChainId: 8453 }, { depositTxHash: `0x${'cd'.repeat(32)}` }]) {
    assert.equal(fundingOwnsDeposit(intent('sent', HASH), { ...record(), ...changed }), false);
    assert.notEqual(fundingDepositKey(record()), fundingDepositKey({ ...record(), ...changed }));
  }
});

test('completed earlier funding can be retired without erasing public hashes, but pending/unknown cannot', () => {
  for (const lastState of ['filled', 'refunded']) {
    assert.equal(fundingTerminal(lastState), true);
    assert.equal(fundingFinished(intent('sent', HASH), [record(lastState)]), true);
  }
  for (const lastState of [null, 'awaiting_deposit', 'pending', 'failed', 'refund_pending', 'refund_failed']) {
    assert.equal(fundingTerminal(lastState), false);
    assert.equal(fundingFinished(intent('sent', HASH), [record(lastState)]), false);
  }
  assert.equal(fundingFinished(intent('unknown'), [record()]), false, 'an unrelated terminal receipt never releases an unknown wallet request');
  assert.equal(fundingFinished(intent('sent', HASH), [{ ...record(), originChainId: 8453 }]), false);
  assert.equal(fundingFinished(intent('settled', HASH), []), true, 'already reconciled metadata can retire after the user removed its journal row');
  assert.equal(fundingFinished(intent('settled'), []), false, 'corrupt metadata without a transaction is not a completed transfer');
  assert.equal(fundingFinished({ ...intent('settled', HASH), legs: [] }, []), false);
});

// Added 2026-11-02 (review A2): a hold of the wallet, of any origin and destination, and a deposit marked "may have gone"
// for good, kept every later transfer of this wallet on "Waiting for funds…" after its funds arrived.
test('only a step still open in the wallet for this destination holds its arrival and its cleanup', () => {
  const hold = (state, destinationChainId) => ({ originChainId: 42161, nonce: '3', kind: 'deposit', quote: `${'ab'.repeat(32)}:1`, provider: 'relay', destinationChainId, at: 1, state });
  assert.equal(openHoldFor([hold('open', 4663)], 4663), true, 'open, here');
  assert.equal(openHoldFor([hold('passed', 4663)], 4663), false, 'a deposit that may have gone is said by its own card, with Remove');
  assert.equal(openHoldFor([hold('open', 8453)], 4663), false, 'another destination’s');
  assert.equal(openHoldFor([hold('passed', 8453), hold('open', 4663)], 4663), true);
  assert.equal(openHoldFor([], 4663), false);
});
