import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { settleStep, RECEIPT_WAIT_MS } = require('../.test-build/app/src/finance/receiptWait.js');
const { createSequenceClient, sequenceReceiptReadRetryable } = require('../.test-build/app/src/finance/sequence.js');
const hash = `0x${'ab'.repeat(32)}`;
const time = () => { let now = 0; return { now: () => now, wait: async ms => { now += ms; } }; };
async function transportFailure(code) {
  const client = createSequenceClient({ current: () => true, request: async () => { throw Object.assign(new Error('private provider detail'), { code }); } }, { codeHashes: {} });
  return client.receipt(hash).catch(error => error);
}

test('receipt transport failure is normalized and the same sent hash recovers without another send', async () => {
  const failure = await transportFailure(), hashes = [];
  assert.equal(sequenceReceiptReadRetryable(failure), true);
  assert.equal(failure.message.includes('private'), false);
  const client = { receipt: async value => { hashes.push(value); if (hashes.length === 1) throw failure; return { state: 'confirming' }; } };
  assert.equal(await settleStep(client, hash, () => true, time()), 'landed');
  assert.deepEqual(hashes, [hash, hash]);
});

test('receipt polling has a fixed deadline and leaving prevents further reads', async () => {
  const failure = await transportFailure(), clock = time(); let calls = 0;
  const client = { receipt: async () => { calls++; throw failure; } };
  await assert.rejects(settleStep(client, hash, () => true, clock), error => error === failure);
  assert.equal(clock.now(), RECEIPT_WAIT_MS);
  assert.equal(calls, 79);
  const before = calls;
  assert.equal(await settleStep(client, hash, () => false, time()), 'left');
  assert.equal(calls, before);
  let here = true;
  assert.equal(await settleStep({ receipt: async () => { here = false; throw failure; } }, hash, () => here, time()), 'left');
});

test('receipt timeout distinguishes an observed pending state from an unreadable outcome', async () => {
  const failure = await transportFailure();
  for (const lastUnread of [false, true]) {
    let reads = 0;
    const clock = time();
    const client = { receipt: async () => {
      reads++;
      if (lastUnread ? reads > 1 : reads === 1) throw failure;
      return { state: 'pending' };
    } };
    await assert.rejects(settleStep(client, hash, () => true, clock), error =>
      lastUnread ? error === failure : error.message === 'sequence_receipt_waiting');
    assert.equal(clock.now(), RECEIPT_WAIT_MS, 'read failures never extend the original deadline');
    assert.equal(reads, 79);
  }
});

test('identity, malformed responses, reorgs, reverts and untrusted error text never trigger retries', async () => {
  for (const code of [4001, 4100, 4200, 4901]) assert.equal(sequenceReceiptReadRetryable(await transportFailure(code)), false);
  for (const message of ['receipt_identity_changed', 'invalid_receipt', 'wallet_identity_changed', 'sequence_receipt_rpc', 'wallet_timeout']) {
    let calls = 0; const error = new Error(message);
    assert.equal(sequenceReceiptReadRetryable(error), false);
    await assert.rejects(settleStep({ receipt: async () => { calls++; throw error; } }, hash, () => true, time()), value => value === error);
    assert.equal(calls, 1);
  }
  for (const state of ['reverted', 'reorged']) {
    await assert.rejects(settleStep({ receipt: async () => ({ state }) }, hash, () => true, time()), new RegExp(`sequence_step_${state}`));
  }
});
