/**
 * The V2 vault client's owner actions and panel read (src/finance/v2/vault.ts; spec F7 §5.3–§5.6, §4.5) against the
 * fake V2 chain: each action's selector and target, the vault only ever the factory's and the wallet's, setExitModule
 * only to address(0) or the manifest's autoExit, rearm(false) never built, withdrawals bounded by what the vault holds,
 * a successor (never the root) withdrawn, unsubscribe and revoke after exitAll on v4, every panel figure read at one
 * block, and the root's custody derived live.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ABI, OTHER, OWNER, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { FAKE, USDG, WETH } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createVaultClient, liveCustody, VAULT_TEXT } = require('../../.test-build/app/src/finance/v2/vault.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROOT = 3_409_682n;
const ROOT_V3 = 77n;
const CHILD = 3_500_001n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const WETH_USDG_V3 = { currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60 };
const DOMINO = Object.freeze({ mode: 2, triggerDistanceBps: 500, maxOverlapBps: 1000, minimumIntervalSeconds: 3600, maxPositions: 3 });
// Changed on purpose 2026-10-04 (the deployed vault's #317 limits): a reference price at most 300 s old (was 600).
const LIMITS = Object.freeze({ maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 300, upsideBps: 1000 });
const PM4 = chains.v2Chain(4663).uniswap.v4.positionManager;
const PM3 = chains.v2Chain(4663).uniswap.v3.positionManager;

/** A Domino-compound v4 vault with a successor, lots and idle reserves; and a v3 vault. */
async function setup({ account } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ positions: [
    { dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 },
    { dex: 3, tokenId: ROOT_V3, pool: WETH_USDG_V3 },
  ], timestamp: NOW });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, policy: DOMINO, limits: LIMITS });
  const vaultV3 = await chain.seedVault({ dex: 3, tokenId: ROOT_V3, limits: LIMITS });
  chain.addSuccessor(vault, { tokenId: CHILD, parent: ROOT, lots: [{ token: USDG, uncharged: 40n, charged: 2n }] });
  chain.setLot(vault, ROOT, USDG, { uncharged: 100n, charged: 5n });
  chain.setLot(vault, ROOT, ZERO, { uncharged: 7n, charged: 0n });
  chain.setIdle(vault, USDG, 1_000n);
  const wallet = walletOf(chain, account ? { account } : {});
  const client = createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  return { chain, wallet, client, vault, vaultV3 };
}
async function act(client, vault, action) {
  const review = await client.reviewAction(vault, action);
  const hashes = [];
  for (let i = 0; i < review.steps.length; i++) {
    const prepared = await client.prepareStep(review, i, GAS);
    hashes.push(await client.send(prepared, true));
  }
  const receipts = [];
  for (const hash of hashes) receipts.push(await client.receipt(hash));
  return { review, receipts };
}
const decoded = (data) => decodeFunctionData({ abi: ABI.vault, data });

test('each owner action is one reviewed step with the spec\'s selector, to the vault the factory made', async () => {
  const { chain, client, vault } = await setup();
  const expect = [
    [{ kind: 'pause' }, '0x8456cb59', []],
    [{ kind: 'set-policy', policy: { ...DOMINO, maxPositions: 4 } }, '0x740b167b', null],
    [{ kind: 'set-limits', limits: { ...LIMITS, maxSlippageBps: 50 } }, '0x2853449f', null],
    // Changed on purpose 2026-10-04 (rugged97's #323): withdrawReserves(token, amount, recipient), the owner's own wallet.
    [{ kind: 'withdraw-reserves', token: USDG, amount: 500n }, '0xf28bf186', [USDG, 500n, OWNER]],
    [{ kind: 'withdraw-child', tokenId: CHILD }, '0x76175193', [CHILD]],
    [{ kind: 'recover-token', token: '0x00000000000000000000000000000000000075a1', amount: 3n }, '0xb29a8140', null],
    [{ kind: 'set-exit-module', module: FAKE.autoExit }, '0x325be671', [FAKE.autoExit]],
    [{ kind: 'exit-all' }, '0x5b6c508c', []],
  ];
  for (const [action, selector, args] of expect) {
    const review = await client.reviewAction(vault, action);
    assert.equal(review.kind, action.kind);
    assert.equal(review.vault, vault);
    assert.equal(review.dex, 4);
    assert.equal(review.steps.length, 1, action.kind);
    assert.equal(review.steps[0].to, vault);
    assert.equal(review.steps[0].data.slice(0, 10), selector, action.kind);
    if (args) assert.deepEqual((decoded(review.steps[0].data).args ?? []).map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)));
  }
  // Each one is sent and does what it says, in this order.
  await act(client, vault, { kind: 'pause' });
  assert.equal(chain.vault(vault).paused, true);
  const resume = await act(client, vault, { kind: 'resume' });
  assert.equal(resume.review.steps[0].data, '0x046f7da2');
  assert.equal(chain.vault(vault).paused, false);
  await act(client, vault, { kind: 'set-policy', policy: { ...DOMINO, maxPositions: 4 } });
  assert.equal(chain.vault(vault).policy.maxPositions, 4);
  const withdraw = await act(client, vault, { kind: 'withdraw-reserves', token: USDG, amount: 500n });
  assert.deepEqual(withdraw.receipts[0].events.map((e) => e.eventName), ['ReservesWithdrawn']);
  chain.setUnaccounted(vault, '0x00000000000000000000000000000000000075a1', 3n);
  await act(client, vault, { kind: 'recover-token', token: '0x00000000000000000000000000000000000075a1', amount: 3n });
  const child = await act(client, vault, { kind: 'withdraw-child', tokenId: CHILD });
  assert.deepEqual(child.receipts[0].events.map((e) => e.eventName), ['ChildWithdrawn']);
  assert.equal(chain.nft(4, CHILD).owner, OWNER, 'the successor is now an ordinary position in the wallet');
  const on = await act(client, vault, { kind: 'set-exit-module', module: FAKE.autoExit });
  assert.equal(on.review.steps[0].summary[0], 'Turn on auto-exit for this vault.');
  assert.equal(chain.vault(vault).exitModule, FAKE.autoExit);
  const off = await act(client, vault, { kind: 'set-exit-module', module: ZERO });
  assert.deepEqual(off.review.notes, ['vault_exit_module_off_pauses']);
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation"): the note's words, as the dialog shows them.
  assert.ok(off.review.steps[0].summary.includes("Turning auto-exit off for your automation pauses your orders; it doesn't cancel them."), 'turning it off says it pauses, not cancels');
  assert.equal(chain.vault(vault).exitModule, ZERO);
});

test('setExitModule names only address(0) or the manifest\'s autoExit: anything else is refused before anything is sent', async () => {
  const { chain, client, vault } = await setup();
  for (const module of [OTHER, FAKE.registry, FAKE.zapV4, FAKE.vaultFactoryV4, vault, '0x1234', undefined]) {
    await assert.rejects(client.reviewAction(vault, { kind: 'set-exit-module', module }), /^Error: vault_exit_module_refused$/, String(module));
  }
  await assert.rejects(client.reviewAction(vault, { kind: 'set-exit-module', module: ZERO }), /vault_step_not_needed/, 'already off');
  assert.equal(chain.sends.length, 0);
});

test('rearm: rearm(true) 0xf6fa162e only with the consent, after the individual approval to the vault when it was lost; rearm(false) is never built', async () => {
  const { chain, client, vault } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'rearm', consentToUncollectedFees: true }), /vault_step_not_needed/, 'armed: nothing to do');
  chain.approveOther(4, ROOT, OTHER);
  assert.equal(liveCustody(await client.readVault(vault)).reason, 4);
  // An execution saw it and recorded the disarm (reason 4): the approval alone no longer brings the root back.
  chain.disarm(vault, 4);
  for (const consent of [false, undefined, 'true', 1]) {
    await assert.rejects(client.reviewAction(vault, { kind: 'rearm', consentToUncollectedFees: consent }), /^Error: vault_consent_required$/);
  }
  const { review } = await act(client, vault, { kind: 'rearm', consentToUncollectedFees: true });
  assert.deepEqual(review.steps.map((s) => s.kind), ['approve-root', 'rearm']);
  assert.equal(review.steps[0].to, PM4);
  assert.deepEqual(decodeFunctionData({ abi: ABI.v4, data: review.steps[0].data }).args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [vault, ROOT]);
  assert.equal(review.steps[1].data.slice(0, 10), '0xf6fa162e');
  assert.equal(decoded(review.steps[1].data).args[0], true);
  assert.ok(review.steps[1].summary.some((line) => line.includes('the 4% fee applies')), 'the consent is said with the vault\'s fee');
  assert.deepEqual(review.notes, ['vault_consent_uncollected_fees']);
  assert.equal(chain.sends.some((tx) => tx.data === `0xf6fa162e${'0'.repeat(64)}`), false, 'rearm(false) never sent');
  assert.equal((await client.readVault(vault)).rootArmed, true);
});

test('an approval lost and given back before any execution recorded it: rootArmed is live, so the root is armed again and the rearm step is not needed', async () => {
  const { chain, client, vault } = await setup();
  chain.approveOther(4, ROOT, OTHER);
  const review = await client.reviewAction(vault, { kind: 'rearm', consentToUncollectedFees: true });
  assert.deepEqual(review.steps.map((s) => s.kind), ['approve-root', 'rearm']);
  await client.send(await client.prepareStep(review, 0, GAS), true);
  assert.equal((await client.readVault(vault)).rootArmed, true);
  await assert.rejects(client.prepareStep(review, 1, GAS), /vault_step_not_needed/);
  assert.equal(chain.sends.length, 1);
});

test('rearm refuses a root that left the wallet and a v4 root another app subscribed', async () => {
  const one = await setup();
  one.chain.transfer(4, ROOT, OTHER);
  await assert.rejects(one.client.reviewAction(one.vault, { kind: 'rearm', consentToUncollectedFees: true }), /vault_root_not_owned/);
  const two = await setup();
  two.chain.approveOther(4, ROOT, OTHER);
  two.chain.subscribeOther(ROOT, '0x00000000000000000000000000000000005ab5c0');
  await assert.rejects(two.client.reviewAction(two.vault, { kind: 'rearm', consentToUncollectedFees: true }), /vault_foreign_subscriber/);
});

test('withdrawReserves: zero refused, more than the reserves refused, a token outside the pool refused; exactly the reserves allowed', async () => {
  const { chain, client, vault } = await setup();
  const reserves = 1_000n + 100n + 5n + 40n + 2n;
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: 0n }), /^Error: vault_amount_zero$/);
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: reserves + 1n }), /^Error: vault_amount_exceeds_reserves$/);
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-reserves', token: WETH, amount: 1n }), /vault_token_not_in_pool/);
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: 5 }), /vault_amount_zero/, 'a JS number is not an amount');
  assert.equal(chain.sends.length, 0);
  await act(client, vault, { kind: 'withdraw-reserves', token: USDG, amount: reserves });
  assert.equal(chain.paid.at(-1).amounts[0], reserves);
  assert.equal(VAULT_TEXT.vault_amount_zero, 'Enter an amount greater than zero.');
});

test('withdrawChild: never the root, never an inactive successor', async () => {
  const { chain, client, vault } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-child', tokenId: ROOT }), /^Error: vault_child_is_root$/);
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-child', tokenId: 999n }), /^Error: vault_child_inactive$/);
  await act(client, vault, { kind: 'withdraw-child', tokenId: CHILD });
  await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-child', tokenId: CHILD }), /^Error: vault_child_inactive$/, 'already withdrawn');
  assert.equal(chain.sends.length, 1);
});

test('recoverPosition 0xf578affa only for an NFT the vault holds', async () => {
  const { chain, client, vault } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'recover-position', tokenId: 4_000_000n }), /vault_position_not_held/);
  chain.giveToVault(vault, 4, 4_000_000n);
  const { review } = await act(client, vault, { kind: 'recover-position', tokenId: 4_000_000n });
  assert.equal(review.steps[0].data.slice(0, 10), '0xf578affa');
  assert.equal(chain.nft(4, 4_000_000n).owner, OWNER);
});

test('after exitAll on v4: "Remove Domino from this position" (unsubscribe 0xad0b27fb) and "Revoke approval" (approve(address(0), root)), on the PositionManager', async () => {
  const { chain, client, vault } = await setup();
  const exit = await act(client, vault, { kind: 'exit-all' });
  assert.ok(exit.receipts[0].events.some((e) => e.eventName === 'RootDisarmed' && e.args.reason === 7));
  const snapshot = await client.readVault(vault);
  assert.equal(snapshot.rootArmed, false);
  assert.equal(snapshot.paused, true);
  assert.deepEqual(liveCustody(snapshot), { armed: false, reason: 'unknown', lost: [] }, 'custody intact: only the RootDisarmed log says 7');

  const unsubscribe = await act(client, vault, { kind: 'unsubscribe' });
  assert.equal(unsubscribe.review.steps[0].to, PM4);
  assert.equal(unsubscribe.review.steps[0].data.slice(0, 10), '0xad0b27fb');
  assert.equal(decodeFunctionData({ abi: ABI.v4, data: unsubscribe.review.steps[0].data }).args[0], ROOT);
  assert.equal(chain.nft(4, ROOT).subscriber, ZERO);
  await assert.rejects(client.reviewAction(vault, { kind: 'unsubscribe' }), /vault_not_subscribed/);

  const revoke = await act(client, vault, { kind: 'revoke-approval' });
  assert.equal(revoke.review.steps[0].to, PM4);
  assert.equal(revoke.review.steps[0].data.slice(0, 10), '0x095ea7b3');
  assert.deepEqual(decodeFunctionData({ abi: ABI.v4, data: revoke.review.steps[0].data }).args, [ZERO, ROOT]);
  assert.equal(chain.nft(4, ROOT).approved, ZERO);
  await assert.rejects(client.reviewAction(vault, { kind: 'revoke-approval' }), /vault_nothing_to_revoke/);
});

test('unsubscribe is v4 only; the v3 revoke goes to the NonfungiblePositionManager', async () => {
  const { client, vaultV3 } = await setup();
  await assert.rejects(client.reviewAction(vaultV3, { kind: 'unsubscribe' }), /vault_unsubscribe_v4_only/);
  const review = await client.reviewAction(vaultV3, { kind: 'revoke-approval' });
  assert.equal(review.steps[0].to, PM3);
  assert.deepEqual(review.notes, ['vault_stops_automation'], 'armed: revoking stops automation, and says so');
});

test('a wallet that does not own the vault is refused every action; an address the factories did not make is vault_unknown', async () => {
  const { chain, client, vault } = await setup({ account: OTHER });
  for (const action of [{ kind: 'pause' }, { kind: 'exit-all' }, { kind: 'withdraw-reserves', token: USDG, amount: 1n }, { kind: 'set-exit-module', module: ZERO }, { kind: 'rearm', consentToUncollectedFees: true }]) {
    await assert.rejects(client.reviewAction(vault, action), /^Error: vault_not_owner$/, action.kind);
  }
  const mine = await setup();
  for (const address of [OTHER, FAKE.autoExit, chain.predict(4, OWNER, 9n), 'not-an-address', ZERO]) {
    await assert.rejects(mine.client.reviewAction(address, { kind: 'pause' }), /vault_unknown|vault_invalid_address/, String(address));
  }
  assert.equal(await mine.client.isFactoryVault(mine.vault), true);
  assert.equal(await mine.client.isFactoryVault(OTHER), false);
  assert.equal(chain.sends.length + mine.chain.sends.length, 0);
});

test('a vault whose owner changed after the review: the step is refused at prepare and at send', async () => {
  const { chain, client, vault } = await setup();
  const review = await client.reviewAction(vault, { kind: 'pause' });
  const prepared = await client.prepareStep(review, 0, GAS);
  chain.setVaultOwner(vault, OTHER);
  await assert.rejects(client.send(prepared, true), /vault_not_owner/);
  await assert.rejects(client.prepareStep(review, 0, GAS), /vault_not_owner/);
  assert.equal(chain.sends.length, 0);
});

test('the panel: every figure at one block, members with their lots, reserves and idle reserves of both pool tokens, never owedFees', async () => {
  const { chain, client, vault } = await setup();
  const from = chain.calls.length;
  const snapshot = await client.readVault(vault);
  const reads = chain.callsSince(from).filter((c) => c.method === 'eth_call');
  assert.ok(reads.length > 20);
  assert.equal(new Set(reads.map((c) => c.block)).size, 1, 'one block tag for every read');
  assert.equal(reads[0].block, `0x${snapshot.blockNumber.toString(16)}`);
  assert.equal(reads.some((c) => c.calls.some((name) => /owedFees/.test(name))), false);
  assert.equal(snapshot.chainId, 4663);
  assert.equal(typeof snapshot.blockTimestamp, 'bigint');
  assert.equal(snapshot.vault, vault);
  assert.equal(snapshot.owner, OWNER);
  assert.equal(snapshot.ownedByWallet, true);
  assert.equal(snapshot.dex, 4);
  assert.deepEqual(snapshot.root, { dex: 4, positionManager: PM4, tokenId: ROOT });
  assert.deepEqual(snapshot.pool, { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO });
  assert.deepEqual(snapshot.positions, [ROOT, CHILD]);
  assert.deepEqual(snapshot.policy, DOMINO);
  assert.deepEqual(snapshot.limits, LIMITS);
  assert.equal(snapshot.quoteCurrency, USDG, 'the best-ranked charge currency of the pool');
  assert.equal(snapshot.rootArmed, true);
  assert.equal(snapshot.autoExitEnabled, false);
  assert.equal(snapshot.halted, false);
  assert.deepEqual(snapshot.members.map((m) => [m.tokenId, m.role, m.active, m.parent, m.successor]), [[ROOT, 'root', true, 0n, CHILD], [CHILD, 'successor', true, ROOT, 0n]]);
  assert.deepEqual(snapshot.members[0].lots, [{ token: ZERO, uncharged: 7n, charged: 0n }, { token: USDG, uncharged: 100n, charged: 5n }]);
  assert.deepEqual(snapshot.reserves, [{ token: ZERO, total: 7n, idle: 0n }, { token: USDG, total: 1_147n, idle: 1_000n }]);
  assert.deepEqual(snapshot.custody, { holder: OWNER, approved: vault, subscriber: vault });
  assert.deepEqual(liveCustody(snapshot), { armed: true, reason: null, lost: [] });
});

test('a long sequence is read in bounded pieces, still at one block', async () => {
  const { chain, client, vault } = await setup();
  let parent = CHILD;
  for (let i = 1; i <= 20; i++) {
    const tokenId = CHILD + BigInt(i);
    chain.addSuccessor(vault, { tokenId, parent });
    parent = tokenId;
  }
  const from = chain.calls.length;
  const snapshot = await client.readVault(vault);
  assert.equal(snapshot.members.length, 22);
  assert.equal(new Set(chain.callsSince(from).filter((c) => c.method === 'eth_call').map((c) => c.block)).size, 1);
});

test('custody derived live (§5.4): another app approved, the NFT moved, a v3 checkpoint the logs would explain', async () => {
  const one = await setup();
  one.chain.approveOther(4, ROOT, OTHER);
  assert.deepEqual(liveCustody(await one.client.readVault(one.vault)), { armed: false, reason: 4, lost: ['approval'] });
  const two = await setup();
  two.chain.transfer(4, ROOT, OTHER);
  assert.deepEqual(liveCustody(await two.client.readVault(two.vault)), { armed: false, reason: 4, lost: ['owner', 'approval', 'subscription'] });
  const three = await setup();
  three.chain.disarm(three.vaultV3, 5);
  const v3 = await three.client.readVault(three.vaultV3);
  assert.equal(v3.custody.subscriber, null, 'v3 has no subscriber');
  assert.deepEqual(liveCustody(v3), { armed: false, reason: 'unknown', lost: [] }, 'reason 5 needs the RootCheckpointed log: PHASE A says unknown');
});

test('the halt banner flag (registry.automationHalted)', async () => {
  const { chain, client, vault } = await setup();
  assert.equal((await client.readHalted()).halted, false);
  chain.halt(true);
  const halted = await client.readHalted();
  assert.equal(halted.halted, true);
  assert.equal(halted.chainId, 4663);
  assert.equal((await client.readVault(vault)).halted, true);
  assert.match(VAULT_TEXT.vault_halted, /\{chain\}/);
  // The owner's actions go on during a halt.
  await act(client, vault, { kind: 'pause' });
  assert.equal(chain.vault(vault).paused, true);
});

test('pausing says the auto-exit orders stay active; resume and pause are not offered when they would do nothing', async () => {
  const { client, vault } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'resume' }), /vault_step_not_needed/);
  const review = await client.reviewAction(vault, { kind: 'pause' });
  assert.deepEqual(review.notes, ['vault_pause_keeps_auto_exit']);
  await act(client, vault, { kind: 'pause' });
  await assert.rejects(client.reviewAction(vault, { kind: 'pause' }), /vault_step_not_needed/);
});

test('settings changes keep the §5.2 limits and the vault\'s members', async () => {
  const { chain, client, vault, vaultV3 } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'set-policy', policy: { ...DOMINO, maxPositions: 1 } }), /vault_invalid_settings: .*vault_policy_max_positions/, 'two members: at least 2');
  await assert.rejects(client.reviewAction(vault, { kind: 'set-policy', policy: { ...DOMINO, mode: 1, maxPositions: 2 } }), /vault_policy_simple_one_position/);
  await assert.rejects(client.reviewAction(vaultV3, { kind: 'set-limits', limits: { ...LIMITS, maxObservationAgeSeconds: 30 } }), /vault_limits_observation_age_v3/);
  await assert.rejects(client.reviewAction(vault, { kind: 'set-limits', limits: { ...LIMITS, maxPriceImpactBps: 10_000 } }), /vault_limits_max_price_impact/);
  await assert.rejects(client.reviewAction(vault, { kind: 'fly' }), /vault_action_unknown/);
  assert.equal(chain.sends.length, 0);
});

// ---------------------------------------------------------------------------
// Added 2026-10-04 (rugged97's delta of 4 Oct, V2 deployed): a withdrawal's own recipient (§2 item 1), and exitAll's pause
// of the auto-exit orders (§2 item 3)
// ---------------------------------------------------------------------------

test('delta §2 item 1: a token that refuses the wallet reverts TokenCallFailed in the simulation, before the wallet; the same withdrawal goes to another address the owner names', async () => {
  const { chain, client, vault } = await setup();
  chain.refuseTransfers(USDG, OWNER);
  const toWallet = await client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: 500n });
  await assert.rejects(client.prepareStep(toWallet, 0, GAS), (error) => error.name === 'V2Revert' && String(error.data).startsWith('0xfecb69b4'), 'TokenCallFailed(USDG)');
  assert.equal(chain.sends.length, 0, 'nothing reached the wallet');
  const other = OTHER.toLowerCase();
  const { review } = await act(client, vault, { kind: 'withdraw-reserves', token: USDG, amount: 500n, recipient: OTHER });
  const call = decodeFunctionData({ abi: ABI.vault, data: review.steps[0].data });
  assert.deepEqual(call.args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [USDG, 500n, other]);
  assert.ok(review.steps[0].summary[0].endsWith(`to ${other}.`), review.steps[0].summary[0]);
  assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[other, USDG, 500n]]);
  // Left out, the recipient is the owner's own wallet, as before.
  const own = await client.reviewAction(vault, { kind: 'withdraw-reserves', token: ZERO, amount: 7n });
  assert.equal(decodeFunctionData({ abi: ABI.vault, data: own.steps[0].data }).args[2].toLowerCase(), OWNER.toLowerCase());
});

test('delta §2 item 1: a recipient that is no wallet is refused before anything is sent: address(0), the vault, a pool token, a Domino contract, a malformed one', async () => {
  const { chain, client, vault } = await setup();
  const domino = Object.values(vaultContracts(4663).addresses);
  for (const recipient of [ZERO, vault, USDG, domino[0], domino.at(-1), '0x1234']) {
    await assert.rejects(client.reviewAction(vault, { kind: 'withdraw-reserves', token: USDG, amount: 1n, recipient }), /vault_recipient_invalid/, String(recipient));
  }
  assert.equal(VAULT_TEXT.vault_recipient_invalid, 'Choose a wallet to receive the funds.');
  assert.equal(chain.sends.length, 0);
});

test('delta §2 item 3: Leave automation (exitAll) also turns auto-exit off when it is on, said in the review; its receipt carries ExitModuleSet(0); with auto-exit off, nothing more is said', async () => {
  const { chain, client, vault } = await setup();
  chain.setExitModule(vault, vaultContracts(4663).addresses.autoExit);
  const { review, receipts } = await act(client, vault, { kind: 'exit-all' });
  assert.ok(review.notes.includes('vault_exit_all_pauses_orders'));
  assert.ok(review.steps[0].summary.includes(VAULT_TEXT.vault_exit_all_pauses_orders));
  assert.equal(VAULT_TEXT.vault_exit_all_pauses_orders, 'This also pauses your auto-exit orders. You can turn them back on later.');
  const set = receipts[0].events.find((e) => e.eventName === 'ExitModuleSet');
  assert.ok(set, 'ExitModuleSet in the receipt');
  assert.equal(set.args.module.toLowerCase(), ZERO);
  assert.equal(chain.vault(vault).exitModule, ZERO, 'the module is off: the orders pause, not revoked');

  const quiet = await setup();
  const plain = await quiet.client.reviewAction(quiet.vault, { kind: 'exit-all' });
  assert.equal(plain.notes.includes('vault_exit_all_pauses_orders'), false, 'auto-exit off: nothing to pause');
  assert.equal(plain.steps[0].summary.length, 1);
});
