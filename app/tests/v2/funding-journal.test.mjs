import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createFundingStorage, browserFundingStorage } = require('../../.test-build/app/src/finance/v2/fundingJournal.js');
const KEY = `domino.funding.v1:0x${'ab'.repeat(20)}:4663`;
const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
test('public metadata is written and verified, removable, and isolated by wallet/network key', () => {
  const store = createFundingStorage(memory());
  store.put(KEY, '{"version":1}');
  assert.equal(store.get(KEY), '{"version":1}');
  assert.equal(store.get(KEY.replace(':4663', ':8453')), null);
  store.drop(KEY);
  assert.equal(store.get(KEY), null);
  assert.throws(() => store.put('unrelated', '{}'), /invalid_funding_storage_key/);
  assert.throws(() => store.put(KEY, 'a'.repeat(24_001)), /invalid_funding_metadata/);
});
test('missing, unreadable, full or silently failing storage blocks writes before wallet activity', () => {
  assert.throws(() => createFundingStorage(null).put(KEY, '{}'), /funding_storage_unavailable/);
  const broken = memory();
  const original = broken.getItem;
  broken.getItem = () => { throw new Error('denied'); };
  const store = createFundingStorage(broken);
  assert.equal(store.get(KEY), null);
  broken.getItem = original;
  assert.throws(() => store.put(KEY, '{}'), /funding_storage_unavailable/, 'a transiently unread old intent cannot be overwritten');
  const full = memory();
  full.setItem = () => { throw new Error('quota'); };
  assert.throws(() => createFundingStorage(full).put(KEY, '{}'), /funding_storage_unavailable/);
  const lost = memory(); lost.setItem = () => {};
  assert.throws(() => createFundingStorage(lost).put(KEY, '{}'), /funding_storage_unavailable/);
});
test('another tab invalidates funding metadata only; clear and unsubscribe are covered', () => {
  let listener;
  let changes = 0;
  let stopped = false;
  const store = createFundingStorage(memory(), (next) => { listener = next; return () => { stopped = true; }; });
  const stop = store.subscribe(() => changes++);
  listener('unrelated'); assert.equal(changes, 0);
  listener(KEY); listener(null); assert.equal(changes, 2);
  stop(); assert.equal(stopped, true);
});
test('replacement coordinators in the same window observe verified writes and removals from another handle', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = Object.assign(new EventTarget(), { localStorage: memory() });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  try {
    const previous = browserFundingStorage();
    const replacement = browserFundingStorage();
    const observed = [];
    const stop = replacement.subscribe(() => observed.push(replacement.get(KEY)));
    previous.put(KEY, '{"state":"sent"}');
    previous.drop(KEY);
    assert.deepEqual(observed, ['{"state":"sent"}', null], 'a late wallet result reaches the newly mounted coordinator');
    stop();
    previous.put(KEY, '{"state":"settled"}');
    assert.equal(observed.length, 2, 'unmounted subscribers are removed');
    const failed = browserFundingStorage();
    let invalidations = 0;
    const unwatch = replacement.subscribe(() => invalidations++);
    window.localStorage.setItem = () => { throw new Error('quota'); };
    assert.throws(() => failed.put(KEY, '{"state":"sent"}'), /funding_storage_unavailable/);
    assert.equal(invalidations, 0, 'unpersisted state never emits a successful write');
    unwatch();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
});
