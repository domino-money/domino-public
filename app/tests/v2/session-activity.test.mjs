import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { sessionActivity, activityWindow } = require('../../.test-build/app/src/v2in/lists/sessionActivity.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const wallet = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const hash = `0x${'1'.repeat(64)}`;
const blockHash = `0x${'2'.repeat(64)}`;
const vault = `0x${'3'.repeat(40)}`;
const tokenId = '6238157';
function proof(chainId = 8453, dex = 3, patch = {}) {
  return {
    chainId, wallet, hash, blockHash, block: 123, phase: 'included', at: 1_790_000_000_000,
    positionManager: v2Chain(chainId).uniswap[`v${dex}`].positionManager.toLowerCase(),
    vault, tokenIds: [tokenId],
    events: [{ eventName: 'Initialized', address: vault, args: { owner: wallet, rootTokenId: BigInt(tokenId), dex } }],
    ...patch,
  };
}
function indexed(p = proof(), patch = {}) {
  return {
    kind: 'vault_created', chainId: p.chainId, vault: p.vault, owner: p.wallet,
    dex: Number(p.events[0].args.dex), rootTokenId: String(p.events[0].args.rootTokenId),
    tx: { hash: p.hash, snapshot: { number: p.block, hash: p.blockHash, timestamp: 1_789_999_999 }, finality: 'unfinalized' },
    ...patch,
  };
}

test('verified setup is immediately visible for every supported chain and manager without inventing time or finality', () => {
  for (const chainId of [4663, 8453, 42161]) for (const dex of [3, 4]) for (const phase of ['included', 'finalized']) {
    const p = proof(chainId, dex, { phase });
    const [row] = sessionActivity(wallet.toUpperCase(), [p], [], { chainId, dex, tokenId });
    assert.equal(row.proof, p, 'the original canonical proof and its actual phase are preserved');
    assert.equal(row.tokenId, tokenId);
    assert.equal(row.chain, v2Chain(chainId).name);
    assert.deepEqual(Object.keys(row).sort(), ['chain', 'proof', 'tokenId'], 'observation time is not projected as an activity timestamp');
  }
});

test('missing identity, other wallet, unsupported chain, wrong manager and reorged setup cannot create a row', () => {
  const p = proof();
  assert.deepEqual(sessionActivity(null, [p], []), []);
  assert.deepEqual(sessionActivity(other, [p], []), []);
  for (const patch of [
    { wallet: other }, { chainId: 1 }, { vault: undefined }, { vault: other },
    { positionManager: undefined }, { positionManager: other },
    { positionManager: v2Chain(8453).uniswap.v4.positionManager.toLowerCase() },
    { tokenIds: ['7'] }, { phase: 'reorged' }, { events: [] },
  ]) assert.deepEqual(sessionActivity(wallet, [{ ...p, ...patch }], []), [], JSON.stringify(patch));
});

test('setup must contain an Initialized event from its vault for the bound owner, manager kind and root token', () => {
  const p = proof(), event = p.events[0];
  for (const changed of [
    { ...event, eventName: 'Created' }, { ...event, address: other },
    { ...event, args: { ...event.args, owner: other } },
    { ...event, args: { ...event.args, rootTokenId: 7n } },
    { ...event, args: { ...event.args, dex: 4 } },
    { ...event, args: { ...event.args, dex: 2 } },
  ]) assert.deepEqual(sessionActivity(wallet, [{ ...p, events: [changed] }], []), []);
  assert.equal(sessionActivity(wallet, [{ ...p, events: [{ ...event, address: vault.toUpperCase(), args: { ...event.args, owner: wallet.toUpperCase() } }] }], []).length, 1);
});

test('position scope includes chain, manager kind and token id, even when another chain has the same NFT number', () => {
  const proofs = [proof(4663, 3), proof(8453, 3), proof(8453, 4), proof(42161, 4)];
  const rows = sessionActivity(wallet, proofs, [], { chainId: 8453, dex: 4, tokenId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proof, proofs[2]);
  assert.deepEqual(sessionActivity(wallet, proofs, [], { chainId: 8453, dex: 4, tokenId: '9' }), []);
});

test('only the same indexed setup in the same canonical block replaces the immediate row', () => {
  const p = proof(), event = indexed(p);
  assert.deepEqual(sessionActivity(wallet, [p], [event]), []);
  assert.deepEqual(sessionActivity(wallet, [p], [{ ...event, tx: { ...event.tx, finality: 'finalized' } }]), []);
  const unrelated = [
    { ...event, chainId: 42161 }, { ...event, vault: other }, { ...event, owner: other },
    { ...event, dex: 4 }, { ...event, rootTokenId: '9' },
    { ...event, kind: 'vault_event', events: [] },
    { ...event, tx: { ...event.tx, hash: `0x${'4'.repeat(64)}` } },
    { ...event, tx: { ...event.tx, snapshot: { ...event.tx.snapshot, number: p.block + 1 } } },
    { ...event, tx: { ...event.tx, snapshot: { ...event.tx.snapshot, hash: `0x${'5'.repeat(64)}` } } },
  ];
  for (const item of unrelated) assert.equal(sessionActivity(wallet, [p], [item]).length, 1, 'a related transaction log cannot hide the pending setup');
  assert.deepEqual(sessionActivity(wallet, [p], [...unrelated, event]), [], 'later indexed pages can supply the exact event');
  assert.deepEqual(sessionActivity(wallet, [p], [{ ...event, vault: vault.toUpperCase(), owner: wallet.toUpperCase(), tx: { ...event.tx, hash: hash.toUpperCase(), snapshot: { ...event.tx.snapshot, hash: blockHash.toUpperCase() } } }]), []);
});

test('pending setups remain sorted by observation order without changing their financial proof', () => {
  const earlier = proof(8453, 3, { at: 100, phase: 'finalized' });
  const later = proof(42161, 4, { at: 200 });
  const rows = sessionActivity(wallet, [earlier, later], []);
  assert.deepEqual(rows.map(row => row.proof), [later, earlier]);
  assert.equal(rows[0].proof.phase, 'included', 'sorting does not turn inclusion into finality');
});

test('pagination exposes remaining immediate setups even when there is no indexed activity', () => {
  const setups = Array.from({ length: 12 }, (_, index) => index);
  const first = activityWindow(setups, [], 10);
  assert.equal(first.immediate.length, 10);
  assert.deepEqual(first.visible, []);
  assert.equal(first.total, 12);
  assert.equal(first.hidden, true, 'Show more remains available for the final two setup records');
  const next = activityWindow(setups, [], 20);
  assert.deepEqual(next.immediate, setups);
  assert.equal(next.hidden, false);
});

test('immediate and indexed activity share the page limit without hiding loaded older rows', () => {
  const setups = ['setup1', 'setup2'], indexedRows = ['index1', 'index2', 'index3', 'index4', 'index5'];
  const first = activityWindow(setups, indexedRows, 5);
  assert.deepEqual(first.immediate, setups);
  assert.deepEqual(first.visible, indexedRows.slice(0, 3));
  assert.equal(first.total, 7);
  assert.equal(first.hidden, true, 'indexed count alone would incorrectly hide Show more');
  const next = activityWindow(setups, indexedRows, 15);
  assert.deepEqual(next.visible, indexedRows);
  assert.equal(next.hidden, false);
  const indexedOnly = activityWindow([], indexedRows, 5);
  assert.deepEqual(indexedOnly.visible, indexedRows);
  assert.equal(indexedOnly.hidden, false);
  const empty = activityWindow([], [], 5);
  assert.equal(empty.total, 0);
  assert.equal(empty.hidden, false);
});
