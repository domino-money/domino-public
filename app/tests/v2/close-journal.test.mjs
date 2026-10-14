import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { confirmationQueue } from './support/queue.mjs';
const require = createRequire(import.meta.url);
const journal = require('../../.test-build/app/src/finance/v2/closeJournal.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const wallet = '0x' + '1'.repeat(40), hash = '0x' + 'a'.repeat(64);
const intent = { wallet, chainId: 8453, positionManager: v2Chain(8453).uniswap.v4.positionManager, dex: 4, tokenIds: ['11', '12'], data: '0x1234', nonce: '0x1', hash: null };
test('pending close survives a fresh module, never expires or evicts; final proof is idempotent and cannot clear a newer intent', async () => {
  const rows = new Map(); let line = Promise.resolve();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(_key, fn) { const next = line.then(fn); line = next.catch(() => {}); return next; } } } });
  try {
    const both = await Promise.allSettled([journal.beginClose(intent), journal.beginClose(intent)]);
    assert.deepEqual(both.map((one) => one.status), ['fulfilled', 'rejected']);
    delete require.cache[require.resolve('../../.test-build/app/src/finance/v2/closeJournal.js')];
    const restored = require('../../.test-build/app/src/finance/v2/closeJournal.js');
    assert.deepEqual(restored.pendingClose(wallet), intent);
    await restored.rememberCloseHash(intent, hash);
    assert.equal(restored.pendingClose(wallet).hash, hash);
    await assert.rejects(restored.beginClose({ ...intent, nonce: '0x2' }), /already_sent/);
    await restored.settleClose(intent); await restored.settleClose(intent);
    const next = { ...intent, nonce: '0x2' };
    await restored.beginClose(next); await restored.settleClose(intent);
    assert.deepEqual(restored.pendingClose(wallet), next);
    await restored.settleClose(next);
    await Promise.all([restored.beginClose(intent), restored.beginClose({ ...intent, wallet: '0x' + '2'.repeat(40) })]);
    assert.equal(JSON.parse(rows.get(journal.CLOSE_JOURNAL_KEY)).length, 2);
    rows.set(journal.CLOSE_JOURNAL_KEY, 'broken');
    assert.throws(() => restored.pendingClose(wallet), /journal_unavailable/);
    await assert.rejects(restored.beginClose(intent), /journal_unavailable/);
    rows.clear(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() { throw new Error('denied'); } } });
    await assert.rejects(restored.beginClose(intent), /journal_unavailable/);
  } finally { delete globalThis.localStorage; delete globalThis.navigator; }
});

// Added 2026-10-14 (incident C3: screens finish at inclusion). "Close positions" was done only once a group's block was
// final, about 16 minutes on Robinhood Chain, and the next group waited that long. A group in a block is done now: its
// intent moves among the included closes, where it keeps its positions held until the money client's own read says it
// is final (registered with the confirmation queue), and the wallet's one unresolved place is free for the next group.
test('a close in a block moves among the included ones: the next group may begin, its own stay held, the queue settles it at finality', async () => {
  const rows = new Map(); let line = Promise.resolve();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(_key, fn) { const next = line.then(fn); line = next.catch(() => {}); return next; } } } });
  try {
    const blockHash = '0x' + 'b'.repeat(64);
    await journal.beginClose(intent);
    await journal.rememberCloseHash(intent, hash);
    const row = await journal.includedClose(intent, hash, 20, blockHash);
    assert.equal(journal.pendingClose(wallet), null, 'the unresolved place is free');
    assert.deepEqual(journal.includedCloses(wallet), [{ ...intent, hash, block: 20, blockHash }], 'and the close is held among the included');
    assert.deepEqual(JSON.parse(rows.get(journal.CLOSE_JOURNAL_KEY)), [], 'a page from before this change sees one row per wallet at most');
    const next = { ...intent, tokenIds: ['13', '14'], nonce: '0x2' };
    await journal.beginClose(next);
    assert.deepEqual(journal.pendingClose(wallet), next, 'the next group may begin');
    // The confirmation queue runs the settlement once the block is final, through the money client's own read.
    const finality = { final: false };
    const reader = { read: async () => ({ transaction: {}, receipt: { transactionHash: hash, from: wallet, blockNumber: '0x14', blockHash, status: '0x1' }, block: { number: '0x14', hash: blockHash } }),
      finalized: async () => (finality.final ? { number: '0x20' } : { number: '0x1' }) };
    const queue = confirmationQueue(reader);
    queue.store.record({ chainId: 4663, wallet, positionManager: intent.positionManager, tokenIds: intent.tokenIds, receipt: { transactionHash: hash, blockHash, blockNumber: 20n, state: 'included' },
      onFinalized: async () => { if (!finality.final) return false; await journal.settleClose(row); return true; } });
    queue.mark(4663, 20);
    await queue.run(77_000);
    assert.equal(journal.includedCloses(wallet).length, 1, 'not final: still held');
    finality.final = true;
    await queue.run(60_000);
    assert.deepEqual(journal.includedCloses(wallet), [], 'final: settled by the queue');
    assert.deepEqual(journal.pendingClose(wallet), next, 'the next group untouched');
    // A block that left the chain: back to the unresolved place for "Check status", unless a newer intent holds it.
    const again = await journal.includedClose({ ...next, hash: null }, '0x' + 'c'.repeat(64), 30, blockHash);
    await journal.beginClose({ ...intent, nonce: '0x3' });
    assert.equal(await journal.reopenClose(again), false, 'the place is taken: it stays held among the included');
    assert.equal(journal.includedCloses(wallet).length, 1);
    await journal.settleClose({ ...intent, nonce: '0x3' });
    assert.equal(await journal.reopenClose(again), true);
    assert.deepEqual(journal.pendingClose(wallet), { ...next, hash: '0x' + 'c'.repeat(64) });
    assert.deepEqual(journal.includedCloses(wallet), []);
    // Rewritten on purpose 2026-10-14 (C3 review): the 8 were the whole browser's, so another wallet's closes took this
    // wallet's room. Eight of other wallets waiting leave it room; eight of its own do not, and the intent stays where it is.
    await journal.settleClose(next);
    for (let n = 0; n < 8; n++) await journal.includedClose({ ...intent, wallet: '0x' + String(n + 2).repeat(40), nonce: `0x${(n + 10).toString(16)}` }, hash, 40 + n, blockHash);
    const mine = { ...intent, nonce: '0x30' };
    await journal.includedClose(mine, hash, 49, blockHash);
    assert.equal(journal.includedCloses(wallet).length, 1, 'other wallets’ closes leave this wallet room');
    await journal.settleClose(mine);
    for (let n = 0; n < 8; n++) await journal.includedClose({ ...intent, nonce: `0x${(n + 20).toString(16)}` }, hash, 60 + n, blockHash);
    await journal.beginClose(intent);
    await assert.rejects(journal.includedClose(intent, hash, 50, blockHash), /journal_full/);
    assert.deepEqual(journal.pendingClose(wallet), intent);
    for (let n = 0; n < 8; n++) await journal.settleClose({ ...intent, nonce: `0x${(n + 20).toString(16)}` });
    // A broken list of included closes is said by every read of it, and never blocks a settlement of the unresolved place.
    rows.set(journal.CLOSE_INCLUDED_KEY, 'broken');
    assert.throws(() => journal.includedCloses(wallet), /journal_unavailable/);
    await journal.settleClose(intent);
    assert.equal(journal.pendingClose(wallet), null);
  } finally { delete globalThis.localStorage; delete globalThis.navigator; }
});
