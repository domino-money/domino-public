/**
 * Added 2026-10-06 (the owner's point 5: Auto-exit turned on as a signature plus ONE confirmation; rugged97: "it is
 * AUTO-EXIT, separate from the rest, automatic"). The auto-exit client (src/finance/v2/autoExit.ts) against the fake V2
 * vault chain, for a plain position with no vault yet:
 *   - the order is reviewed for the vault the wallet's next createVault makes (`newVault`: exactly
 *     predictVault(owner, nextNonce(owner)), still free, the position held by the wallet), and signed before it exists;
 *   - ONE wallet_sendCalls carries [approve(predicted vault, tokenId), createVault(protection-only Init),
 *     setExitModule(autoExit), registerMandate(mandate, signature)], the approval and the creation exactly as the vault
 *     client derives them; the vault is created paused with its module on, the order active, the nonce released once
 *     final, the latch (the vault's creation key) let go;
 *   - without batching, the same calls go one by one: the vault client's approval and creation, then this client's
 *     module step and registration;
 *   - another vault of the wallet landing first refuses the signature and the batch (`vault_nonce_moved`); only the
 *     protection-only vault rides in the batch; a vault that is not the prediction, or a position the wallet does not
 *     hold, is refused at the review.
 * Changed on purpose 2026-10-06 (the review of point 5: an edge the price has already crossed fires on the operator's
 * next pass and closes the position at once): the pool's own price is read on chain at the review, before the signature,
 * before the batch and before the registration step; an armed trigger it has reached is `mandate_trigger_reached`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ABI, OTHER, OWNER, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { FAKE, USDG } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const auto = require('../../.test-build/app/src/finance/v2/autoExit.js');
const { createVaultClient, vaultBatchKey } = require('../../.test-build/app/src/finance/v2/vault.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 3_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const PLAIN = 3_600_001n;
const THEIRS = 3_600_002n;
const SECOND = 3_600_003n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const ETH_USDG_KEY = { ...ETH_USDG, hooks: ZERO };
const AUTO_EXIT = FAKE.autoExit.toLowerCase();
const FACTORY = FAKE.vaultFactoryV4.toLowerCase();
/** The protection-only vault (spec F7 §5.1 decision #25), as src/v2in/automate/form.ts protectionSettings() gives it. */
const PROTECTION = Object.freeze({
  policy: Object.freeze({ mode: 1, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 600, maxPositions: 1 }),
  limits: Object.freeze({ maxSlippageBps: 100, maxPriceImpactBps: 100, maxObservationAgeSeconds: 300, upsideBps: 5000 }),
});
const create = (fields = {}) => ({ dex: 4, tokenId: PLAIN, ...PROTECTION, startPaused: true, consentToUncollectedFees: true, ...fields });
// The range's two edges as sqrt prices (any two in order serve the client; the screens derive them from the ticks).
const BELOW = 3_543_191_142_285_914_205_922_034n;
const ABOVE = 4_687_201_305_027_700_927_646_043n;
/** The pool's price, between the two edges: both are ahead of it. */
const INSIDE = (BELOW + ABOVE) / 2n;
const order = (vault, fields = {}) => ({
  vault, newVault: { dex: 4 }, tokenId: PLAIN, triggerBelowSqrtPriceX96: BELOW, triggerAboveSqrtPriceX96: ABOVE, receiveMode: 0, convertTo: ZERO,
  maxSlippageBps: 100, validUntil: BigInt(NOW + 365 * 86_400), acknowledgedWarnings: true, ...fields,
});

/** The page's batch latch, in memory. */
function memoryLatch() {
  const store = new Map();
  let n = 0;
  return {
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
}

function setup({ atomic = 'ready', simulateV1 = true } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ chainId: 4663, timestamp: NOW, atomic, simulateV1, positions: [
    { dex: 4, tokenId: PLAIN, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 },
    { dex: 4, tokenId: THEIRS, pool: ETH_USDG, owner: OTHER },
    { dex: 4, tokenId: SECOND, pool: ETH_USDG },
  ] });
  chain.setPrice(4, ETH_USDG_KEY, INSIDE);
  const wallet = walletOf(chain);
  let draw = 71n;
  const client = auto.createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => draw++);
  const vaults = createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  return { chain, wallet, client, vaults };
}
const sendCalls = (chain) => chain.log.filter((method) => method === 'wallet_sendCalls').length;

test('a plain position: the order is reviewed and signed for the predicted vault, then ONE batch creates the protection-only vault, turns Auto-exit on and registers it', async () => {
  const { chain, wallet, client, vaults } = setup();
  const latch = memoryLatch();
  const created = await vaults.reviewCreate(create());
  assert.equal(created.vault, chain.predict(4, OWNER, 0n));
  const review = await client.reviewMandate(order(created.vault));
  assert.deepEqual(review.predicted, { factory: FACTORY, nonce: 0n }, 'the vault the wallet\'s next createVault makes');
  assert.equal(review.vault, created.vault);
  assert.equal(review.mandate.vault, created.vault, 'signed for the predicted vault');
  assert.equal(review.role, 'root');
  assert.deepEqual(review.steps.map((s) => s.kind), ['sign-mandate', 'enable-exit-module', 'register-mandate']);
  assert.deepEqual([review.pool.currency0, review.pool.currency1, review.pool.fee, review.pool.tickSpacing], [ZERO, USDG, 3000, 60]);
  assert.deepEqual(review.receive, { mode: 'both' });
  assert.equal(chain.vault(created.vault), undefined, 'nothing exists yet');
  await assert.rejects(client.prepareProtectBatch(review, create(), GAS), /mandate_not_signed/, 'only after the signature');

  const signed = await client.signMandate(review);
  assert.equal(signed.digest, review.digest);
  assert.equal(chain.log.filter((method) => method === 'eth_signTypedData_v4').length, 1, 'one signature');
  const batch = await client.prepareProtectBatch(review, create(), GAS);
  assert.deepEqual(batch.kinds, ['approve-root', 'create-vault', 'enable-exit-module', 'register-mandate']);
  assert.equal(batch.key, vaultBatchKey(4663, FACTORY, OWNER, 0n), 'latched as the vault\'s creation');
  assert.equal(batch.id, review.id);
  assert.deepEqual(batch.calls.map((call) => call.to.toLowerCase()), [chain.positionManager[4].toLowerCase(), FACTORY, created.vault, AUTO_EXIT]);
  // The approval and the creation are exactly the vault client's own review's.
  assert.deepEqual(batch.calls.slice(0, 2).map((call) => [call.to, call.data]), created.steps.map((step) => [step.to, step.data]));
  const init = decodeFunctionData({ abi: ABI.factory, data: batch.calls[1].data }).args[0];
  assert.deepEqual([init.startPaused, init.policy.mode, init.policy.maxPositions, init.consentToUncollectedFees], [true, 1, 1, true], 'the protection-only vault');
  assert.deepEqual(decodeFunctionData({ abi: ABI.vault, data: batch.calls[2].data }).args.map((a) => a.toLowerCase()), [AUTO_EXIT]);
  const [mandate, signature] = decodeFunctionData({ abi: ABI.autoExit, data: batch.calls[3].data }).args;
  assert.equal(signature.toLowerCase(), signed.signature);
  assert.deepEqual([mandate.triggerBelowSqrtPriceX96, mandate.triggerAboveSqrtPriceX96, mandate.receiveMode, mandate.vault.toLowerCase()], [BELOW, ABOVE, 0, created.vault]);

  const id = await client.sendProtectBatch(batch, true, () => latch);
  assert.equal(sendCalls(chain), 1, 'one wallet confirmation');
  assert.equal(chain.log.includes('eth_sendTransaction'), false);
  assert.ok(latch.store.has(batch.key), 'latched while it runs');
  const receipt = await client.protectBatchReceipt(id, () => latch);
  assert.equal(receipt.state, 'finalized');
  assert.deepEqual(receipt.events.map((e) => e.eventName).filter((name) => ['VaultCreated', 'ExitModuleSet', 'MandateRegistered'].includes(name)), ['VaultCreated', 'ExitModuleSet', 'MandateRegistered']);
  assert.equal(latch.store.size, 0, 'let go once it ran');
  const vault = chain.vault(created.vault);
  assert.deepEqual([vault.paused, vault.exitModule, vault.owner], [true, AUTO_EXIT, OWNER.toLowerCase()], 'created paused, its module on: protection only');
  const status = await client.status(review.id);
  assert.deepEqual([status.status, status.canFire, status.failing], ['active', true, []]);
  assert.equal(wallet.held.size, 0, 'the order\'s nonce left the journal once final');
  await assert.rejects(client.sendProtectBatch(batch, true, () => latch), /wallet_review_required/, 'never offered twice');
  await assert.rejects(client.prepareProtectBatch(review, create(), GAS), /batch_not_needed/, 'the vault exists now');
});

test('without batching, the same calls one by one: the vault client\'s approval and creation, then the module and the registration', async () => {
  const { chain, client, vaults } = setup({ atomic: null, simulateV1: false });
  assert.equal(await client.atomicSupport(), 'unsupported');
  const created = await vaults.reviewCreate(create());
  const review = await client.reviewMandate(order(created.vault));
  await client.signMandate(review);
  await assert.rejects(client.prepareStep(review, review.steps.findIndex((s) => s.kind === 'enable-exit-module'), GAS), /vault_unknown/, 'the module waits for the vault');
  for (let index = 0; index < created.steps.length; index++) {
    const receipt = await vaults.receipt(await vaults.send(await vaults.prepareStep(created, index, GAS), true));
    assert.equal(receipt.state, 'finalized', created.steps[index].kind);
  }
  for (const kind of ['enable-exit-module', 'register-mandate']) {
    const index = review.steps.findIndex((s) => s.kind === kind);
    const receipt = await client.receipt(await client.send(await client.prepareStep(review, index, GAS), true));
    assert.equal(receipt.state, 'finalized', kind);
  }
  assert.deepEqual(chain.sends.map((tx) => tx.to.toLowerCase()), [chain.positionManager[4].toLowerCase(), FACTORY, created.vault, AUTO_EXIT]);
  assert.equal((await client.status(review.id)).status, 'active');
  assert.equal(chain.vault(created.vault).exitModule, AUTO_EXIT);
});

test('another vault of the wallet landing first refuses the signature and the batch; the review refuses a vault that is not the prediction or a position not held', async () => {
  const one = setup();
  const created = await one.vaults.reviewCreate(create());
  const review = await one.client.reviewMandate(order(created.vault));
  // Another tab of the same wallet sets up automation on its other position first: the prediction is that vault now.
  assert.equal(await one.chain.seedVault({ dex: 4, tokenId: SECOND }), created.vault);
  await assert.rejects(one.client.signMandate(review), /vault_nonce_moved/);
  assert.equal(one.wallet.held.size, 0, 'refused before anything was signed');

  const two = setup();
  const r2 = await two.client.reviewMandate(order((await two.vaults.reviewCreate(create())).vault));
  await two.client.signMandate(r2);
  await two.chain.seedVault({ dex: 4, tokenId: SECOND });
  await assert.rejects(two.client.prepareProtectBatch(r2, create(), GAS), /vault_nonce_moved/);
  await assert.rejects(two.client.reviewMandate(order(r2.vault)), /vault_nonce_moved/, 'the prediction is another position’s vault now');

  const three = setup();
  await assert.rejects(three.client.reviewMandate(order(three.chain.predict(4, OWNER, 5n))), /vault_nonce_moved/, 'only the next one');
  await assert.rejects(three.client.reviewMandate(order(three.chain.predict(4, OWNER, 0n), { tokenId: THEIRS })), /vault_root_not_owned/);
  await assert.rejects(three.client.reviewMandate(order(three.chain.predict(4, OWNER, 0n), { newVault: undefined })), /vault_unknown/, 'without newVault, an existing vault only');
  await assert.rejects(three.client.reviewMandate(order(three.chain.predict(4, OWNER, 0n), { newVault: { dex: 2 } })), /vault_invalid_dex/);
  assert.equal(three.chain.signed.length, 0);
});

test('only the protection-only vault rides in the batch; a refused batch lets its latch go and keeps the signature held', async () => {
  const { chain, wallet, client, vaults } = setup();
  const latch = memoryLatch();
  const created = await vaults.reviewCreate(create());
  const review = await client.reviewMandate(order(created.vault));
  await client.signMandate(review);
  for (const fields of [{ startPaused: false }, { policy: { ...PROTECTION.policy, mode: 2, maxPositions: 3 } }, { tokenId: THEIRS }]) {
    await assert.rejects(client.prepareProtectBatch(review, create(fields), GAS), /vault_invalid_request/, JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
  chain.declineBatch(4001);
  await assert.rejects(client.sendProtectBatch(await client.prepareProtectBatch(review, create(), GAS), true, () => latch), (error) => error.code === 4001);
  assert.equal(latch.store.size, 0, 'a definite refusal: nothing ran');
  assert.equal(wallet.held.size, 1, 'the signed order stays held (cancelNonce, or a new offer)');
  const again = await client.prepareProtectBatch(review, create(), GAS);
  assert.equal((await client.protectBatchReceipt(await client.sendProtectBatch(again, true, () => latch), () => latch)).state, 'finalized');
  assert.equal((await client.status(review.id)).status, 'active');
});

test('a vault created since the review is the wallet\'s own: the review then names it as an existing vault, with no prediction', async () => {
  const { chain, client, vaults } = setup();
  const created = await vaults.reviewCreate(create());
  for (let index = 0; index < created.steps.length; index++) await vaults.send(await vaults.prepareStep(created, index, GAS), true);
  const review = await client.reviewMandate(order(created.vault));
  assert.equal(review.predicted, null);
  assert.deepEqual(review.steps.map((s) => s.kind), ['enable-exit-module', 'sign-mandate', 'register-mandate']);
  assert.equal(chain.vault(created.vault).paused, true);
});

// Added 2026-10-06 (the review of point 5): the pool's own price decides; a stale "inside" read never arms a crossed edge.
test('the review reads the pool\'s own price and carries it; an armed edge that price has reached is refused, at or past it', async () => {
  const { chain, client, vaults } = setup();
  const created = await vaults.reviewCreate(create());
  const review = await client.reviewMandate(order(created.vault));
  assert.equal(review.sqrtPriceX96, INSIDE, 'the price at the review\'s block');
  assert.ok(chain.callsSince(0).some((c) => c.calls.includes('stateView.getSlot0')), 'read through the chain profile\'s StateView');
  for (const [price, label] of [[BELOW, 'exactly on the lower edge'], [BELOW - 1n, 'below it'], [ABOVE, 'exactly on the upper edge'], [ABOVE + 1n, 'above it']]) {
    chain.setPrice(4, ETH_USDG_KEY, price);
    await assert.rejects(client.reviewMandate(order(created.vault)), (error) => error.message === 'mandate_invalid: mandate_trigger_reached', label);
  }
  // The far edge alone stays valid while the price is past the near one.
  chain.setPrice(4, ETH_USDG_KEY, BELOW - 1n);
  const far = await client.reviewMandate(order(created.vault, { triggerBelowSqrtPriceX96: 0n }));
  assert.deepEqual([far.mandate.triggerBelowSqrtPriceX96, far.mandate.triggerAboveSqrtPriceX96], [0n, ABOVE]);
  assert.equal(auto.mandateInvalidText('mandate_trigger_reached'), "This Auto-exit isn't valid: the price has already reached the end of the range it would close at.");
  assert.equal(chain.signed.length, 0);
});

test('the page\'s stale "inside" price over a pool price below the range: the edges are chosen against the pool\'s own price, and the old pair is refused', async () => {
  const form = require('../../.test-build/app/src/v2in/autoexit/form.js');
  const { sqrtPriceAtTick } = require('../../.test-build/app/src/lib/read/screens/poolRange.js');
  const { chain, client, vaults } = setup();
  const range = { tickLower: -201060, tickUpper: -198060 };
  const [lower, upper] = [sqrtPriceAtTick(range.tickLower), sqrtPriceAtTick(range.tickUpper)];
  // What the page read minutes ago: inside the range, both edges.
  const stale = form.exitEdges(range, (lower + upper) / 2n, 60);
  assert.deepEqual([stale.edges.triggerBelowSqrtPriceX96, stale.edges.triggerAboveSqrtPriceX96], [lower, upper]);
  // The pool has fallen below the range since.
  chain.setPrice(4, ETH_USDG_KEY, lower - 10n ** 18n);
  const created = await vaults.reviewCreate(create());
  await assert.rejects(client.reviewMandate(order(created.vault, { triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: upper })), /mandate_trigger_reached/, 'the crossed lower edge is never armed');
  const now = await client.readPoolPrice(4, PLAIN);
  assert.equal(now.sqrtPriceX96, lower - 10n ** 18n, 'readPoolPrice: the position\'s pool, from its position manager, at one block');
  const fresh = form.exitEdges(range, now.sqrtPriceX96, 60);
  assert.deepEqual([fresh.edges.side, fresh.edges.triggerBelowSqrtPriceX96, fresh.edges.triggerAboveSqrtPriceX96], ['below', 0n, upper], 'the far edge alone');
  const review = await client.reviewMandate(order(created.vault, { triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: upper }));
  assert.equal(review.sqrtPriceX96, now.sqrtPriceX96);
  await assert.rejects(client.readPoolPrice(4, 999n), /vault_position_not_found/);
});

test('the price crossing an armed edge after the review refuses the signature, the batch and the registration step', async () => {
  const one = setup();
  const r1 = await one.client.reviewMandate(order((await one.vaults.reviewCreate(create())).vault));
  one.chain.setPrice(4, ETH_USDG_KEY, ABOVE);
  await assert.rejects(one.client.signMandate(r1), /mandate_trigger_reached/);
  assert.equal(one.chain.signed.length, 0, 'nothing signed for it');
  assert.equal(one.wallet.held.size, 0);

  const two = setup();
  const latch = memoryLatch();
  const r2 = await two.client.reviewMandate(order((await two.vaults.reviewCreate(create())).vault));
  await two.client.signMandate(r2);
  two.chain.setPrice(4, ETH_USDG_KEY, BELOW);
  await assert.rejects(two.client.prepareProtectBatch(r2, create(), GAS), /mandate_trigger_reached/, 'never prepared');
  two.chain.setPrice(4, ETH_USDG_KEY, INSIDE);
  const batch = await two.client.prepareProtectBatch(r2, create(), GAS);
  two.chain.setPrice(4, ETH_USDG_KEY, BELOW);
  await assert.rejects(two.client.sendProtectBatch(batch, true, () => latch), /mandate_trigger_reached/, 'checked again right before the wallet');
  assert.equal(sendCalls(two.chain), 0, 'never offered');

  const three = setup({ atomic: null, simulateV1: false });
  const created = await three.vaults.reviewCreate(create());
  const r3 = await three.client.reviewMandate(order(created.vault));
  await three.client.signMandate(r3);
  for (let index = 0; index < created.steps.length; index++) await three.vaults.send(await three.vaults.prepareStep(created, index, GAS), true);
  await three.client.send(await three.client.prepareStep(r3, r3.steps.findIndex((s) => s.kind === 'enable-exit-module'), GAS), true);
  three.chain.setPrice(4, ETH_USDG_KEY, ABOVE + 1n);
  await assert.rejects(three.client.prepareStep(r3, r3.steps.findIndex((s) => s.kind === 'register-mandate'), GAS), /mandate_trigger_reached/);
  three.chain.setPrice(4, ETH_USDG_KEY, INSIDE);
  const register = await three.client.prepareStep(r3, r3.steps.findIndex((s) => s.kind === 'register-mandate'), GAS);
  three.chain.setPrice(4, ETH_USDG_KEY, ABOVE + 1n);
  await assert.rejects(three.client.send(register, true), /mandate_trigger_reached/, 'the registration\'s own recheck, right before the send');
  assert.equal((await three.client.status(r3.id)).status, 'unknown', 'never registered');
});

test('a v3 position\'s price is its pool\'s own slot0, at the profile factory\'s address', async () => {
  forgetV2DeploymentChecks();
  const WETH = '0x7943e237c7f95da44e0301572d358911207852fa';
  const [a, b] = BigInt(USDG) < BigInt(WETH) ? [USDG, WETH] : [WETH, USDG];
  const pool = { currency0: a, currency1: b, fee: 3000, tickSpacing: 60 };
  const chain = createVaultChain({ chainId: 4663, timestamp: NOW, positions: [{ dex: 3, tokenId: 77n, pool }] });
  const client = auto.createAutoExitClient(walletOf(chain), chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => 9n);
  chain.setPrice(3, pool, 123_456_789_000_000_000_000_000n);
  assert.equal((await client.readPoolPrice(3, 77n)).sqrtPriceX96, 123_456_789_000_000_000_000_000n);
});
