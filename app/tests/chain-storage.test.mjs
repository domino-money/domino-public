/**
 * Chain-scoped storage names (src/lib/chainStorage.ts, 2026-10-01, the chain2 workstream, audit item G10): every key
 * names its chain, an unscoped old key of the same thing is removed and never read, and a browser that refuses storage
 * costs nothing but the copy.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const storage = require('../.test-build/app/src/lib/chainStorage.js');

function memory() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}

test('a key names its chain and parts, lowercase, and refuses a part that could break it', () => {
  assert.equal(storage.chainKey('domino-wallet-v2', 4663, '0xABCDEF0000000000000000000000000000000001'), 'domino-wallet-v2:4663:0xabcdef0000000000000000000000000000000001');
  assert.equal(storage.chainKey('domino-elysium-receipts-v1', 99801, '0x0000000000000000000000000000000000000001'), 'domino-elysium-receipts-v1:99801:0x0000000000000000000000000000000000000001');
  assert.notEqual(storage.chainKey('domino-wallet-v2', 4663, 'a'), storage.chainKey('domino-wallet-v2', 99801, 'a'), 'the same address on two chains is two keys');
  for (const bad of [['Domino', 1], ['x', 0], ['x', 1.5], ['x', -1]]) assert.throws(() => storage.chainKey(...bad));
  assert.throws(() => storage.chainKey('x', 1, 'a:b'));
  assert.throws(() => storage.chainKey('x', 1, ''));
  assert.throws(() => storage.chainKey('x', 1, 'a b'));
});

test('reading a scoped key removes the unscoped copies first, and never reads them', () => {
  const store = memory();
  store.setItem('domino-wallet-v1:0xabc', 'old');
  store.setItem('domino-wallet-v2:4663:0xabc', 'new');
  assert.equal(storage.readScoped(store, 'domino-wallet-v2:4663:0xabc', ['domino-wallet-v1:0xabc']), 'new');
  assert.equal(store.map.has('domino-wallet-v1:0xabc'), false);
  assert.equal(storage.readScoped(store, 'domino-wallet-v2:99801:0xabc', ['domino-wallet-v1:0xabc']), null, 'another chain sees nothing');
});

test('a browser that refuses storage keeps nothing and breaks nothing', () => {
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('denied'); } };
  assert.equal(storage.readScoped(refusing, 'k', ['old']), null);
  assert.equal(storage.writeScoped(refusing, 'k', 'v'), false);
  assert.doesNotThrow(() => storage.dropScoped(refusing, 'k'));
  assert.equal(storage.readScoped(null, 'k'), null);
  assert.equal(storage.writeScoped(null, 'k', 'v'), false);
  const store = memory();
  assert.equal(storage.writeScoped(store, 'k', 'v'), true);
  storage.dropScoped(store, 'k');
  assert.equal(store.getItem('k'), null);
});

// Part B (2026-10-01): what was kept under a name with no chain in it is Robinhood Chain's (the only chain those copies
// ever read), so it moves to the chain's name on its first read instead of being thrown away.
test('a copy under its name from before moves to the chain\'s name on its first read; the chain\'s name wins over it', () => {
  const store = memory();
  store.setItem('domino-markets:v1', 'old');
  assert.equal(storage.movedScoped(store, 'domino-markets-v2:4663', 'domino-markets:v1'), 'old', 'read as it was');
  assert.deepEqual([...store.map], [['domino-markets-v2:4663', 'old']], 'moved: under the new name only');
  assert.equal(storage.movedScoped(store, 'domino-markets-v2:4663', 'domino-markets:v1'), 'old', 'then read from there');
  store.setItem('domino-markets:v1', 'older');
  assert.equal(storage.movedScoped(store, 'domino-markets-v2:4663', 'domino-markets:v1'), 'old', 'both kept: the chain\'s name wins');
  assert.deepEqual([...store.map], [['domino-markets-v2:4663', 'old']], 'and the old name goes');
  assert.equal(storage.movedScoped(memory(), 'k', 'old'), null, 'neither: nothing');
  // A stand-in that cannot remove copies; a full store reads the old name this time; a refusing one gives nothing.
  const noRemove = { map: new Map([['old', 'v']]), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  assert.equal(storage.movedScoped(noRemove, 'k', 'old'), 'v');
  assert.equal(noRemove.map.get('k'), 'v');
  const full = { getItem: (k) => (k === 'old' ? 'v' : null), setItem: () => { throw new Error('quota'); }, removeItem: () => assert.fail('the old copy stays until it has moved') };
  assert.equal(storage.movedScoped(full, 'k', 'old'), 'v');
  assert.equal(storage.movedScoped({ getItem: () => { throw new Error('denied'); }, setItem() {}, removeItem() {} }, 'k', 'old'), null);
  assert.equal(storage.movedScoped(null, 'k', 'old'), null);
});
