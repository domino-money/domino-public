/**
 * The post-B4 review's findings in the vault and auto-exit clients (src/finance/v2/vault.ts, autoExit.ts):
 *   F2: a step handed to the wallet whose outcome was lost (no hash came back) is never offered again, from the same
 *       review or a new one at the same vault state, until a definite refusal or a final receipt says what happened;
 *       a refusal, or a send the wallet never saw, lets it be offered again;
 *   F8: every budget is read inside the client's own bounded port at the review (`null`), and on Base the L1 data fee
 *       ceiling is part of a step's and a batch's cost;
 *   item 3: a batch is offered only with nothing of the owner in flight (latest equals pending, no nonce latch held);
 *   item 4: a batch the wallet never saw (WalletNotAsked) lets its latch go.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { OWNER, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { USDG } from './support/plans.mjs';
import { confirmationQueue, edgeReaderOf } from './support/queue.mjs';

const require = createRequire(import.meta.url);
const { createVaultClient, offerV2Batch } = require('../../.test-build/app/src/finance/v2/vault.js');
const auto = require('../../.test-build/app/src/finance/v2/autoExit.js');
const { WalletNotAsked } = require('../../.test-build/app/src/finance/v2/transact.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const ROOT = 3_409_682n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const sends = (chain) => chain.log.filter((m) => m === 'eth_sendTransaction').length;

async function vaultSetup({ chainId = 4663, atomic = null, simulateV1 = false, nonces } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ chainId, positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW, atomic, simulateV1 });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT });
  chain.setIdle(vault, USDG, 5_000_000n);
  const wallet = walletOf(chain, nonces ? { nonces } : {});
  const client = createVaultClient(wallet, chains.v2Chain(chainId), vaultContracts(chainId), () => NOW);
  return { chain, wallet, client, vault };
}
const withdraw = { kind: 'withdraw-reserves', token: USDG, amount: 2_000_000n };

test('F2: a withdrawal whose answer was lost is never offered again (same review or a new one), and the reserves are not paid twice', async () => {
  const { chain, client, vault } = await vaultSetup();
  const review = await client.reviewAction(vault, withdraw);
  const prepared = await client.prepareStep(review, 0, null);
  // The wallet saw the transaction, and its answer was lost (a node's -32603): nothing says what became of it.
  chain.failNext('eth_sendTransaction');
  await assert.rejects(client.send(prepared, true), /Internal JSON-RPC error/);
  assert.equal(client.wasOffered(prepared), true, 'the wallet was asked');
  await assert.rejects(client.send(prepared, true), /wallet_review_required/, 'the same step is never sent twice');
  await assert.rejects(client.prepareStep(review, 0, null), /review_already_sent/);
  const again = await client.reviewAction(vault, withdraw);
  await assert.rejects(client.prepareStep(again, 0, null), /review_already_sent/, 'a new review at the same vault state either');
  assert.equal(sends(chain), 1);
  assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves'), []);
  // Other actions of the vault are not this one's latch.
  const pause = await client.reviewAction(vault, { kind: 'pause' });
  assert.equal(pause.steps[0].kind, 'pause');
});

test('F2: a definite refusal lets the step be offered again; a final receipt does too, and a new state makes a new step', async () => {
  const { chain, client, vault } = await vaultSetup();
  const review = await client.reviewAction(vault, withdraw);
  chain.decline();
  await assert.rejects(client.send(await client.prepareStep(review, 0, null), true), (error) => error.code === 4001);
  const prepared = await client.prepareStep(review, 0, null);
  const hash = await client.send(prepared, true);
  assert.equal((await client.receipt(hash)).state, 'finalized');
  assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => p.amounts[0]), [2_000_000n]);
  // The same amount again: a new review at the vault's new state is a new step.
  const next = await client.reviewAction(vault, withdraw);
  const hash2 = await client.send(await client.prepareStep(next, 0, null), true);
  assert.equal((await client.receipt(hash2)).state, 'finalized');
  assert.equal(chain.paid.filter((p) => p.why === 'withdrawReserves').length, 2);
});

// Added 2026-10-14 (incident C3: screens finish at inclusion). The hand-over latch (vault.ts receipt) is let go only by a
// final receipt. No screen waits for it any more: the automation step registers that read with the page's confirmation
// queue (v2in/automate/steps.tsx), which runs it once the block is final. Until then the step stays held.
test('C3: a sent vault step stays held while it is only in a block; the confirmation queue lets it go once its block is final', async () => {
  const { chain, wallet, client, vault } = await vaultSetup();
  const finality = { final: false };
  wallet.confirmation = edgeReaderOf(chain, finality);
  const review = await client.reviewAction(vault, withdraw);
  const hash = await client.send(await client.prepareStep(review, 0, null), true);
  const included = await client.receipt(hash);
  assert.equal(included.state, 'included');
  assert.equal(client.sentStep(review, 0), hash, 'held: never offered again while it is not final');
  await assert.rejects(client.prepareStep(review, 0, null), /review_already_sent/);
  const queue = confirmationQueue(edgeReaderOf(chain, finality));
  const operation = queue.store.record({ chainId: 4663, wallet: OWNER, tokenIds: [], vault, receipt: included, onFinalized: async () => (await client.receipt(hash)).state === 'finalized' });
  assert.equal(operation.phase, 'included');
  await queue.run(30 * 60_000);
  assert.deepEqual([queue.calls.length, client.sentStep(review, 0)], [0, hash], 'no mark, no read: still held');
  queue.mark(4663, Number(included.blockNumber));
  await queue.run(77_000);
  assert.deepEqual([queue.calls.length, client.sentStep(review, 0)], [1, hash], 'its block not final yet: still held');
  finality.final = true;
  await queue.run(60_000);
  assert.equal(queue.store.get()[0].phase, 'finalized');
  assert.equal(client.sentStep(review, 0), null, 'final: let go by the queue’s settlement');
  assert.equal(sends(chain), 1, 'nothing was sent again');
});

test('F2: recoverToken and the auto-exit actions (register, revoke, cancel a nonce, claim) hold the same latch', async () => {
  const { chain, client, vault } = await vaultSetup();
  chain.setUnaccounted(vault, USDG, 1_000n);
  const recover = await client.reviewAction(vault, { kind: 'recover-token', token: USDG, amount: 1_000n });
  const prepared = await client.prepareStep(recover, 0, null);
  chain.failNext('eth_sendTransaction');
  await assert.rejects(client.send(prepared, true));
  await assert.rejects(client.prepareStep(await client.reviewAction(vault, { kind: 'recover-token', token: USDG, amount: 1_000n }), 0, null), /review_already_sent/);

  forgetV2DeploymentChecks();
  const mchain = createVaultChain({ positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW });
  const mvault = await mchain.seedVault({ dex: 4, tokenId: ROOT });
  mchain.setExitModule(mvault, '0x00000000000000000000000000000000d0d00002');
  mchain.setUnclaimed(OWNER, USDG, 9n);
  let draw = 7n;
  const exit = auto.createAutoExitClient(walletOf(mchain), chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => draw++);
  const order = { vault: mvault, tokenId: ROOT, triggerBelowSqrtPriceX96: 79228162514264337593543950336n, triggerAboveSqrtPriceX96: 0n, receiveMode: 0, convertTo: ZERO, maxSlippageBps: 100, validUntil: 1_798_646_400n, acknowledgedWarnings: true };
  const review = await exit.reviewMandate(order);
  await exit.signMandate(review);
  const index = review.steps.findIndex((s) => s.kind === 'register-mandate');
  const register = await exit.prepareStep(review, index, null);
  mchain.failNext('eth_sendTransaction');
  await assert.rejects(exit.send(register, true));
  assert.equal(exit.wasOffered(register), true);
  await assert.rejects(exit.prepareStep(review, index, null), /review_already_sent/);

  // A claim whose answer was lost, on a client of its own.
  forgetV2DeploymentChecks();
  const cchain = createVaultChain({ positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW });
  cchain.setUnclaimed(OWNER, USDG, 9n);
  const claimer = auto.createAutoExitClient(walletOf(cchain), chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => 1n);
  const claim = await claimer.prepareClaim(USDG, OWNER, null);
  cchain.failNext('eth_sendTransaction');
  await assert.rejects(claimer.send(claim, true));
  await assert.rejects(claimer.prepareClaim(USDG, OWNER, null), /review_already_sent/, 'the same claim (token, recipient, amount) is not offered again');
  assert.deepEqual(cchain.paid.filter((p) => p.why === 'claim'), [], 'nothing claimed twice');
});

test('F8: the budget is read inside the client at the review; on Base a step\'s and a batch\'s cost carry the L1 data fee ceiling', async () => {
  const { chain, client, vault } = await vaultSetup({ chainId: 8453 });
  const before = chain.log.length;
  const prepared = await client.prepareStep(await client.reviewAction(vault, withdraw), 0, null);
  assert.ok(chain.log.slice(before).includes('eth_gasPrice'), 'read by the client, through its bounded port');
  assert.ok(chain.log.slice(before).includes('eth_maxPriorityFeePerGas'), 'Base orders by priority fee');
  const gasLimit = BigInt(prepared.transaction.gas);
  assert.equal(prepared.networkFeeWei, gasLimit * BigInt(prepared.transaction.maxFeePerGas) + 7_000_000_000n, 'the oracle\'s ceiling added');

  forgetV2DeploymentChecks();
  const base = createVaultChain({ chainId: 8453, positions: [{ dex: 4, tokenId: ROOT, pool: { currency0: ZERO, currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', fee: 500, tickSpacing: 10 } }], timestamp: NOW, atomic: 'ready', simulateV1: true });
  const creator = createVaultClient(walletOf(base), chains.v2Chain(8453), vaultContracts(8453), () => NOW);
  const review = await creator.reviewCreate({ dex: 4, tokenId: ROOT, policy: { mode: 1, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: 1 }, limits: { maxSlippageBps: 100, maxPriceImpactBps: 100, maxObservationAgeSeconds: 300, upsideBps: 5000 }, startPaused: true, consentToUncollectedFees: true });
  const batch = await creator.prepareCreateBatch(review);
  const limit = ((batch.gasUsed + 150_000n) * 120n + 99n) / 100n;
  assert.equal(batch.networkFeeWei, limit * 200_000_000n + 7_000_000_000n, 'twice the gas price, and the L1 ceiling of the whole batch');
});

test('item 3: a batch is not offered while anything of the owner is in flight (a nonce latch held)', async () => {
  const nonces = new Map();
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW, atomic: 'ready', simulateV1: true });
  const client = createVaultClient(walletOf(chain, { nonces }), chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  const review = await client.reviewCreate({ dex: 4, tokenId: ROOT, policy: { mode: 1, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: 1 }, limits: { maxSlippageBps: 100, maxPriceImpactBps: 100, maxObservationAgeSeconds: 300, upsideBps: 5000 }, startPaused: true, consentToUncollectedFees: true });
  // Another step of this owner was offered and its outcome is not known: its nonce latch is held.
  nonces.set(`4663|${OWNER}|0`, 'claim-elsewhere');
  await assert.rejects(client.prepareCreateBatch(review), /pending_wallet_transaction/);
  nonces.clear();
  const batch = await client.prepareCreateBatch(review);
  nonces.set(`4663|${OWNER}|0`, 'claim-elsewhere');
  await assert.rejects(client.sendBatch(batch, true, () => ({ batchOffered: () => null, claimBatch: async () => 'c', recordBatch: async () => {}, releaseBatch: async () => {}, expireBatch: async () => false })), /pending_wallet_transaction/);
  assert.equal(chain.log.filter((m) => m === 'wallet_sendCalls').length, 0);
});

test('item 4: a batch the wallet never saw (refused by the bounded port before the provider) lets its latch go', async () => {
  const store = new Map();
  const latch = {
    batchOffered: (key) => (store.has(key) ? store.get(key).id ?? '' : null),
    async claimBatch(key) { store.set(key, { claim: 'c1', id: null }); return 'c1'; },
    async recordBatch(key, claim, id) { store.get(key).id = id; },
    async releaseBatch(key, claim) { if (store.get(key)?.claim === claim) store.delete(key); },
    async expireBatch() { return false; },
  };
  const key = `0x${'aa'.repeat(32)}`;
  const calls = [{ to: '0x00000000000000000000000000000000d0d00006', data: '0x', value: '0x0' }];
  const rpc = async () => { throw new WalletNotAsked('wallet_wrong_chain'); };
  await assert.rejects(offerV2Batch(rpc, OWNER, 4663, latch, key, calls, () => true), /wallet_wrong_chain/);
  assert.equal(store.size, 0, 'never asked: nothing of it can run, the latch is let go');
  // An answer that was lost after the wallet was asked keeps it.
  const lost = async () => { throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }); };
  await assert.rejects(offerV2Batch(lost, OWNER, 4663, latch, key, calls, () => true));
  assert.equal(store.size, 1);
});
