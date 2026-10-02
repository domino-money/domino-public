/**
 * The second chain's receipts (src/chains/elysium/receipts.ts, 2026-10-01, the chain2 workstream): kept per chain and
 * owner (audit item G10), checked when read back, and looked up by themselves through his receipt route or the chain.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const receipts = require('../.test-build/app/src/chains/elysium/receipts.js');
const { ServiceError } = require('../.test-build/app/src/chains/elysium/api.js');
const { ELYSIUM, ROBINHOOD } = require('../.test-build/app/src/config/chains.js');

const WIRE = JSON.parse(readFileSync(new URL('./fixtures/elysium/uniswap-v3-actions-v1.wire.json', import.meta.url), 'utf8'));
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const VAULT = '0x3aa5ebb10dc797cac828524e59a333d0a371443c';
const HASH = `0x${'a'.repeat(64)}`;

function memory() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}

test('a sent transaction is kept under its chain and owner, newest first, and its outcome recorded', () => {
  const store = memory();
  receipts.keepSent(store, ELYSIUM, { hash: HASH, vault: VAULT, owner: OWNER.toUpperCase().replace('0X', '0x'), step: 'approve-token0', sentAt: 1_000 });
  receipts.keepSent(store, ELYSIUM, { hash: `0x${'b'.repeat(64)}`, vault: VAULT, owner: OWNER, step: 'open', sentAt: 2_000 });
  assert.deepEqual([...store.map.keys()], [`domino-elysium-receipts-v1:${ELYSIUM.id}:${OWNER}`]);
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER).map((r) => [r.step, r.outcome]), [['open', 'pending'], ['approve-token0', 'pending']]);
  receipts.keepOutcome(store, ELYSIUM, OWNER, HASH, 'confirmed', 4242);
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER).find((r) => r.hash === HASH), { hash: HASH, vault: VAULT, owner: OWNER, step: 'approve-token0', sentAt: 1_000, outcome: 'confirmed', block: 4242 });
  assert.deepEqual(receipts.loadReceipts(store, ROBINHOOD, OWNER), [], 'another chain sees none of them');
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, VAULT), [], 'another owner sees none of them');
});

test('what is read back is untrusted: anything that does not check out is left out', () => {
  const store = memory();
  const key = `domino-elysium-receipts-v1:${ELYSIUM.id}:${OWNER}`;
  const good = { hash: HASH, vault: VAULT, owner: OWNER, step: 'open', sentAt: 1, outcome: 'pending', block: null };
  store.setItem(key, JSON.stringify([good, { ...good, hash: 'nope' }, { ...good, step: 'drain' }, { ...good, outcome: 'won' }, { ...good, owner: VAULT }, { ...good, block: -1 }, null, 'x']));
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER), [good]);
  store.setItem(key, '{"not":"a list"}');
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER), []);
  store.setItem(key, 'garbage');
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER), []);
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, 'not an address'), []);
});

test('at most fifty are kept', () => {
  const store = memory();
  for (let i = 0; i < 60; i++) receipts.keepSent(store, ELYSIUM, { hash: `0x${i.toString(16).padStart(64, '0')}`, vault: VAULT, owner: OWNER, step: 'open', sentAt: i + 1 });
  assert.equal(receipts.loadReceipts(store, ELYSIUM, OWNER).length, receipts.MAX_KEPT);
});

const entry = { hash: WIRE.responses.receipt.transactionHash, vault: VAULT, owner: OWNER, step: 'pause', sentAt: 1, outcome: 'pending', block: null };

test('a look through his receipt route: its state, for this very transaction', async () => {
  const api = { actions: async () => ({ ...WIRE.responses.receipt }) };
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: null, api, identity: WIRE.identity }), { outcome: 'confirmed', block: 38 });
  const other = { actions: async () => ({ ...WIRE.responses.receipt, transactionHash: HASH }) };
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: null, api: other, identity: WIRE.identity }), { outcome: 'pending', block: null }, 'a receipt for another hash says nothing');
});

test('without his route, the chain\'s own receipt: confirmed, reverted, or still pending', async () => {
  const unreachable = { actions: async () => { throw new ServiceError('unreachable', null, 'x'); } };
  const reader = (raw) => ({ call: async (method, params) => (assert.equal(method, 'eth_getTransactionReceipt'), assert.deepEqual(params, [entry.hash]), raw) });
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: reader({ transactionHash: entry.hash, status: '0x1', blockNumber: '0x26' }), api: unreachable, identity: WIRE.identity }), { outcome: 'confirmed', block: 38 });
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: reader({ transactionHash: entry.hash, status: '0x0', blockNumber: '0x26' }), api: null, identity: null }), { outcome: 'reverted', block: 38 });
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: reader(null), api: null, identity: null }), { outcome: 'pending', block: null });
  assert.deepEqual(await receipts.lookReceipt(entry, { reader: reader({ transactionHash: HASH, status: '0x1' }), api: null, identity: null }), { outcome: 'pending', block: null });
});

// Fix round 1 (2026-10-01): the receipts are kept as the site's other receipts are, 30 days from when each was sent: the
// screen shows none older (lib/browserCopies.ts sweepCopies deletes them as the site opens, and forgetWallets on a
// disconnect, tests/platform.test.mjs), and a pending one is looked at again later each time, never every 6 s for good.
test('the screen shows receipts within their 30 days only, and a pending one is looked at again later each time', () => {
  const store = memory();
  const DAY = 86_400_000;
  const now = 1_790_000_000_000;
  assert.equal(receipts.RECEIPTS_MAX_AGE_MS, 30 * DAY);
  receipts.keepSent(store, ELYSIUM, { hash: HASH, vault: VAULT, owner: OWNER, step: 'open', sentAt: now - 31 * DAY });
  receipts.keepSent(store, ELYSIUM, { hash: `0x${'b'.repeat(64)}`, vault: VAULT, owner: OWNER, step: 'open', sentAt: now - DAY });
  receipts.keepSent(store, ELYSIUM, { hash: `0x${'c'.repeat(64)}`, vault: VAULT, owner: OWNER, step: 'open', sentAt: now + 5 * 60_000 });
  assert.deepEqual(receipts.loadReceipts(store, ELYSIUM, OWNER, now).map((r) => r.hash), [`0x${'b'.repeat(64)}`], 'within its age, and not from the future');
  assert.equal(receipts.loadReceipts(store, ELYSIUM, OWNER).length, 3, 'all kept until the sweep');
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(receipts.lookAgainAfter), [6_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
  const screen = readFileSync(new URL('../src/chains/elysium/ui/Receipts.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /setInterval/, 'the next look starts only once the last one ended');
  assert.match(screen, /timer = setTimeout\(next, lookAgainAfter\(looks\+\+\)\)/);
  assert.match(screen, /if \(document\.hidden\) \{\s+held = true/, 'not while the tab is hidden');
  assert.match(screen, /loadReceipts\(browserStore\(\), chain, account, now\)/);
});
