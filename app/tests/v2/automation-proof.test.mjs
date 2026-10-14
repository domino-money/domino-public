import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { confirmationQueue } from './support/queue.mjs';
const require = createRequire(import.meta.url);
const store = require('../../.test-build/app/src/v2in/automate/store.js');
const { positionRows, receiptViews } = require('../../.test-build/app/src/v2in/lists/model.js');
const fixture = name => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url)));
const hash = value => `0x${value.toString(16).padStart(64, '0')}`;
const module = `0x${'e1'.repeat(20)}`;
const zero = `0x${'00'.repeat(20)}`;
const base = fixture('portfolio');
const root = base.positions[0];
const vault = base.vaults[0].address.toLowerCase();
const owner = base.wallet.toLowerCase();
const nft = { chainId: root.chainId, positionManager: root.positionManager.toLowerCase(), tokenId: root.tokenId, dex: root.dex, wallet: owner, vault, listedBlock: root.state.snapshot.number, listedNonce: 0n };
const proof = (id, events, changes = {}) => ({ chainId: root.chainId, wallet: owner, hash: hash(id), blockHash: hash(id + 100), block: root.state.snapshot.number + id, phase: 'included', at: id, positionManager: nft.positionManager, tokenIds: [root.tokenId], vault, events, ...changes });
const event = (eventName, args) => ({ address: vault, eventName, args });
const apply = op => store.applyAutomationProof(op);
const standing = (identity = nft, indexed) => store.confirmedPositionAutomation(store.automationState(), identity, indexed);

test('three separate setup transactions project one scoped automation state without fabricating balances or replacing index authority', () => {
  store.forgetAutomationSession();
  const started = proof(1, [event('Initialized', { owner, dex: root.dex, rootTokenId: BigInt(root.tokenId), mode: 1 }), event('RootRearmed', { stateNonce: 1n })]);
  const enabled = proof(2, [event('ExitModuleSet', { module, stateNonce: 2n })]);
  const registered = proof(3, [{ address: module, eventName: 'MandateRegistered', args: { owner, vault, tokenId: BigInt(root.tokenId), mandateHash: hash(999) } }]);
  apply(started); apply(enabled); apply(registered);
  assert.deepEqual([standing().name, standing().word, standing().running], ['Auto-exit', null, true]);
  const answer = fixture('portfolio');
  answer.positions = [structuredClone(root)]; answer.positions[0].vault = null; answer.vaults = []; answer.mandates = [];
  const amounts = structuredClone(answer.positions[0].state);
  const row = positionRows(answer, () => true)[0];
  assert.deepEqual(row.vault, { role: 'root', name: 'Auto-exit', word: null, running: true });
  assert.deepEqual(answer.positions[0].state, amounts, 'presentation does not patch liquidity, amounts, custody or snapshot');
  assert.equal(standing({ ...nft, wallet: `0x${'f1'.repeat(20)}` }), null);
  assert.equal(standing({ ...nft, chainId: 8453 }), null);
  assert.equal(standing({ ...nft, tokenId: String(BigInt(root.tokenId) + 1n), vault: undefined }), null);
  assert.equal(standing({ ...nft, positionManager: `0x${'f2'.repeat(20)}`, vault: undefined }), null);
  assert.equal(standing({ ...nft, positionManager: `0x${'f2'.repeat(20)}` }), null, 'an address association does not bypass the NFT manager namespace');
  assert.equal(standing({ ...nft, listedBlock: registered.block }), null, 'newer index snapshot is authoritative');
  assert.deepEqual([standing({ ...nft, halted: true }).word, standing({ ...nft, halted: true }).running], ['Paused', false], 'proof of setup never overrides a chain halt');
  store.forgetAutomationSession();
});

test('creation logs prove the compound mode and armed root, but never invent startPaused before a fresh vault snapshot', () => {
  for (const [mode, name] of [[1, 'Auto-compound'], [2, 'Domino-compound']]) {
    store.forgetAutomationSession();
    // initialize emits Initialized and RootRearmed for both startPaused values, with no
    // AutomationPaused/Resumed log. A batch receipt proves the logs, not the reviewed calldata.
    const created = proof(1, [event('Initialized', { owner, dex: root.dex, rootTokenId: BigInt(root.tokenId), mode }), event('RootRearmed', { stateNonce: 1n })]);
    apply(created);
    assert.deepEqual([standing().name, standing().word, standing().running], [name, 'Updating', false]);
    const answer = fixture('portfolio');
    answer.positions = [structuredClone(root)]; answer.positions[0].vault = null; answer.vaults = []; answer.mandates = [];
    const row = positionRows(answer, () => true)[0];
    assert.deepEqual(row.vault, { role: 'root', name, word: 'Updating', running: false });
    const indexed = { mode: mode === 1 ? 'simple' : 'domino', paused: false, armed: true, module: null, hasExit: false, activeExitIds: [] };
    assert.equal(standing({ ...nft, listedBlock: created.block, listedNonce: 1n }, indexed), null, 'a vault snapshot covering creation supersedes the provisional proof');
    apply({ ...created, phase: 'reorged' });
    assert.equal(standing(), null, 'an orphaned creation cannot retain a running or provisional automation');
  }
  store.forgetAutomationSession();
});

test('proof-origin callbacks and a reorg remove only that transaction; later nonces and unrelated operations survive', () => {
  store.forgetAutomationSession();
  const first = proof(1, [event('ExitModuleSet', { module, stateNonce: 5n }), event('RootRearmed', { stateNonce: 5n })]);
  const later = proof(2, [event('ExitModuleSet', { module: zero, stateNonce: 6n }), event('RootDisarmed', { stateNonce: 6n, reason: 7 })]);
  apply(first); store.recordVaultEvents(root.chainId, vault, first.events);
  apply(later); store.recordVaultEvents(root.chainId, vault, later.events);
  apply({ ...first, phase: 'reorged' });
  assert.deepEqual(store.exitModuleSet(store.automationState(), root.chainId, vault, 4n), { stateNonce: 6n, module: null });
  assert.equal(store.currentEvent(store.automationState(), root.chainId, vault, 6n).kind, 'disarmed');
  apply({ ...later, phase: 'reorged' });
  assert.equal(store.exitModuleSet(store.automationState(), root.chainId, vault, 4n), null, 'a callback cannot preserve orphaned effects in the baseline');
  store.recordVaultEvents(root.chainId, vault, later.events);
  assert.equal(store.exitModuleSet(store.automationState(), root.chainId, vault, 4n), null, 'even a late callback from an orphaned receipt is ignored');
  const mode = proof(3, [event('PolicyChanged', { policy: { mode: 2 }, stateNonce: 9n }), event('AutomationResumed', { stateNonce: 9n })]);
  apply(mode);
  const indexed = { mode: 'simple', paused: true, armed: true, module: null, hasExit: false, activeExitIds: [] };
  assert.equal(standing(nft, indexed).name, 'Domino-compound');
  assert.equal(standing(nft, indexed).running, true);
  assert.equal(standing({ ...nft, listedNonce: 10n }, indexed), null, 'another tab/operator with a newer nonce supersedes old proof');
  store.forgetAutomationSession();
});

test('mandate registration, revocation and approvals retain signed details but roll back their own proof on reorg', () => {
  store.forgetAutomationSession();
  const id = hash(99);
  const entry = { chainId: root.chainId, dex: root.dex, owner, id, nonce: 7n, vault, tokenId: BigInt(root.tokenId), registered: false, triggers: { below: 1n, above: 2n } };
  store.rememberMandate(entry);
  const registered = proof(1, [{ address: module, eventName: 'MandateRegistered', args: { mandateHash: id, owner, vault, tokenId: entry.tokenId } }]);
  apply(registered); store.rememberMandate({ ...entry, registered: true });
  assert.equal(store.sessionMandatesFor(store.automationState(), root.chainId, owner, entry.tokenId, root.dex)[0].registered, true);
  const approved = proof(2, []);
  apply(approved); store.rememberApproval(root.chainId, vault, entry.tokenId, BigInt(approved.block));
  assert.equal(store.approvedAt(store.automationState(), root.chainId, vault, entry.tokenId), BigInt(approved.block));
  const revoked = proof(3, [{ address: module, eventName: 'MandateRevoked', args: { mandateHash: id } }]);
  apply(revoked); store.rememberRevoked(root.chainId, id);
  assert.ok(store.sessionRevoked(store.automationState(), root.chainId).has(id));
  apply({ ...revoked, phase: 'reorged' });
  assert.equal(store.sessionRevoked(store.automationState(), root.chainId).has(id), false);
  apply({ ...approved, phase: 'reorged' });
  assert.equal(store.approvedAt(store.automationState(), root.chainId, vault, entry.tokenId), null);
  apply({ ...registered, phase: 'reorged' });
  const kept = store.sessionMandatesFor(store.automationState(), root.chainId, owner, entry.tokenId, root.dex)[0];
  assert.equal(kept.registered, false);
  assert.deepEqual(kept.triggers, entry.triggers, 'signed data remains, but is never called an active on-chain order');
  store.forgetAutomationSession();
});

// Added 2026-10-14 (incident C3: screens finish at inclusion). An automation step is projected from its block at once (the
// step says "Confirmed"); what it holds until finality (the vault's hand-over latch, the signature journal) is released by
// the settlement the step registers with the confirmation queue (v2in/automate/steps.tsx), once, only after the queue's
// own read bound to that block proves it final. A different block at that read is a reorg: no release, and the proof goes.
test('C3: an automation step is projected from its block at once; its release waits for the queue’s own final proof, runs once, and a proven reorg cancels it', async () => {
  for (const reorg of [false, true]) {
    store.forgetAutomationSession();
    const started = proof(1, [event('Initialized', { owner, dex: root.dex, rootTokenId: BigInt(root.tokenId), mode: 1 }), event('RootRearmed', { stateNonce: 1n })]);
    const number = `0x${started.block.toString(16)}`;
    const finality = { final: false };
    const reader = { read: async () => ({ transaction: {}, receipt: { transactionHash: started.hash, from: owner, blockNumber: number, blockHash: started.blockHash, status: '0x1' },
      block: { number, hash: reorg ? hash(555) : started.blockHash } }), finalized: async () => ({ number: finality.final ? `0x${(started.block + 10).toString(16)}` : '0x1' }) };
    const queue = confirmationQueue(reader);
    queue.store.subscribe(apply);
    let released = 0;
    const operation = queue.store.record({ chainId: started.chainId, wallet: owner, positionManager: nft.positionManager, tokenIds: [root.tokenId], vault,
      receipt: { transactionHash: started.hash, blockHash: started.blockHash, blockNumber: BigInt(started.block), state: 'included', events: started.events },
      onFinalized: async () => { released++; return true; } });
    apply(operation);
    assert.equal(standing()?.name, 'Auto-compound', 'projected from its block at once');
    await queue.run(30 * 60_000);
    assert.deepEqual([queue.calls.length, released], [0, 0], 'nothing read, nothing released before the mark');
    queue.mark(started.chainId, started.block);
    finality.final = true;
    await queue.run(5 * 60_000);
    if (reorg) {
      assert.equal(queue.store.get()[0].phase, 'reorged');
      assert.equal(released, 0, 'a proven reorg releases nothing');
      assert.equal(standing(), null, 'and the proof of that block goes');
    } else {
      assert.equal(queue.store.get()[0].phase, 'finalized');
      assert.equal(released, 1, 'released once, after the proof');
      assert.equal(standing().name, 'Auto-compound');
    }
  }
  store.forgetAutomationSession();
});

test('receipt finality requires the exact block hash, cannot downgrade finalized index evidence, and drops only proved orphan rows', () => {
  const activity = fixture('activity');
  const target = activity.items[0];
  target.tx.finality = 'unfinalized';
  const matched = (chain, tx, blockHash) => chain === target.chainId && tx === target.tx.hash && blockHash === target.tx.snapshot.hash ? 'finalized' : null;
  assert.equal(receiptViews(activity, () => true, null, matched).find(item => item.id === target.id).finalized, true);
  assert.equal(receiptViews(activity, () => true, null, (chain, tx, blockHash) => matched(chain, tx, hash(777))).find(item => item.id === target.id).finalized, false);
  const orphan = (chain, tx, blockHash) => matched(chain, tx, blockHash) ? 'reorged' : null;
  const remaining = receiptViews(activity, () => true, null, orphan);
  assert.equal(remaining.some(item => item.id === target.id), false);
  assert.ok(remaining.length > 0, 'other transactions remain visible');
  target.tx.finality = 'finalized';
  assert.equal(receiptViews(activity, () => true, null, () => 'included').find(item => item.id === target.id).finalized, true);
});
