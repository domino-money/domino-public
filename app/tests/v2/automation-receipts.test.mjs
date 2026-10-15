import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { reconcileAutomationReceipt } = require('../../.test-build/app/src/v2in/automate/receipt.js');
const HASH = `0x${'ab'.repeat(32)}`, BLOCK = `0x${'cd'.repeat(32)}`;
const receipt = { state: 'included', transactionHash: HASH, blockHash: BLOCK, blockNumber: 20n, events: [] };

// The session helpers are tested with the existing transaction client as their only dependency.
// Changed 2026-10-14 (incident C3): two pure modules the helpers now read are the real ones (the codes that end a wait
// and its 20 s, ../../src/v2in/receiptWait.ts; a transaction's explorer page, ../../src/v2/explorers.ts); every other
// import stays empty, as before. No assertion of the cases below changed.
// Changed on purpose 2026-10-15 (pack 8, incident C5): and the chains' receipt sources (../../src/config/receiptSources.ts),
// which say where a step's receipt is read in place of its chain id.
const PURE = { '../receiptWait': '../../.test-build/app/src/v2in/receiptWait.js', '../../v2/explorers': '../../.test-build/app/src/v2/explorers.js',
  '../../config/receiptSources': '../../.test-build/app/src/config/receiptSources.js' };
function sessionFunctions() {
  const ts = require('typescript'), mod = { exports: {} }, delays = [];
  let time = 0;
  const code = ts.transpileModule(readFileSync(new URL('../../src/v2in/automate/session.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'setTimeout', 'Date', code)((name) => PURE[name] ? require(PURE[name]) : ({}), mod, mod.exports,
    (fn, ms) => { time += ms; delays.push(ms); queueMicrotask(fn); return 0; }, { now: () => time });
  return { ...mod.exports, delays };
}
const session = { serial: work => work(), ensureChain: async () => {}, receiptAvailability: () => 'ready' };

test('a sent approval with temporarily unreadable confirmation can be checked again without preparing or sending twice', async () => {
  const run = sessionFunctions(), phases = [];
  let sends = 0, prepares = 0, reads = 0;
  const client = { send: async () => { sends++; return HASH; }, wasOffered: () => true,
    receipt: async hash => { assert.equal(hash, HASH); reads++; if (reads === 1) throw new Error('invalid_receipt'); return receipt; } };
  await assert.rejects(run.sendStep(session, client, async () => { prepares++; return {}; }, p => phases.push(p), () => true), run.SentStepError);
  const result = await run.resumeStep(session, client, HASH, p => phases.push(p));
  assert.equal(result.receipt.state, 'included');
  assert.equal(sends, 1); assert.equal(prepares, 1); assert.equal(reads, 2);
  assert.equal(phases.at(-1).phase, 'included');
});

test('receipt-only continuation honors Retry-After and pauses another chain without switching or sending', async () => {
  const run = sessionFunctions(); let availability = 0, reads = 0;
  const scoped = { ...session, ensureChain: async () => assert.fail('no wallet switch during continuation'),
    receiptAvailability: () => ++availability === 1 ? 'paused' : 'ready' };
  const client = { send: async () => assert.fail('never resend'), receipt: async () => {
    if (++reads === 1) throw { retryAfterMs: 17_000 };
    return receipt;
  } };
  await run.resumeStep(scoped, client, HASH, () => {});
  assert.equal(reads, 2); assert.ok(run.delays.includes(17_000));
  await assert.rejects(run.resumeStep({ ...scoped, receiptAvailability: () => 'gone' }, { receipt: () => assert.fail('previous account must not be read') }, HASH, () => {}), run.SentStepError);
});

// Added 2026-10-14 (incident C3: waiting never locks): sent 20 s ago and not in a block yet, the step says so once, with
// its explorer page, and is read on; the codes that end a wait are the ones New position and the position page use.
test('a sent step still waiting after 20 s says so once, with its explorer page, and is read on until its block', async () => {
  const run = sessionFunctions(), phases = [];
  const { v2TxUrl } = require('../../.test-build/app/src/v2/explorers.js');
  let reads = 0;
  const result = await run.resumeStep({ ...session, chainId: 4663 }, { receipt: async () => (++reads < 12 ? { state: 'pending' } : receipt) }, HASH, p => phases.push(p));
  assert.equal(result.receipt.state, 'included');
  assert.deepEqual(phases.filter(p => p.slow), [{ phase: 'sent', hash: HASH, slow: true, href: v2TxUrl(4663, HASH) }]);
  assert.equal(phases.at(-1).phase, 'included');
  const batches = [];
  await run.resumeBatchStep(session, { receipt: async () => (batches.length < 12 ? (batches.push(1), { state: 'pending' }) : receipt) }, 'known-batch', p => batches.push(p));
  assert.deepEqual(batches.filter(p => p.slow), [{ phase: 'sent', batchId: 'known-batch', slow: true }], 'a batch has no hash to link');
  for (const code of ['receipt_not_from_this_review', 'transaction_does_not_match_review', 'invalid_receipt', 'receipt_duplicate_action']) {
    await assert.rejects(run.resumeStep(session, { receipt: async () => { throw new Error(code); } }, HASH, () => {}), run.SentStepError, code);
  }
});

test('an unresolved batch resumes only its known identifier, and reverted/reorganized receipts never authorize the next step', async () => {
  const run = sessionFunctions(); let reads = 0;
  const batch = { prepareBatch: () => assert.fail('no prepare'), send: () => assert.fail('no send'),
    receipt: async id => { assert.equal(id, 'known-batch'); reads++; return receipt; } };
  assert.equal((await run.resumeBatchStep(session, batch, 'known-batch', () => {})).receipt.state, 'included');
  assert.equal(reads, 1);
  for (const state of ['reverted', 'reorged']) {
    await assert.rejects(run.resumeStep(session, { receipt: async () => ({ ...receipt, state }) }, HASH, () => {}), run.SentStepError);
  }
});

test('Robinhood keeps confirming through its existing independent reader after the wallet disconnects or changes chain', async () => {
  const run = sessionFunctions();
  for (const availability of ['gone', 'paused']) {
    const scoped = { ...session, chainId: 4663, receiptAvailability: () => availability,
      ensureChain: () => assert.fail('no wallet request for Robinhood receipt continuation') };
    assert.equal((await run.resumeStep(scoped, { receipt: async () => receipt }, HASH, () => {})).receipt.state, 'included');
    assert.equal((await run.resumeBatchStep(scoped, { receipt: async () => receipt }, 'known-batch', () => {})).receipt.state, 'included');
  }
});

test('Base and Arbitrum automation finality updates the shared exact receipt after its screen has gone', () => {
  for (const chainId of [8453, 42161]) {
    const operation = { chainId, wallet: `0x${'01'.repeat(20)}`, positionManager: `0x${'02'.repeat(20)}`, vault: `0x${'03'.repeat(20)}`,
      tokenIds: ['6238157'], hash: HASH, blockHash: BLOCK, block: 20, phase: 'included', events: [{ eventName: 'VaultCreated' }] };
    const records = [], reorgs = [];
    const apply = next => reconcileAutomationReceipt(operation, next, value => records.push(value), value => reorgs.push(value));
    assert.equal(apply({ state: 'pending' }), false);
    assert.equal(apply(receipt), false); assert.equal(records.length, 0);
    assert.equal(apply({ ...receipt, state: 'finalized' }), true);
    assert.equal(records[0].chainId, chainId); assert.equal(records[0].receipt.state, 'finalized');
    assert.deepEqual(records[0].tokenIds, operation.tokenIds); assert.equal(records[0].vault, operation.vault);
    assert.deepEqual(records[0].receipt.events, operation.events); assert.equal(reorgs.length, 0);
    for (const changed of [{ blockHash: `0x${'ef'.repeat(32)}` }, { blockNumber: 21n }, { transactionHash: `0x${'ee'.repeat(32)}` }, { state: 'reorged' }]) {
      assert.equal(apply({ ...receipt, ...changed }), true);
      assert.equal(records.length, 1, 'changed canonical identity cannot invent final proof');
    }
    assert.equal(reorgs.length, 4);
    assert.ok(reorgs.every(value => value.chainId === chainId && value.wallet === operation.wallet && value.hash === HASH && value.blockHash === BLOCK));
    for (const current of [null, { ...operation, phase: 'finalized' }, { ...operation, phase: 'reorged' },
      { ...operation, wallet: `0x${'09'.repeat(20)}` }, { ...operation, blockHash: `0x${'09'.repeat(32)}` }]) {
      assert.equal(reconcileAutomationReceipt(operation, { ...receipt, state: 'finalized' },
        () => assert.fail('stale reads must not overwrite newer proof'), () => assert.fail('stale reads must not invalidate newer proof'), current), true);
    }
  }
});
