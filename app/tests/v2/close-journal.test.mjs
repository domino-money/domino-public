import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
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
