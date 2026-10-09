/**
 * The vault's and the mandate's EIP-5792 batches (src/finance/v2/vault.ts prepareCreateBatch / sendBatch /
 * batchReceipt, autoExit.ts prepareRegisterBatch / sendRegisterBatch / registerBatchReceipt; spec F7 §5.1 "Lote", §4.4
 * item 7, §8.2 "Criar vault") against the fake V2 vault chain with atomic support on and off: the exact calls, ONE
 * wallet_sendCalls on the action's chain, the batch simulated through the wallet only, the page's latch claimed before
 * the wallet is asked and let go on a refusal, an unsupported batch or once the batch ran; a batch never offered twice;
 * a chain changed before the offer refused; another vault landing first (UnexpectedNonce) leading to a new prediction
 * and a new batch under a new latch key. Rev3 (§2.13, §5.6): every reserve back to the owner as ONE batch of
 * withdrawReserves, whatever the root's state.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ABI, OTHER, OWNER, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { FAKE, USDG } from './support/plans.mjs';
import { confirmationReader } from '../support/confirmation-route.mjs';

const require = createRequire(import.meta.url);
const { createVaultClient, vaultBatchKey, withdrawBatchKey } = require('../../.test-build/app/src/finance/v2/vault.js');
const auto = require('../../.test-build/app/src/finance/v2/autoExit.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROOT = 3_409_682n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const POLICY = Object.freeze({ mode: 1, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: 1 });
const LIMITS = Object.freeze({ maxSlippageBps: 100, maxPriceImpactBps: 100, maxObservationAgeSeconds: 300, upsideBps: 5000 });
const request = () => ({ dex: 4, tokenId: ROOT, policy: POLICY, limits: LIMITS, startPaused: true, consentToUncollectedFees: true });
const AUTO_EXIT = FAKE.autoExit.toLowerCase();

/** The page's batch latch, in memory: inspectable, shared by "two tabs" when passed to both. */
function memoryLatch() {
  const store = new Map();
  let n = 0;
  const latch = {
    store,
    batchOffered: (key) => (store.has(key) ? store.get(key).id ?? '' : null),
    async claimBatch(key) {
      if (store.has(key)) throw new Error('wallet_batch_already_offered');
      const claim = `claim-${++n}`;
      store.set(key, { claim, id: null });
      return claim;
    },
    async recordBatch(key, claim, id) { const entry = store.get(key); if (entry?.claim === claim) entry.id = id; },
    async releaseBatch(key, claim) { const entry = store.get(key); if (entry && claim !== '' && (entry.claim === claim || entry.id === claim)) store.delete(key); },
    async expireBatch() { return false; },
  };
  return latch;
}

/** The chain as the V2Wallet, with an optional hook run right before the wallet is asked `method`. */
function hookedWallet(chain, before = {}) {
  const wallet = walletOf(chain);
  const request = wallet.request;
  return { ...wallet, request: async (method, params) => { await before[method]?.(); return request(method, params); } };
}

function setup({ atomic = 'ready', simulateV1 = true, before } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW, atomic, simulateV1 });
  const wallet = hookedWallet(chain, before);
  const client = createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  return { chain, wallet, client };
}
const sendCalls = (chain) => chain.log.filter((method) => method === 'wallet_sendCalls').length;

function detachedConfirmation(chain, wallet) {
  let final = false;
  const walletCalls = [];
  const request = wallet.request;
  wallet.request = (method, params) => { walletCalls.push(method); return request(method, params); };
  wallet.confirmation = confirmationReader(chain, { finalized: async () => final ? { number: '0xffffffff' } : null });
  return { walletCalls, disconnect() { wallet.current = () => false; wallet.chainId = () => 8453; walletCalls.length = 0; }, finalize() { final = true; } };
}

test('a known create batch follows the fixed node after wallet disconnection; unknown ids and fresh sends remain blocked', async () => {
  const { chain, wallet, client } = setup();
  const reads = detachedConfirmation(chain, wallet), latch = memoryLatch();
  const batch = await client.prepareCreateBatch(await client.reviewCreate(request()), GAS);
  const id = await client.sendBatch(batch, true, () => latch);
  reads.disconnect();
  await assert.rejects(client.batchReceipt(id, () => latch), /wallet_action_expired|wallet_wrong_chain/, 'a batch id alone cannot bypass its wallet envelope');
  wallet.current = () => true; wallet.chainId = () => chain.chainNow();
  const included = await client.batchReceipt(id, () => latch);
  assert.equal(included.state, 'included');
  assert.ok(included.transactionHash, 'the wallet envelope binds the exact transaction');
  reads.disconnect(); reads.finalize();
  const final = await client.batchReceipt(id, () => latch);
  assert.equal(final.state, 'finalized');
  assert.equal(final.transactionHash, included.transactionHash);
  assert.deepEqual(reads.walletCalls, [], 'detached tracking does not touch the wallet');
  await assert.rejects(client.batchReceipt('unknown-batch', () => latch), /receipt_not_from_this_review/);
  await assert.rejects(client.sendBatch(batch, true, () => latch), /wallet_review_required/);
  assert.equal(sendCalls(chain), 1, 'no repeated offer');
});

test('a known reserve withdrawal batch finalizes after wallet disconnection without reading wallet status again', async () => {
  const { chain, wallet, client } = setup();
  const reads = detachedConfirmation(chain, wallet), latch = memoryLatch();
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setIdle(vault, USDG, 5_000_000n); chain.setIdle(vault, ZERO, 1000n);
  const batch = await client.prepareWithdrawAllBatch(vault, GAS);
  const id = await client.sendWithdrawAllBatch(batch, true, () => latch);
  const included = await client.withdrawAllReceipt(id, () => latch);
  assert.equal(included.state, 'included');
  reads.disconnect(); reads.finalize();
  const final = await client.withdrawAllReceipt(id, () => latch);
  assert.equal(final.state, 'finalized');
  assert.equal(final.transactionHash, included.transactionHash);
  assert.equal(final.events.filter(event => event.eventName === 'ReservesWithdrawn').length, 2);
  assert.deepEqual(reads.walletCalls, []);
  assert.equal(sendCalls(chain), 1);
});

test('atomic support is read from the wallet for the action\'s chain; a wallet that states none keeps the steps', async () => {
  assert.equal(await setup({ atomic: 'ready' }).client.atomicSupport(), 'ready');
  assert.equal(await setup({ atomic: 'supported' }).client.atomicSupport(), 'supported');
  assert.equal(await setup({ atomic: null }).client.atomicSupport(), 'unsupported');
});

test('create as ONE batch: [approve(predicted vault, tokenId), createVault(init, n)] exactly as reviewed, one wallet_sendCalls on 0x1237, the latch claimed then let go once it ran', async () => {
  const { chain, client } = setup();
  const latch = memoryLatch();
  const review = await client.reviewCreate(request());
  const batch = await client.prepareCreateBatch(review, GAS);
  assert.deepEqual(batch.kinds, ['approve-root', 'create-vault']);
  assert.deepEqual(batch.calls.map((c) => [c.to, c.data, c.value]), review.steps.map((s) => [s.to, s.data, '0x0']), 'the review\'s own calldata');
  assert.equal(batch.key, vaultBatchKey(4663, review.factory, OWNER, 0n));
  assert.equal(batch.vault, chain.predict(4, OWNER, 0n));
  assert.ok(chain.log.includes('eth_simulateV1'), 'simulated through the wallet');
  assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.calls));
  assert.deepEqual(chain.sends, [], 'nothing sent by a preparation');

  const id = await client.sendBatch(batch, true, () => latch);
  assert.equal(sendCalls(chain), 1);
  assert.equal(chain.batches.length, 1);
  assert.equal(chain.batches[0].chainId, '0x1237');
  const [approve, create] = chain.batches[0].calls;
  assert.deepEqual(decodeFunctionData({ abi: ABI.v4, data: approve.data }).args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [batch.vault, ROOT]);
  assert.equal(approve.to.toLowerCase(), chains.v2Chain(4663).uniswap.v4.positionManager);
  assert.equal(create.data.slice(0, 10), '0xee568446');
  assert.equal(decodeFunctionData({ abi: ABI.factory, data: create.data }).args[1], 0n);
  assert.equal(latch.store.get(batch.key).id, id, 'the wallet\'s id kept with the claim');

  const receipt = await client.batchReceipt(id, () => latch);
  assert.equal(receipt.state, 'finalized');
  assert.deepEqual(receipt.events.filter((e) => e.eventName === 'VaultCreated').map((e) => e.args.vault.toLowerCase()), [batch.vault]);
  assert.deepEqual(receipt.events.filter((e) => e.address === batch.vault).map((e) => e.eventName), ['Initialized', 'PolicyChanged', 'LimitsChanged', 'RootRearmed']);
  assert.equal(latch.batchOffered(batch.key), null, 'let go once it ran');
  assert.equal(chain.vault(batch.vault).owner, OWNER);
  assert.ok(!chain.log.includes('eth_sendTransaction'), 'no step was sent');

  // Never offered twice: the batch is spent, and the review's nonce has moved on.
  await assert.rejects(client.sendBatch(batch, true, () => latch), /wallet_review_required/);
  // The review is spent too: its root now belongs to the vault it made (its subscriber), and the factory's nonce moved.
  await assert.rejects(client.prepareCreateBatch(review, GAS), /vault_foreign_subscriber|vault_nonce_moved/);
  assert.equal(sendCalls(chain), 1);
});

test('a batch latched by another tab is not offered again; a refusal and an unsupported batch let the latch go', async () => {
  const latch = memoryLatch();
  const first = setup();
  const r1 = await first.client.reviewCreate(request());
  const b1 = await first.client.prepareCreateBatch(r1, GAS);
  // Another tab of the same page claimed this owner's batch for factory nonce 0.
  await latch.claimBatch(b1.key);
  await assert.rejects(first.client.sendBatch(b1, true, () => latch), /batch_already_offered/);
  assert.equal(sendCalls(first.chain), 0);

  const refused = setup();
  const latch2 = memoryLatch();
  const r2 = await refused.client.reviewCreate(request());
  refused.chain.declineBatch(4001);
  await assert.rejects(refused.client.sendBatch(await refused.client.prepareCreateBatch(r2, GAS), true, () => latch2), (error) => error.code === 4001);
  assert.equal(latch2.store.size, 0, 'a definite refusal: nothing can run, the latch is let go');
  assert.equal(refused.chain.vault(refused.chain.predict(4, OWNER, 0n)), undefined);
  // The same review is offered again as a new batch, and runs.
  const again = await refused.client.prepareCreateBatch(r2, GAS);
  const id = await refused.client.sendBatch(again, true, () => latch2);
  assert.equal((await refused.client.batchReceipt(id, () => latch2)).state, 'finalized');

  const unsupported = setup();
  const latch3 = memoryLatch();
  const r3 = await unsupported.client.reviewCreate(request());
  unsupported.chain.declineBatch(5700);
  await assert.rejects(unsupported.client.sendBatch(await unsupported.client.prepareCreateBatch(r3, GAS), true, () => latch3), /batch_unsupported/);
  assert.equal(latch3.store.size, 0);
  const upgrade = setup();
  const latch4 = memoryLatch();
  const r4 = await upgrade.client.reviewCreate(request());
  upgrade.chain.declineBatch(5750);
  await assert.rejects(upgrade.client.sendBatch(await upgrade.client.prepareCreateBatch(r4, GAS), true, () => latch4), /batch_upgrade_declined/);
  assert.equal(latch4.store.size, 0);
});

test('the wallet moved to another chain before the offer: refused, nothing asked of the wallet, no latch taken', async () => {
  let chainRef = null;
  let simulations = 0;
  const { chain, client } = setup({ before: { eth_simulateV1: () => { simulations++; if (simulations === 2) chainRef.switchChain(8453); } } });
  chainRef = chain;
  const latch = memoryLatch();
  const review = await client.reviewCreate(request());
  const batch = await client.prepareCreateBatch(review, GAS);
  await assert.rejects(client.sendBatch(batch, true, () => latch), /wallet_wrong_chain/);
  assert.equal(sendCalls(chain), 0);
  assert.equal(latch.store.size, 0);
});

test('a wallet without eth_simulateV1 keeps the steps (no other node is asked); an approval already given is a single step', async () => {
  const { client } = setup({ simulateV1: false });
  const review = await client.reviewCreate(request());
  await assert.rejects(client.prepareCreateBatch(review, GAS), /batch_simulation_unavailable/);
  const given = setup();
  given.chain.approveOther(4, ROOT, given.chain.predict(4, OWNER, 0n));
  const single = await given.client.reviewCreate(request());
  assert.deepEqual(single.steps.map((s) => s.kind), ['create-vault']);
  await assert.rejects(given.client.prepareCreateBatch(single, GAS), /batch_not_needed/);
});

test('UnexpectedNonce: another vault lands before the review\'s batch (refused before the wallet), or inside it (reverted whole): a new prediction, a new approval, a new latch key', async () => {
  const early = setup();
  const latch = memoryLatch();
  const old = await early.client.reviewCreate(request());
  early.chain.moveNonce(4);
  await assert.rejects(early.client.prepareCreateBatch(old, GAS), /vault_nonce_moved/);
  const fresh = await early.client.reviewCreate(request());
  assert.equal(fresh.nonce, 1n);
  const batch = await early.client.prepareCreateBatch(fresh, GAS);
  assert.notEqual(batch.key, vaultBatchKey(4663, old.factory, OWNER, 0n));
  assert.equal(decodeFunctionData({ abi: ABI.v4, data: batch.calls[0].data }).args[0].toLowerCase(), early.chain.predict(4, OWNER, 1n), 'approved to the NEW prediction');
  assert.equal((await early.client.batchReceipt(await early.client.sendBatch(batch, true, () => latch), () => latch)).state, 'finalized');

  // Inside the batch: the other tab's vault lands right before the wallet runs it.
  let chainRef = null;
  const late = setup({ before: { wallet_sendCalls: () => { chainRef.moveNonce(4); } } });
  chainRef = late.chain;
  const latch2 = memoryLatch();
  const review = await late.client.reviewCreate(request());
  const inside = await late.client.prepareCreateBatch(review, GAS);
  const id = await late.client.sendBatch(inside, true, () => latch2);
  const receipt = await late.client.batchReceipt(id, () => latch2);
  assert.equal(receipt.state, 'batch-reverted', 'reverted whole: the approval did not run either');
  assert.equal(late.chain.nft(4, ROOT).approved, ZERO);
  assert.equal(latch2.store.size, 0, 'nothing of it ran: let go');
  const next = await late.client.reviewCreate(request());
  assert.equal(next.nonce, 1n);
  const retry = await late.client.prepareCreateBatch(next, GAS);
  assert.equal(retry.vault, late.chain.predict(4, OWNER, 1n));
  assert.notEqual(retry.key, inside.key);
});

test('a batch the wallet still holds stays latched and pending; once it runs, Included or Finalized, and let go', async () => {
  const { chain, client } = setup();
  const latch = memoryLatch();
  const review = await client.reviewCreate(request());
  chain.holdBatches();
  const id = await client.sendBatch(await client.prepareCreateBatch(review, GAS), true, () => latch);
  assert.equal((await client.batchReceipt(id, () => latch)).state, 'pending');
  assert.equal(latch.store.size, 1, 'held while it may still run');
  chain.releaseBatches();
  assert.equal((await client.batchReceipt(id, () => latch)).state, 'finalized');
  assert.equal(latch.store.size, 0);
  await assert.rejects(client.batchReceipt('0xnot-ours', () => latch), /receipt_not_from_this_review/);
});

// ---------------------------------------------------------------------------
// The mandate's batch (spec §4.4 item 7)
// ---------------------------------------------------------------------------

const Q96 = 79228162514264337593543950336n;
const order = (vault, fields = {}) => ({ vault, tokenId: ROOT, triggerBelowSqrtPriceX96: Q96, triggerAboveSqrtPriceX96: 0n, receiveMode: 1, convertTo: USDG, maxSlippageBps: 100, validUntil: 1_798_646_400n, acknowledgedWarnings: true, ...fields });

async function mandateSetup({ atomic = 'ready', simulateV1 = true, module = ZERO } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW, atomic, simulateV1 });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT });
  if (module !== ZERO) chain.setExitModule(vault, module);
  const wallet = walletOf(chain);
  let draw = 41n;
  const client = auto.createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => draw++);
  return { chain, wallet, client, vault };
}

test('a known registration batch releases only its finalized signed nonce after the wallet disconnects', async () => {
  const { chain, wallet, client, vault } = await mandateSetup();
  const reads = detachedConfirmation(chain, wallet), latch = memoryLatch();
  const review = await client.reviewMandate(order(vault));
  await client.signMandate(review);
  const batch = await client.prepareRegisterBatch(review, GAS);
  const id = await client.sendRegisterBatch(batch, true, () => latch);
  const included = await client.registerBatchReceipt(id, () => latch);
  assert.equal(included.state, 'included');
  assert.equal(wallet.held.size, 1, 'inclusion alone cannot release the signature nonce');
  reads.disconnect(); reads.finalize();
  const read = wallet.confirmation.read;
  wallet.confirmation.read = async hash => {
    const answer = await read(hash);
    return { ...answer, transaction: { ...answer.transaction, from: OTHER.toLowerCase() }, receipt: { ...answer.receipt, from: OTHER.toLowerCase() } };
  };
  const final = await client.registerBatchReceipt(id, () => latch);
  assert.equal(final.state, 'finalized');
  assert.equal(final.transactionHash, included.transactionHash);
  assert.equal(wallet.held.size, 0, 'canonical finality settles the reviewed nonce even when the AA gas payer differs');
  assert.deepEqual(reads.walletCalls, []);
  assert.equal(sendCalls(chain), 1);
});

test('after the signature: [setExitModule(autoExit), registerMandate(mandate, signature)] as ONE batch; registered, the latch let go, the nonce released at finality', async () => {
  const { chain, wallet, client, vault } = await mandateSetup();
  const latch = memoryLatch();
  assert.equal(await client.atomicSupport(), 'ready');
  const review = await client.reviewMandate(order(vault));
  assert.deepEqual(review.steps.map((s) => s.kind), ['enable-exit-module', 'sign-mandate', 'register-mandate']);
  await assert.rejects(client.prepareRegisterBatch(review, GAS), /mandate_not_signed/, 'only after the signature');
  const signed = await client.signMandate(review);
  const batch = await client.prepareRegisterBatch(review, GAS);
  assert.equal(batch.key, review.id, 'latched by the order\'s id');
  assert.deepEqual(batch.kinds, ['enable-exit-module', 'register-mandate']);
  assert.deepEqual(batch.calls.map((c) => c.to.toLowerCase()), [vault, AUTO_EXIT]);
  assert.deepEqual(decodeFunctionData({ abi: ABI.vault, data: batch.calls[0].data }).args.map((a) => a.toLowerCase()), [AUTO_EXIT]);
  assert.equal(batch.calls[1].data.slice(0, 10), '0x68c665c2');
  const [mandate, signature] = decodeFunctionData({ abi: ABI.autoExit, data: batch.calls[1].data }).args;
  assert.equal(signature.toLowerCase(), signed.signature);
  assert.equal(mandate.nonce, review.mandate.nonce);

  const id = await client.sendRegisterBatch(batch, true, () => latch);
  assert.equal(sendCalls(chain), 1);
  assert.equal(chain.batches[0].chainId, '0x1237');
  const receipt = await client.registerBatchReceipt(id, () => latch);
  assert.equal(receipt.state, 'finalized');
  assert.deepEqual(receipt.events.map((e) => e.eventName).filter((n) => n === 'MandateRegistered' || n === 'ExitModuleSet'), ['ExitModuleSet', 'MandateRegistered']);
  assert.equal(latch.store.size, 0);
  assert.equal(chain.vault(vault).exitModule, AUTO_EXIT);
  assert.equal((await client.status(review.id)).status, 'active');
  assert.deepEqual(wallet.held.size, 0, 'the order\'s nonce left the journal once its registration was final');
  await assert.rejects(client.sendRegisterBatch(batch, true, () => latch), /wallet_review_required/, 'never offered twice');
  await assert.rejects(client.prepareRegisterBatch(review, GAS), /batch_not_needed|mandate_already_registered/);
});

test('the module already on: no batch, the registration goes alone; a refusal lets the latch go and keeps the signature held', async () => {
  const on = await mandateSetup({ module: FAKE.autoExit });
  const review = await on.client.reviewMandate(order(on.vault));
  assert.deepEqual(review.steps.map((s) => s.kind), ['sign-mandate', 'register-mandate']);
  await on.client.signMandate(review);
  await assert.rejects(on.client.prepareRegisterBatch(review, GAS), /batch_not_needed/);

  const off = await mandateSetup();
  const latch = memoryLatch();
  const r = await off.client.reviewMandate(order(off.vault));
  await off.client.signMandate(r);
  off.chain.declineBatch(4001);
  await assert.rejects(off.client.sendRegisterBatch(await off.client.prepareRegisterBatch(r, GAS), true, () => latch), (error) => error.code === 4001);
  assert.equal(latch.store.size, 0);
  assert.equal(off.wallet.held.size, 1, 'the signed order\'s nonce stays held (cancelNonce, or a new offer)');
  const again = await off.client.prepareRegisterBatch(r, GAS);
  assert.equal((await off.client.registerBatchReceipt(await off.client.sendRegisterBatch(again, true, () => latch), () => latch)).state, 'finalized');
});

test('rev3: every reserve back as ONE batch of withdrawReserves (no fee) with the root burned; one token is the single step; nothing left is refused; never offered twice', async () => {
  const { chain, client } = setup();
  const latch = memoryLatch();
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setIdle(vault, USDG, 5_000_000n);
  await assert.rejects(client.prepareWithdrawAllBatch(vault, GAS), /batch_not_needed/, 'one token: the single step does it');
  chain.setIdle(vault, ZERO, 2_000_000_000_000_000n);
  // The root closed outside the vault (the S1 exit burns it): the reserves stay in the vault, and stay withdrawable.
  chain.closeRoot(4, ROOT, { burn: true });
  const stateNonce = chain.vault(vault).stateNonce;
  const batch = await client.prepareWithdrawAllBatch(vault, GAS);
  assert.deepEqual(batch.amounts.map((a) => [a.token, a.amount]), [[ZERO, 2_000_000_000_000_000n], [USDG, 5_000_000n]]);
  assert.equal(batch.key, withdrawBatchKey(4663, vault, OWNER, stateNonce));
  assert.deepEqual(batch.calls.map((c) => [c.to, c.value, c.data.slice(0, 10)]), [[vault, '0x0', '0xf28bf186'], [vault, '0x0', '0xf28bf186']]);
  // Changed on purpose 2026-10-04 (rugged97's #323): each call names the recipient, always the owner's own wallet.
  assert.deepEqual(batch.calls.map((c) => decodeFunctionData({ abi: ABI.vault, data: c.data }).args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a))), [[ZERO, 2_000_000_000_000_000n, OWNER], [USDG, 5_000_000n, OWNER]]);
  const id = await client.sendWithdrawAllBatch(batch, true, () => latch);
  assert.equal(sendCalls(chain), 1, 'one wallet prompt');
  assert.equal(chain.batches[0].chainId, '0x1237');
  assert.ok(latch.store.has(batch.key), 'the latch held while the batch runs');
  const receipt = await client.withdrawAllReceipt(id, () => latch);
  assert.equal(receipt.state, 'finalized');
  assert.deepEqual(receipt.events.filter((e) => e.eventName === 'ReservesWithdrawn').map((e) => [e.args.token.toLowerCase(), e.args.amount]), [[ZERO, 2_000_000_000_000_000n], [USDG, 5_000_000n]]);
  assert.equal(latch.store.size, 0, 'let go once it ran');
  assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[OWNER, ZERO, 2_000_000_000_000_000n], [OWNER, USDG, 5_000_000n]], 'all to the owner, no fee');
  await assert.rejects(client.sendWithdrawAllBatch(batch, true, () => latch), /wallet_review_required/, 'never offered twice');
  await assert.rejects(client.prepareWithdrawAllBatch(vault, GAS), /vault_reserves_empty/);
});

test('rev3: a withdraw-all batch refused by the wallet lets its latch go; a single withdrawal whose answer was lost refuses the batch at that vault state', async () => {
  const { chain, client } = setup();
  const latch = memoryLatch();
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  chain.setIdle(vault, USDG, 5_000_000n);
  chain.setIdle(vault, ZERO, 1_000n);
  chain.declineBatch(4001);
  await assert.rejects(client.sendWithdrawAllBatch(await client.prepareWithdrawAllBatch(vault, GAS), true, () => latch), (error) => error.code === 4001);
  assert.equal(latch.store.size, 0, 'a definite refusal: nothing ran');
  const prepared = await client.prepareStep(await client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: 5_000_000n }), 0, null);
  chain.failNext('eth_sendTransaction');
  await assert.rejects(client.send(prepared, true));
  assert.equal(client.wasOffered(prepared), true);
  await assert.rejects(client.prepareWithdrawAllBatch(vault, GAS), /review_already_sent/, 'nothing offered twice, as a batch either');
});

// Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): a withdrawal's own recipient, in the batch too.
test('delta §2 item 1: once a token refused the wallet, the withdraw-all batch goes to another address the owner names, derived again with it before the wallet', async () => {
  const { chain, client } = setup();
  const latch = memoryLatch();
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setIdle(vault, USDG, 5_000_000n);
  chain.setIdle(vault, ZERO, 2_000_000_000_000_000n);
  chain.refuseTransfers(USDG, OWNER);
  await assert.rejects(client.prepareWithdrawAllBatch(vault, GAS), /batch_simulation_reverted/, 'the token refuses the wallet: the batch would revert, and the steps say why');
  const other = OTHER.toLowerCase();
  const batch = await client.prepareWithdrawAllBatch(vault, GAS, OTHER);
  assert.equal(batch.recipient, other);
  assert.deepEqual(batch.calls.map((c) => decodeFunctionData({ abi: ABI.vault, data: c.data }).args[2].toLowerCase()), [other, other]);
  const id = await client.sendWithdrawAllBatch(batch, true, () => latch);
  assert.equal((await client.withdrawAllReceipt(id, () => latch)).state, 'finalized');
  assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => [p.to, p.tokens[0]]), [[other, ZERO], [other, USDG]]);
  await assert.rejects(client.prepareWithdrawAllBatch(vault, GAS, ZERO), /vault_recipient_invalid/, 'never address(0)');
});
