/**
 * Added 2026-10-14 (C3 review: the Robinhood path of Close positions had no test that ran its own code). A close in a
 * block is done and the next group may start; its intent waits among the included closes until the money client's own
 * read says it is final (src/v2in/lists/closeHold.ts, moved out of BulkClosePositions.tsx unchanged). On Robinhood Chain
 * that read is the settlement registered with the page's confirmation queue, and a block that leaves the chain sends the
 * close back to "Check status". The browser suite runs Close positions on Base only, and tests/v2/close-journal.test.mjs
 * wrote its own settlement.
 *
 * The module runs as the page builds it, over the real close journal (src/finance/v2/closeJournal.ts, with this test's
 * localStorage and locks) and the real confirmation queue (tests/v2/support/queue.mjs, on a fake clock); the local
 * receipts and the shared follow are recorded.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { confirmationQueue } from './support/queue.mjs';
const require = createRequire(import.meta.url);
const journal = require('../../.test-build/app/src/finance/v2/closeJournal.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const { createReceiptFollow } = require('../../.test-build/app/src/v2in/journey/receiptFollow.js');

const OWNER = '0x' + '1'.repeat(40);
const HASH = '0x' + 'a'.repeat(64), BLOCK_HASH = '0x' + 'b'.repeat(64), OTHER_BLOCK = '0x' + 'e'.repeat(64);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** Added 2026-10-14 (review of C3 on main): the shared follow itself (src/v2in/journey/receiptFollow.ts) on a fake clock. */
function followOn() {
  let now = 0;
  const timers = new Set();
  const follow = createReceiptFollow({ now: () => now, visible: () => true,
    set: (run, ms) => { const timer = { run, at: now + ms }; timers.add(timer); return timer; }, clear: (timer) => timers.delete(timer) });
  return { follow, now: () => now, async run(ms) {
    const end = now + ms;
    await flush();
    for (let timer = [...timers].sort((a, b) => a.at - b.at)[0]; timer && timer.at <= end; timer = [...timers].sort((a, b) => a.at - b.at)[0]) { timers.delete(timer); now = Math.max(now, timer.at); timer.run(); await flush(); }
    now = end;
  } };
}
const intentOn = (chainId, extra = {}) => ({ wallet: OWNER, chainId, positionManager: v2Chain(chainId).uniswap.v4.positionManager, dex: 4, tokenIds: ['11', '12'], data: '0x1234', nonce: '0x1', hash: null, ...extra });

function storage() {
  const rows = new Map(); let line = Promise.resolve();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(_key, fn) { const next = line.then(fn); line = next.catch(() => {}); return next; } } } });
  return () => { delete globalThis.localStorage; delete globalThis.navigator; };
}

/**
 * closeHold.ts over the queue `queue`, the real journal, and recorded local receipts and follows; with `shared` (a
 * followOn()), the shared follow itself runs them too, and the hold reads the time from its clock (or from `now`).
 * Changed 2026-10-14 (second review of C3 on main): the hold's clock, and the close's proof as the page builds it.
 */
function holdOver(queue, shared = null, now = shared?.now) {
  const local = [], forgotten = [], follows = [];
  const ts = require('typescript'), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../../src/v2in/lists/closeHold.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = {
    '../../finance/v2/closeJournal': journal,
    '../../lib/confirmedOperations': { recordConfirmedOperation: queue.store.record, subscribeConfirmedOperations: queue.store.subscribe, receiptFinality: queue.store.finality },
    '../journey/receiptFollow': { RECEIPT_FOLLOW: { follow: (key, job) => { follows.push({ key, job }); shared?.follow.follow(key, job); } } },
    './localReceipts': {
      LOCAL_RECEIPTS: { get: () => local },
      recordLocalClose: (item) => { const at = local.findIndex((one) => one.hash === item.hash); if (at >= 0) local[at] = item; else local.push(item); },
      forgetLocalClose: (...args) => forgotten.push(args),
    },
  };
  new Function('require', 'module', 'exports', code)((name) => deps[name] ?? {}, mod, mod.exports);
  return { hold: mod.exports.createCloseHold(OWNER, now), closeProof: mod.exports.closeProof, local, forgotten, follows };
}

test('Robinhood Chain: a close in a block is held until the queue proves it final, then the money client’s own read settles it', async () => {
  const done = storage();
  try {
    const intent = intentOn(4663);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    const finality = { final: false };
    // The site's edge reader the queue asks once the finalized mark passes the block (its one bound read).
    const edge = { read: async () => ({ transaction: {}, receipt: { transactionHash: HASH, from: OWNER, blockNumber: '0x14', blockHash: BLOCK_HASH, status: '0x1' }, block: { number: '0x14', hash: BLOCK_HASH } }),
      finalized: async () => (finality.final ? { number: '0x20' } : { number: '0x1' }) };
    const queue = confirmationQueue(edge);
    const h = holdOver(queue);
    h.local.push({ wallet: OWNER, chainId: 4663, positionManager: intent.positionManager, dex: 4, hash: HASH, block: 20, blockHash: BLOCK_HASH, tokenIds: intent.tokenIds, amounts: [], at: null, state: 'included', gas: null });
    // The money client's own read of the close (the sender's), as the dialog hands it.
    const proofs = [];
    const proof = async () => { proofs.push(finality.final); return { receipt: { state: finality.final ? 'finalized' : 'included', blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false }; };
    h.hold(row, proof, () => 'ready');
    h.hold(row, proof, () => 'ready');
    assert.equal(queue.store.get().length, 1, 'registered once, whatever asks again');
    assert.equal(h.follows.length, 0, 'Robinhood Chain uses the queue, not the follow');
    await queue.run(30 * 60_000);
    assert.deepEqual([queue.calls.length, proofs.length], [0, 0], 'nothing is asked before the finalized mark passes its block');
    assert.equal(journal.includedCloses(OWNER).length, 1, 'held');
    queue.mark(4663, 20);
    await queue.run(77_000);
    assert.equal(queue.calls.length, 1, 'the queue’s one bound read');
    assert.equal(journal.includedCloses(OWNER).length, 1, 'not final yet: still held');
    finality.final = true;
    await queue.run(10 * 60_000);
    assert.equal(proofs.at(-1), true, 'the money client’s own read, once final');
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled');
    assert.equal(h.local[0].state, 'finalized', 'its local receipt says final');
    assert.deepEqual(h.forgotten, []);
  } finally { done(); }
});

test('Robinhood Chain: a block that leaves the chain sends the close back to “Check status” and drops its local receipt', async () => {
  const done = storage();
  try {
    const intent = intentOn(4663);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    // The queue's bound read finds the transaction's block number with another canonical hash: a proven reorg.
    const edge = { read: async () => ({ transaction: {}, receipt: { transactionHash: HASH, from: OWNER, blockNumber: '0x14', blockHash: OTHER_BLOCK, status: '0x1' }, block: { number: '0x14', hash: OTHER_BLOCK } }),
      finalized: async () => ({ number: '0x20' }) };
    const queue = confirmationQueue(edge);
    const h = holdOver(queue);
    h.hold(row, async () => { throw new Error('the settlement does not run on a reorg'); }, () => 'ready');
    queue.mark(4663, 20);
    await queue.run(77_000);
    await queue.run(1_000);
    assert.equal(queue.store.get()[0].phase, 'reorged');
    assert.deepEqual(h.forgotten, [[OWNER, 4663, intent.positionManager, HASH]], 'its local receipt goes');
    assert.deepEqual(journal.pendingClose(OWNER), { ...intent, hash: HASH }, 'back in the unresolved place, with its hash, for “Check status”');
    assert.deepEqual(journal.includedCloses(OWNER), []);
    // The subscription stopped: another word on the same transaction changes nothing.
    queue.store.record({ chainId: 4663, wallet: OWNER, positionManager: intent.positionManager, tokenIds: intent.tokenIds, receipt: { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 20n, state: 'included' } });
    assert.equal(queue.store.reorg({ chainId: 4663, wallet: OWNER, hash: HASH, blockHash: BLOCK_HASH }), true);
    assert.equal(h.forgotten.length, 1, 'nothing more after its subscription ended');
  } finally { done(); }
});

test('Base: a close in a block is held through the shared follow, settled when the money client’s read says final', async () => {
  const done = storage();
  try {
    const intent = intentOn(8453);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    const queue = confirmationQueue({ read: async () => { throw new Error('no queue read on Base'); }, finalized: async () => null });
    const h = holdOver(queue);
    let state = 'included';
    h.hold(row, async () => ({ receipt: { state, blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false }), () => 'ready');
    assert.equal(queue.store.get().length, 0);
    assert.equal(h.follows.length, 1);
    const [{ key, job }] = h.follows;
    assert.equal(key, `close:8453:${OWNER}:${HASH}`);
    assert.equal(job.accept(await job.read()), false, 'in a block, not final: followed on');
    state = 'finalized';
    assert.equal(job.accept(await job.read()), true);
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled');
  } finally { done(); }
});

// Added 2026-10-14 (review of C3 on main). The run kept every close it held in a set that only a settlement emptied. A
// follow that ended without one (the wallet on another account at a tick, its hour, its 80 reads, or pushed out by
// newer follows past eight) was never held again in that page: the next review's re-hold met the set and did nothing,
// so the close stayed among the included ones, its positions answered "This was already sent to your wallet", and it
// kept one of the wallet's eight places, until a reload.
test('Base: a close whose follow ended unsettled is held again at the next review on that network, and settled', async () => {
  const done = storage();
  try {
    const intent = intentOn(8453);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    const shared = followOn();
    const h = holdOver(confirmationQueue({ read: async () => { throw new Error('no queue read on Base'); }, finalized: async () => null }), shared);
    let state = 'included';
    const reads = [];
    const proof = async () => { reads.push(state); return { receipt: { state, blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false }; };
    // The wallet on another account at the follow's first tick: the follow ends, nothing read.
    h.hold(row, proof, () => 'gone');
    await shared.run(60_000);
    assert.deepEqual(reads, []);
    // The same page, the next review on Base: held again, through the connection of that review.
    state = 'finalized';
    h.hold(row, proof, () => 'ready');
    h.hold(row, proof, () => 'ready');
    await shared.run(60_000);
    assert.deepEqual(reads, ['finalized'], 'followed again, by one reader');
    await flush();
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled');
  } finally { done(); }
});

// Added 2026-10-14 (review of C3 on main): the same set on Robinhood Chain. A close whose block left the chain, then
// checked again ("Check status") and found in another block, was never registered with the queue in its new block; and
// a close whose settlement the queue dropped (ten failed tries after the proof of finality) was never registered again.
test('Robinhood Chain: a close re-included after a reorg is held in its new block; one whose settlement was dropped is held again', async () => {
  const done = storage();
  try {
    const intent = intentOn(4663);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    let canonical = OTHER_BLOCK, number = '0x14';
    const edge = { read: async () => ({ transaction: {}, receipt: { transactionHash: HASH, from: OWNER, blockNumber: number, blockHash: canonical, status: '0x1' }, block: { number, hash: canonical } }),
      finalized: async () => ({ number: '0x20' }) };
    const queue = confirmationQueue(edge);
    const h = holdOver(queue);
    h.hold(row, async () => { throw new Error('the settlement does not run on a reorg'); }, () => 'ready');
    queue.mark(4663, 20);
    await queue.run(77_000);
    await queue.run(1_000);
    assert.deepEqual(journal.pendingClose(OWNER), { ...intent, hash: HASH }, 'back for “Check status”');
    // "Check status": the money client's own read finds it in block 21 under another hash, and it is held there.
    const moved = await journal.includedClose(journal.pendingClose(OWNER), HASH, 21, OTHER_BLOCK);
    number = '0x15';
    let tries = 0, settle = false;
    const proof = async () => { tries++; if (!settle) throw new Error('confirmation_busy'); return { receipt: { state: 'finalized', blockHash: OTHER_BLOCK, blockNumber: 21n }, replaced: false, final: false }; };
    h.hold(moved, proof, () => 'ready');
    assert.deepEqual(queue.store.get().map((op) => [op.blockHash, op.phase]), [[OTHER_BLOCK, 'included']], 'registered in its new block');
    queue.mark(4663, 21);
    await queue.run(77_000);
    await queue.run(10 * 60_000);
    assert.equal(queue.store.get()[0].phase, 'finalized');
    assert.equal(tries, 10, 'the queue gave its settlement ten tries, then dropped it');
    assert.equal(journal.includedCloses(OWNER).length, 1, 'still held');
    // The next review on Robinhood Chain: held again, and settled by the money client's own read.
    settle = true;
    h.hold(moved, proof, () => 'ready');
    await queue.run(60_000);
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled');
    assert.equal(tries, 11);
  } finally { done(); }
});

// Added 2026-10-14 (review of C3 on main). A close that left its block and was not put in another (its nonce later used
// by another transaction) was read as "not in a block" for the hour of its follow and then left: it stayed among the
// included closes for good, its positions (with their liquidity) refused every direct exit, and Close positions never
// showed it, so "Check status" and the field for a replacement hash were never offered. It goes back there now, as a
// block that left the chain does.
// Rewritten on purpose 2026-10-14 (second review of C3 on main): only a lasting absence is "left its block", misses in a
// row for a minute at least, over the shared follow itself on its clock. Two misses in a row (5 s apart) were enough,
// and a wallet's node only behind sent a close that is in its block back (the next test).
test('Base: a close the money client no longer finds in a block, read after read for a minute, goes back to “Check status”', async () => {
  const done = storage();
  try {
    const intent = intentOn(8453);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    const shared = followOn();
    const h = holdOver(confirmationQueue({ read: async () => { throw new Error('no queue read on Base'); }, finalized: async () => null }), shared);
    // Missing, found in its block after all, then missing for good. The follow reads every 5 s to 30 s, then every 15 s.
    const answers = ['pending', 'pending', 'pending', 'included'], reads = [];
    h.hold(row, async () => {
      const state = answers[reads.length] ?? 'pending';
      reads.push(shared.now());
      return { receipt: state === 'pending' ? { state } : { state, blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false };
    }, () => 'ready');
    await shared.run(75_000);
    assert.deepEqual(reads, [5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 45_000, 60_000, 75_000], 'read again after each miss');
    await flush();
    assert.equal(journal.pendingClose(OWNER), null, 'missing since 25 s (the find at 20 s ended the misses before it), under a minute: still held');
    assert.equal(journal.includedCloses(OWNER).length, 1);
    await shared.run(15_000);
    assert.deepEqual(reads.slice(9), [90_000], 'read at 90 s: missing for over a minute');
    await flush();
    assert.deepEqual(journal.pendingClose(OWNER), { ...intent, hash: HASH }, 'back in the unresolved place, with its hash, for “Check status”');
    assert.deepEqual(journal.includedCloses(OWNER), []);
    assert.deepEqual(h.forgotten, [[OWNER, 8453, intent.positionManager, HASH]], 'its local receipt goes');
    await shared.run(60_000);
    assert.equal(reads.length, 10, 'its follow ended');
  } finally { done(); }
});

// Added 2026-10-14 (second review of C3 on main). The money client's read says "pending" for no transaction, no receipt,
// or no block of that number on the node that answers, and a wallet's load-balanced node that is only behind answers any
// of the three. Two such reads in a row, 5 s apart, sent a close that is in its block back to "Check status": the next
// group's "Close 2 positions" then met "This was already sent to your wallet", and the close waited on "Check status"
// until it was pressed.
test('Base: a wallet node behind for a few reads leaves a close in its block held, and it is settled at finality', async () => {
  const done = storage();
  try {
    const intent = intentOn(8453);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    const shared = followOn();
    const h = holdOver(confirmationQueue({ read: async () => { throw new Error('no queue read on Base'); }, finalized: async () => null }), shared);
    const answers = ['pending', 'pending', 'pending', 'included', 'finalized'], reads = [];
    h.hold(row, async () => {
      const state = answers[reads.length] ?? 'finalized';
      reads.push(state);
      return { receipt: state === 'pending' ? { state } : { state, blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false };
    }, () => 'ready');
    await shared.run(60_000);
    assert.deepEqual(reads, answers, 'three misses 5 s apart are a node behind: read again, then followed to final');
    await flush();
    assert.equal(journal.pendingClose(OWNER), null, 'never sent back to “Check status”');
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled at finality');
    assert.deepEqual(h.forgotten, [], 'its local receipt stays');
  } finally { done(); }
});

// Added 2026-10-14 (second review of C3 on main). On Robinhood Chain a close is held again at a review only when its hold
// ended without a settlement; while the queue still waits for its block's proof the re-hold is skipped. That skip is
// what keeps a review from starting the queue's one read of the site's node anew (record() sets its tries back to 0):
// without it, each review on Robinhood Chain of a close whose read gave up cost eleven more reads (11 became 44 in three
// reviews), and one while the read was live set it back to its first try. A read that gave up is not asked again at a
// review either; read-v6's own item saying final (no read) still releases the close, by the money client's own read.
test('Robinhood Chain: holding a close again asks the site’s node nothing more while the queue waits for its block’s proof, even after its read gave up', async () => {
  const done = storage();
  try {
    const intent = intentOn(4663);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, HASH);
    const row = await journal.includedClose(intent, HASH, 20, BLOCK_HASH);
    // The site's node never finds the receipt: for the queue, a node behind, asked again until its eleventh try.
    let finals = 0;
    const queue = confirmationQueue({ read: async () => ({ transaction: null, receipt: null, block: null }), finalized: async () => { finals++; return { number: '0x20' }; } });
    const h = holdOver(queue);
    let final = false, proofs = 0;
    const proof = async () => { proofs++; if (!final) throw new Error('confirmation_busy'); return { receipt: { state: 'finalized', blockHash: BLOCK_HASH, blockNumber: 20n }, replaced: false, final: false }; };
    h.hold(row, proof, () => 'ready');
    queue.mark(4663, 20);
    await queue.run(92_000);
    assert.equal(queue.calls.length, 3, 'the queue’s read, three tries so far');
    // A review on Robinhood Chain while that read is live: it goes on from its fourth try.
    h.hold(row, proof, () => 'ready');
    await queue.run(30 * 60_000);
    assert.equal(queue.calls.length, 11, 'one read, eleven tries at most: not started again');
    // Three more reviews on Robinhood Chain in the same page, the finalized mark moving on.
    for (let i = 0; i < 3; i++) { h.hold(row, proof, () => 'ready'); queue.mark(4663, 40 + i); await queue.run(30 * 60_000); }
    assert.deepEqual([queue.calls.length, finals], [11, 0], 'no new read of the site’s node at any review');
    assert.equal(queue.store.get().length, 1);
    assert.equal(queue.store.get()[0].phase, 'included');
    assert.equal(proofs, 0, 'nothing final: no settlement read');
    assert.equal(journal.includedCloses(OWNER).length, 1, 'still held');
    // read-v6 lists the same transaction in the same block as final: the money client's own read settles the close.
    final = true;
    queue.store.record({ indexed: true, chainId: 4663, wallet: OWNER, tokenIds: [], receipt: { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 20n, state: 'finalized' } });
    await queue.run(60_000);
    assert.equal(proofs, 1);
    assert.deepEqual(journal.includedCloses(OWNER), [], 'settled');
    assert.deepEqual([queue.calls.length, finals], [11, 0], 'still no new read of the site’s node');
  } finally { done(); }
});

// Added 2026-10-14 (second review of C3 on main). The close's proof as the page builds it (src/v2in/lists/closeHold.ts
// closeProof, moved out of BulkClosePositions.tsx proofOf, which no test ran): the recovery's read asks for no
// description (`false`). That read of the positions took the money client's one-operation lock in the background, and
// the person's "Close 2 positions" or "Continue to next group" pressed then failed with "wallet_action_busy". Dropping
// the argument passed every test. tests/v2/close-many.test.mjs runs it over the real client.
test('a close’s proof: the sender’s own read for the hash it sent; otherwise the recovery’s, which asks for no description', async () => {
  const h = holdOver(confirmationQueue({ read: async () => { throw new Error('no queue read'); }, finalized: async () => null }));
  const intent = { ...intentOn(8453), hash: HASH };
  const REPLACEMENT = '0x' + 'c'.repeat(64);
  const asked = [], sent = [];
  const found = { state: 'included', blockHash: BLOCK_HASH, blockNumber: 20n };
  const recover = async (...args) => { asked.push(args); return { receipt: found, description: null, replaced: true, replacementFinal: false }; };
  assert.deepEqual(await h.closeProof(intent, REPLACEMENT, HASH, null, recover)(), { receipt: found, replaced: true, final: false });
  assert.equal(asked.length, 1);
  const [[hint, describe]] = asked;
  assert.equal(describe, false, 'no description: the hold never uses one');
  assert.deepEqual([hint.hash, hint.originalHash, hint.tokenIds, hint.dex, hint.data, hint.nonce], [REPLACEMENT, HASH, [11n, 12n], 4, '0x1234', '0x1']);
  // A reload's re-hold names no other original hash.
  await h.closeProof(intent, HASH, null, null, recover)();
  assert.deepEqual([asked[1][0].originalHash, asked[1][1]], [undefined, false]);
  // The sender's own read of the hash it sent: the recovery is not asked.
  const direct = { receipt: async (hash) => { sent.push(hash); return found; } };
  assert.deepEqual(await h.closeProof(intent, HASH, HASH, direct, recover)(), { receipt: found, replaced: false, final: false });
  assert.deepEqual([sent, asked.length], [[HASH], 2]);
});
