/**
 * The V2 vault client's creation (src/finance/v2/vault.ts; spec F7 §5.1, §5.2) against the fake V2 chain
 * (tests/support/v2-vault-chain.mjs): the individual approval of the root to the PREDICTED vault, then
 * createVault(init, n) with the init the review showed; the approval skipped when already given; never
 * setApprovalForAll; the v3 tokensOwed warning; hooked pools, foreign subscribers, a missing consent and every §5.2 edge
 * refused before anything is sent; the race with another tab (`vault_nonce_moved`, then a new prediction and a NEW
 * approval); the wrong chain, changed or missing code, and a fixture contracts set in a deployable build.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import { ABI, ERRORS, OTHER, OWNER, SPEC_SELECTORS, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { USDG, WETH } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const VAULT_JS = require.resolve('../../.test-build/app/src/finance/v2/vault.js');
const AUTO_EXIT_JS = require.resolve('../../.test-build/app/src/finance/v2/autoExit.js');
const DEPLOYMENT_JS = require.resolve('../../.test-build/app/src/finance/v2/deployment.js');
const { createVaultClient, settingsProblems, VAULT_TEXT } = require(VAULT_JS);
const { forgetV2DeploymentChecks } = require(DEPLOYMENT_JS);
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROOT_V4 = 3_409_682n;
const ROOT_V3 = 77n;
const HOOKED = 501n;
const FOREIGN = 502n;
const NOT_MINE = 503n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const WETH_USDG_V3 = { currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60 };
const POSITIONS = [
  { dex: 4, tokenId: ROOT_V4, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 },
  { dex: 3, tokenId: ROOT_V3, pool: WETH_USDG_V3, owed: [5_000n, 7_000n] },
  { dex: 3, tokenId: 78n, pool: WETH_USDG_V3 },
  { dex: 4, tokenId: HOOKED, pool: { ...ETH_USDG, hooks: '0x00000000000000000000000000000000000c0de0' } },
  { dex: 4, tokenId: FOREIGN, pool: ETH_USDG, subscriber: '0x00000000000000000000000000000000005ab5c0' },
  { dex: 4, tokenId: NOT_MINE, pool: ETH_USDG, owner: OTHER },
];
const SIMPLE = Object.freeze({ mode: 1, triggerDistanceBps: 500, maxOverlapBps: 500, minimumIntervalSeconds: 3600, maxPositions: 1 });
const DOMINO = Object.freeze({ mode: 2, triggerDistanceBps: 500, maxOverlapBps: 1000, minimumIntervalSeconds: 3600, maxPositions: 3 });
const LIMITS = Object.freeze({ maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 300, upsideBps: 1000 });
const request = (fields = {}) => ({ dex: 4, tokenId: ROOT_V4, policy: SIMPLE, limits: LIMITS, startPaused: false, consentToUncollectedFees: true, ...fields });

function setup({ chainId = 4663, account, ...options } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ chainId, positions: POSITIONS, timestamp: NOW, ...options });
  const wallet = walletOf(chain, account ? { account } : {});
  const client = createVaultClient(wallet, chains.v2Chain(chainId), vaultContracts(chainId), () => NOW);
  return { chain, wallet, client };
}
async function run(client, review, index) {
  const prepared = await client.prepareStep(review, index, GAS);
  const hash = await client.send(prepared, true);
  return { prepared, hash, receipt: await client.receipt(hash) };
}
const selectorOf = (data) => data.slice(0, 10);
const sentMethods = (chain) => chain.log.filter((method) => method === 'eth_sendTransaction' || method === 'eth_estimateGas');

test('a repeated Base v3 review resumes the exact pending approval by hash instead of bypassing its send guard', async () => {
  const { chain, client } = setup({ chainId: 8453, finality: 'lagging' });
  const first = await client.reviewCreate(request({ dex: 3, tokenId: ROOT_V3 }));
  const prepared = await client.prepareStep(first, 0, GAS), hash = await client.send(prepared, true);
  assert.equal(client.sentStep(first, 0), hash);
  assert.equal(client.sentStep(first, 1), null, 'the setup transaction has never been sent');
  chain.approveOther(3, ROOT_V3, ZERO); // A lagging approval read causes the same first step to appear in a new review.
  const refreshed = await client.reviewCreate(request({ dex: 3, tokenId: ROOT_V3 }));
  assert.equal(client.sentStep(refreshed, 0), hash);
  await assert.rejects(client.prepareStep(refreshed, 0, GAS), /review_already_sent/);
  assert.equal(chain.sends.length, 1, 'the guard remains closed');
  const other = await client.reviewCreate(request({ dex: 3, tokenId: 78n }));
  assert.equal(client.sentStep(other, 0), null, 'another NFT cannot borrow the approval');
  chain.approveOther(3, ROOT_V3, first.vault);
  assert.equal((await client.receipt(hash)).state, 'included');
  await run(client, refreshed, 1);
  assert.equal(chain.sends.length, 2, 'one approval and one setup, without waiting for hard finality');
});

test('after a reverted approval, only its latest retry is resumable and an old terminal receipt cannot release its send guard', async () => {
  const { chain, client } = setup({ chainId: 8453, finality: 'lagging' });
  const review = await client.reviewCreate(request({ dex: 3, tokenId: ROOT_V3 }));
  chain.revert();
  const old = await run(client, review, 0);
  assert.equal(old.receipt.state, 'reverted');
  assert.equal(client.sentStep(review, 0), null);
  const prepared = await client.prepareStep(review, 0, GAS), next = await client.send(prepared, true);
  assert.notEqual(next, old.hash);
  assert.equal(client.sentStep(review, 0), next);
  assert.equal((await client.receipt(old.hash)).state, 'reverted');
  assert.equal(client.sentStep(review, 0), next, 'old terminal proof must not clear the active attempt');
  chain.approveOther(3, ROOT_V3, ZERO);
  const refreshed = await client.reviewCreate(request({ dex: 3, tokenId: ROOT_V3 }));
  assert.equal(client.sentStep(refreshed, 0), next);
  await assert.rejects(client.prepareStep(refreshed, 0, GAS), /review_already_sent/);
  assert.equal(chain.sends.length, 2);
});

test('the fake chain refuses with the spec\'s own selectors (§4.9, §5.8)', () => {
  for (const [name, signature] of Object.entries(ERRORS)) assert.equal(toFunctionSelector(signature), SPEC_SELECTORS[name], name);
});

test('create v4: the individual approval of the root to the PREDICTED vault, then createVault(init, n) 0xee568446 with the init the review showed', async () => {
  const { chain, client } = setup();
  const review = await client.reviewCreate(request());
  assert.equal(review.kind, 'create');
  assert.equal(review.chainId, 4663);
  assert.equal(review.nonce, 0n);
  assert.equal(review.vault, chain.predict(4, OWNER, 0n), 'the factory\'s prediction for this owner and nonce');
  assert.equal(review.factory, chain.factory[4]);
  assert.deepEqual(review.steps.map((s) => s.kind), ['approve-root', 'create-vault']);
  assert.equal(review.approvalNeeded, true);
  assert.deepEqual(review.init, {
    root: { dex: 4, positionManager: chains.v2Chain(4663).uniswap.v4.positionManager, tokenId: ROOT_V4 },
    policy: SIMPLE, limits: LIMITS, startPaused: false, consentToUncollectedFees: true,
  });
  assert.deepEqual(review.consent, { key: 'vault_consent_uncollected_fees', fee: '2%' });
  assert.match(VAULT_TEXT[review.consent.key].replace('{fee}', review.consent.fee), /the 2% fee applies/);
  assert.deepEqual(review.warnings, []);
  assert.equal(review.pool.hooks, ZERO);
  assert.equal(review.snapshot.chainId, 4663);
  assert.equal(typeof review.snapshot.blockNumber, 'bigint');
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.steps) && Object.isFrozen(review.init));

  // Step 1: approve(vault, tokenId) on the chain's v4 PositionManager, individual.
  const approve = review.steps[0];
  assert.equal(approve.to, chains.v2Chain(4663).uniswap.v4.positionManager);
  assert.equal(selectorOf(approve.data), '0x095ea7b3');
  assert.equal(decodeFunctionData({ abi: ABI.v4, data: approve.data }).args[0].toLowerCase(), review.vault);
  assert.equal(decodeFunctionData({ abi: ABI.v4, data: approve.data }).args[1], ROOT_V4);
  // Step 2: createVault(init, n) on the v4 factory, with the init above.
  const create = review.steps[1];
  assert.equal(create.to, chain.factory[4]);
  assert.equal(selectorOf(create.data), '0xee568446');
  const { functionName, args } = decodeFunctionData({ abi: ABI.factory, data: create.data });
  assert.equal(functionName, 'createVault');
  assert.equal(args[1], 0n);
  assert.equal(args[0].root.tokenId, ROOT_V4);
  assert.equal(args[0].root.positionManager.toLowerCase(), review.init.root.positionManager);
  assert.deepEqual({ ...args[0].policy }, SIMPLE);
  assert.deepEqual({ ...args[0].limits }, LIMITS);
  assert.equal(args[0].consentToUncollectedFees, true);

  const first = await run(client, review, 0);
  assert.equal(first.receipt.state, 'finalized');
  assert.equal(chain.nft(4, ROOT_V4).approved, review.vault);
  const second = await run(client, review, 1);
  assert.equal(second.receipt.state, 'finalized');
  assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), tx.data]), [[approve.to, approve.data], [create.to, create.data]], 'exactly the reviewed calldata, in order');
  const created = second.receipt.events.find((e) => e.eventName === 'VaultCreated');
  assert.equal(created.args.vault.toLowerCase(), review.vault);
  assert.equal(created.args.owner.toLowerCase(), OWNER);
  assert.equal(created.args.rootTokenId, ROOT_V4);
  assert.deepEqual(second.receipt.events.filter((e) => e.address === review.vault).map((e) => e.eventName), ['Initialized', 'PolicyChanged', 'LimitsChanged', 'RootRearmed']);
  assert.equal(chain.vault(review.vault).owner, OWNER);
  assert.equal(chain.nft(4, ROOT_V4).subscriber, review.vault, 'the vault is the root\'s subscriber');
  // Never setApprovalForAll: no call reached it, and nothing sent carries its selector.
  const setApprovalForAll = toFunctionSelector('setApprovalForAll(address,bool)');
  assert.equal(chain.strange.length, 0);
  assert.ok(chain.sends.every((tx) => !tx.data.startsWith(setApprovalForAll)));
});

test('the approval is skipped when the root is already approved to that vault, and a done step is never offered again', async () => {
  const { chain, client } = setup();
  chain.approveOther(4, ROOT_V4, chain.predict(4, OWNER, 0n));
  const review = await client.reviewCreate(request());
  assert.deepEqual(review.steps.map((s) => s.kind), ['create-vault']);
  assert.equal(review.approvalNeeded, false);
  await run(client, review, 0);
  assert.equal(chain.sends.length, 1);

  const { chain: c2, client: k2 } = setup();
  const r2 = await k2.reviewCreate(request());
  await run(k2, r2, 0);
  await assert.rejects(k2.prepareStep(r2, 0, GAS), /vault_step_not_needed/, 'the approval is not offered twice');
  assert.equal(c2.sends.length, 1);
});

test('the caller’s objects changing after the review change nothing that is sent', async () => {
  const { chain, client } = setup();
  const asked = request({ policy: { ...SIMPLE }, limits: { ...LIMITS } });
  const review = await client.reviewCreate(asked);
  asked.policy.maxPositions = 9;
  asked.limits.maxSlippageBps = 9_000;
  asked.tokenId = 999n;
  await run(client, review, 0);
  await run(client, review, 1);
  assert.equal(chain.sends[1].data, review.steps[1].data, 'the reviewed createVault, exactly');
  assert.deepEqual(chain.vault(review.vault).policy, SIMPLE);
  assert.deepEqual(chain.vault(review.vault).limits, LIMITS);
});

test('the create step waits for its approval: not prepared while the root is not approved to the predicted vault', async () => {
  const { chain, client } = setup();
  const review = await client.reviewCreate(request());
  await assert.rejects(client.prepareStep(review, 1, GAS), /vault_approval_missing/);
  assert.equal(chain.sends.length, 0);
});

test('v3: the NonfungiblePositionManager is the root\'s manager; what it owes the root is a warning and goes to the wallet at arming; Domino-compound says 4%', async () => {
  const { chain, client } = setup();
  // Changed on purpose 2026-10-04 (the deployed vault's #317 limits): a v3 reference age of 120 s (600 s is above the 300 s cap).
  const review = await client.reviewCreate(request({ dex: 3, tokenId: ROOT_V3, policy: DOMINO, limits: { ...LIMITS, maxObservationAgeSeconds: 120 } }));
  assert.equal(review.init.root.positionManager, chains.v2Chain(4663).uniswap.v3.positionManager);
  assert.equal(review.factory, chain.factory[3]);
  assert.equal(review.vault, chain.predict(3, OWNER, 0n));
  assert.deepEqual(review.owed, [5_000n, 7_000n]);
  assert.deepEqual(review.warnings, ['vault_v3_owed_to_wallet']);
  assert.equal(VAULT_TEXT.vault_v3_owed_to_wallet, 'Amounts waiting to be collected from this position will be sent to your wallet when automation starts.');
  assert.deepEqual(review.consent, { key: 'vault_consent_uncollected_fees', fee: '4%' });
  assert.equal(review.pool.tickSpacing, 60);
  assert.equal(review.steps[0].to, chains.v2Chain(4663).uniswap.v3.positionManager);
  await run(client, review, 0);
  await run(client, review, 1);
  assert.deepEqual(chain.paid.at(-1).amounts, [5_000n, 7_000n]);
  assert.equal(chain.paid.at(-1).to, OWNER);

  const quiet = await setup().client.reviewCreate(request({ dex: 3, tokenId: 78n, limits: { ...LIMITS, maxObservationAgeSeconds: 120 } }));
  assert.deepEqual(quiet.warnings, [], 'nothing owed: no warning');
});

test('refused before anything is sent: a hooked v4 pool, another app as subscriber, no consent, a root the wallet does not hold', async () => {
  const cases = [
    [request({ tokenId: HOOKED }), /^Error: vault_hooked_pool$/, 'vault_hooked_pool'],
    [request({ tokenId: FOREIGN }), /^Error: vault_foreign_subscriber$/, 'vault_foreign_subscriber'],
    [request({ consentToUncollectedFees: false }), /^Error: vault_consent_required$/, 'vault_consent_required'],
    [request({ consentToUncollectedFees: 'yes' }), /^Error: vault_consent_required$/, null],
    [request({ tokenId: NOT_MINE }), /^Error: vault_root_not_owned$/, null],
    [request({ tokenId: 999n }), /^Error: vault_position_not_found$/, null],
    [request({ tokenId: 0n }), /^Error: vault_invalid_token_id$/, null],
    [request({ tokenId: 1n << 96n }), /^Error: vault_invalid_token_id$/, null],
    [request({ dex: 2 }), /^Error: vault_invalid_dex$/, null],
  ];
  for (const [ask, code, copy] of cases) {
    const { chain, client } = setup();
    await assert.rejects(client.reviewCreate(ask), (error) => code.test(String(error)), String(code));
    assert.deepEqual(sentMethods(chain), [], `${code}: nothing estimated or sent`);
    if (copy) assert.equal(typeof VAULT_TEXT[copy], 'string');
  }
  assert.equal(VAULT_TEXT.vault_hooked_pool, "Pools with hooks can't be automated yet.");
  assert.equal(VAULT_TEXT.vault_foreign_subscriber, 'Another app is connected to this position. Remove it at Uniswap first.');
});

test('§5.2: every limit at its edge, allowed on one side and refused on the other, before anything is sent', async () => {
  const edges = [
    ['policy', 'mode', 2, 3, 'vault_policy_mode', { maxPositions: 2 }],
    ['policy', 'mode', 1, 0, 'vault_policy_mode', {}],
    ['policy', 'maxPositions', 1, 2, 'vault_policy_simple_one_position', {}],
    ['policy', 'triggerDistanceBps', 2000, 2001, 'vault_policy_trigger_distance', {}],
    ['policy', 'maxOverlapBps', 2000, 2001, 'vault_policy_max_overlap', {}],
    // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 2, the deployed vault's #317 limits): at least 600 s
    // between executions (was 1 s), slippage up to 1,000 bps and the band up to 500 (were 9,999), the age up to 300 s.
    ['policy', 'minimumIntervalSeconds', 600, 599, 'vault_policy_minimum_interval', {}],
    ['policy', 'maxPositions', 255, 0, 'vault_policy_max_positions', { mode: 2 }],
    ['limits', 'maxSlippageBps', 1000, 1001, 'vault_limits_max_slippage', {}],
    ['limits', 'maxPriceImpactBps', 500, 501, 'vault_limits_max_price_impact', {}],
    ['limits', 'maxObservationAgeSeconds', 1, 0, 'vault_limits_observation_age', {}],
    ['limits', 'maxObservationAgeSeconds', 300, 301, 'vault_limits_observation_age', {}],
    ['limits', 'upsideBps', 1, 0, 'vault_limits_upside', {}],
    ['limits', 'upsideBps', 1_000_000, 1_000_001, 'vault_limits_upside', {}],
    ['limits', 'maxSlippageBps', 0, 1.5, 'vault_limits_max_slippage', {}],
  ];
  for (const [part, field, ok, bad, code, extra] of edges) {
    const okPolicy = part === 'policy' ? { ...SIMPLE, ...extra, [field]: ok } : SIMPLE;
    const badPolicy = part === 'policy' ? { ...SIMPLE, ...extra, [field]: bad } : SIMPLE;
    const okLimits = part === 'limits' ? { ...LIMITS, [field]: ok } : LIMITS;
    const badLimits = part === 'limits' ? { ...LIMITS, [field]: bad } : LIMITS;
    assert.deepEqual(settingsProblems(okPolicy, okLimits, 4), [], `${field} = ${ok} is allowed`);
    assert.ok(settingsProblems(badPolicy, badLimits, 4).includes(code), `${field} = ${bad} is ${code}`);
  }
  // On v3 the reference price's age is at least 60 s (the TWAP's minimum window).
  assert.deepEqual(settingsProblems(SIMPLE, { ...LIMITS, maxObservationAgeSeconds: 60 }, 3), []);
  assert.deepEqual(settingsProblems(SIMPLE, { ...LIMITS, maxObservationAgeSeconds: 59 }, 3), ['vault_limits_observation_age_v3']);
  assert.deepEqual(settingsProblems(SIMPLE, { ...LIMITS, maxObservationAgeSeconds: 59 }, 4), [], 'v4: any age above zero');
  // maxPositions may not go below the vault's members.
  assert.deepEqual(settingsProblems({ ...DOMINO, maxPositions: 2 }, LIMITS, 4, 3), ['vault_policy_max_positions']);

  // Through the client: refused at the review, nothing estimated or sent. The fake factory would accept a v3 age of
  // 59 s (it is the app's rule, not the contract's), so this proves the app refuses it itself.
  for (const ask of [
    request({ policy: { ...SIMPLE, triggerDistanceBps: 2001 } }),
    request({ limits: { ...LIMITS, upsideBps: 0 } }),
    request({ dex: 3, tokenId: 78n, limits: { ...LIMITS, maxObservationAgeSeconds: 59 } }),
  ]) {
    const { chain, client } = setup();
    await assert.rejects(client.reviewCreate(ask), /vault_invalid_settings: vault_/);
    assert.deepEqual(sentMethods(chain), []);
  }
});

test('the race (§5.1): another tab creates a vault after the approval; the create is refused with vault_nonce_moved, and the next review predicts the new address and asks a NEW approval', async () => {
  const { chain, client } = setup();
  const first = await client.reviewCreate(request());
  await run(client, first, 0);
  assert.equal(chain.nft(4, ROOT_V4).approved, first.vault);
  chain.moveNonce(4);
  await assert.rejects(client.prepareStep(first, 1, GAS), /^Error: vault_nonce_moved$/);
  await assert.rejects(client.prepareStep(first, 0, GAS), /^Error: vault_nonce_moved$/, 'a stale prediction is never approved again');
  assert.equal(chain.sends.length, 1);
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.equal(VAULT_TEXT.vault_nonce_moved, 'Another automation was set up from this wallet. Review again: your approval must point to the new one.');

  const again = await client.reviewCreate(request());
  assert.equal(again.nonce, 1n);
  assert.notEqual(again.vault, first.vault);
  assert.equal(again.vault, chain.predict(4, OWNER, 1n));
  assert.deepEqual(again.steps.map((s) => s.kind), ['approve-root', 'create-vault'], 'the old approval points at the old prediction: a new one is asked');
  assert.equal(decodeFunctionData({ abi: ABI.v4, data: again.steps[0].data }).args[0].toLowerCase(), again.vault);
  await run(client, again, 0);
  const { receipt } = await run(client, again, 1);
  assert.equal(receipt.events.find((e) => e.eventName === 'VaultCreated').args.vault.toLowerCase(), again.vault);
});

test('the race between the review of the create step and its send: the send re-derives the step and refuses, nothing is offered', async () => {
  const { chain, wallet, client } = setup();
  const review = await client.reviewCreate(request());
  await run(client, review, 0);
  const prepared = await client.prepareStep(review, 1, GAS);
  chain.moveNonce(4);
  await assert.rejects(client.send(prepared, true), /^Error: vault_nonce_moved$/);
  assert.equal(chain.sends.length, 1);
  assert.deepEqual(wallet.claims.filter(([kind]) => kind === 'claim').length, 1, 'the create\'s nonce was never claimed');
});

test('a lagging node that still shows the old nonce: the factory refuses in simulation (UnexpectedNonce 0x315f0ba0), said as vault_nonce_moved', async () => {
  const { chain, client } = setup();
  const review = await client.reviewCreate(request());
  await run(client, review, 0);
  chain.lag();
  chain.moveNonce(4);
  const from = chain.calls.length;
  await assert.rejects(client.prepareStep(review, 1, GAS), /^Error: vault_nonce_moved$/);
  // The views still said nonce 0 (nothing to see there): the factory's own refusal in the simulation said it.
  assert.ok(chain.callsSince(from).some((c) => c.method === 'eth_call' && c.from === OWNER && c.calls.includes('factory4.createVault')));
  assert.equal(chain.sends.length, 1);
});

test('a refusal in the wallet (4001) sends nothing and releases the claim; the same review is prepared again', async () => {
  const { chain, wallet, client } = setup();
  const review = await client.reviewCreate(request());
  const prepared = await client.prepareStep(review, 0, GAS);
  chain.decline();
  await assert.rejects(client.send(prepared, true), (error) => error.code === 4001);
  assert.equal(chain.sends.length, 0);
  assert.deepEqual(wallet.claims.map(([kind]) => kind), ['claim', 'release']);
  await assert.rejects(client.send(prepared, true), /wallet_review_required/, 'never offered twice');
  await run(client, review, 0);
  assert.equal(chain.sends.length, 1);
});

test('a review, a prepared step and a receipt are only this client\'s own', async () => {
  const one = setup();
  const two = setup();
  const review = await one.client.reviewCreate(request());
  await assert.rejects(two.client.prepareStep(review, 0, GAS), /vault_review_unknown/);
  await assert.rejects(one.client.prepareStep(review, 2, GAS), /vault_step_unknown/);
  const prepared = await one.client.prepareStep(review, 0, GAS);
  await assert.rejects(two.client.send(prepared, true), /wallet_review_required/);
  await assert.rejects(one.client.send(prepared, false), /wallet_review_required/, 'not acknowledged');
  assert.equal(one.chain.sends.length, 0);
});

test('the wrong chain is refused before anything is read or prepared', async () => {
  const { chain, client } = setup();
  chain.switchChain(8453);
  await assert.rejects(client.reviewCreate(request()), /wallet_wrong_chain/);
  // The connector itself reports Base: nothing is asked of the wallet at all (finance/v2/transact.ts).
  assert.deepEqual(chain.log, []);

  // A review made on the right chain is not prepared after the wallet moved.
  const ok = setup();
  const review = await ok.client.reviewCreate(request());
  ok.chain.switchChain(42161);
  await assert.rejects(ok.client.prepareStep(review, 0, GAS), /wallet_wrong_chain/);
  assert.equal(ok.chain.sends.length, 0);
});

test('the same contracts on Base and Arbitrum: each review carries its chain, and the profile\'s managers of that chain', async () => {
  for (const chainId of [8453, 42161]) {
    const { chain, client } = setup({ chainId });
    const review = await client.reviewCreate(request());
    assert.equal(review.chainId, chainId);
    assert.equal(review.steps[0].to, chains.v2Chain(chainId).uniswap.v4.positionManager);
    const prepared = await client.prepareStep(review, 0, GAS);
    assert.equal(prepared.transaction.chainId, chains.v2Chain(chainId).hex);
    await client.send(prepared, true);
    assert.equal(chain.sends.length, 1);
  }
});

test('the deployment\'s code is checked before the first write: changed code is deployment_code_changed, none is deployment_missing, and a failure is read again', async () => {
  const { chain, client } = setup();
  const review = await client.reviewCreate(request());
  chain.setCode(chain.contracts.addresses.vaultFactoryV4, '0x6000');
  await assert.rejects(client.prepareStep(review, 0, GAS), /deployment_code_changed/);
  chain.setCode(chain.contracts.addresses.vaultFactoryV4, '0x');
  await assert.rejects(client.prepareStep(review, 0, GAS), /deployment_missing/);
  chain.setCode(chain.contracts.addresses.registry, '0x6000');
  chain.setCode(chain.contracts.addresses.vaultFactoryV4, '0x60d0d006600055');
  await assert.rejects(client.prepareStep(review, 0, GAS), /deployment_code_changed/, 'the registry is checked too');
  assert.equal(chain.sends.length, 0);
  assert.equal(chain.log.includes('eth_estimateGas'), false, 'nothing was even estimated');
});

test('a contracts set of another chain is refused at construction; a FIXTURE set is refused in a deployable build (fresh module copy)', () => {
  const chain = createVaultChain({ positions: POSITIONS, timestamp: NOW });
  const wallet = walletOf(chain);
  assert.throws(() => createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(8453)), /deployment_chain_mismatch/);
  assert.throws(() => createVaultClient(wallet, chains.v2Chain(4663), { ...vaultContracts(4663), addresses: { ...vaultContracts(4663).addresses, autoExit: 'nope' } }), /deployment_invalid/);
  const before = globalThis.__DOMINO_DEPLOYABLE__;
  const fresh = () => {
    for (const path of [VAULT_JS, AUTO_EXIT_JS, DEPLOYMENT_JS]) delete require.cache[path];
    return require(VAULT_JS);
  };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = true;
    const deployable = fresh();
    assert.throws(() => deployable.createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663)), /deployment_fixture_refused/);
    const { fixture: _fixture, ...unsaid } = vaultContracts(4663);
    void _fixture;
    assert.throws(() => deployable.createVaultClient(wallet, chains.v2Chain(4663), unsaid), /deployment_fixture_refused/, 'a set that does not say it is real is a fixture');
    // A set that merely says it is real is not the PINNED manifest's set (none until #301): no client in a deployable build.
    assert.throws(() => deployable.createVaultClient(wallet, chains.v2Chain(4663), { ...vaultContracts(4663), fixture: false }), /deployment_not_pinned/);
  } finally {
    if (before === undefined) delete globalThis.__DOMINO_DEPLOYABLE__;
    else globalThis.__DOMINO_DEPLOYABLE__ = before;
    fresh();
  }
  assert.doesNotThrow(() => createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663)), 'a test build takes the fixture');
});
