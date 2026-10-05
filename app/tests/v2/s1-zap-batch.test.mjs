/**
 * The S1 client's EIP-5792 batch path and consent choice (src/finance/v2/zap.ts consentFor, prepareBatch, sendBatch,
 * batchReceipt; spec F7 §2.5.1 "Lote", §2.5.4), against the fake V2 chain (tests/support/v2-chain.mjs, its batch
 * extension): the batch carries [approvals…, NFT approval?, action] exactly as the steps would, simulated whole through
 * the wallet only, offered once behind the plan's latch on its own chain, and its receipt found by the intentHash. Then
 * the review fixes of B1: a plan's action is handed to the wallet once, ever, on either path (F1), and a typed-data
 * prompt runs through the operation's bounded calls (F3).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { createV2Chain, walletOf } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createZapClient } = require('../../.test-build/app/src/finance/v2/zap.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const { readZapReceipt } = require('../../.test-build/app/src/finance/v2/receipt.js');
const chains = require('../../.test-build/app/src/v2/chains.js');
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const ZAP_ABI = [...abiOf('IDominoPositionActions'), ...abiOf('IDominoZap')];
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const NFT = parseAbi(['function approve(address spender, uint256 tokenId)']);

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZAP_V4 = fx.FAKE.zapV4.toLowerCase();
const PERMIT2 = fx.ROBINHOOD.permit2;

/** The page's batch latch, in memory, inspectable (finance/nonce.ts's semantics: a claim, the wallet's id, a release by either). */
function memoryLatch() {
  const map = new Map();
  const asked = [];
  return {
    map,
    asked,
    batchOffered: (key) => (map.has(key) ? map.get(key).id ?? '' : null),
    async claimBatch(key) {
      if (map.has(key)) throw new Error('wallet_batch_already_offered');
      const claim = `claim-${map.size}`;
      map.set(key, { claim });
      return claim;
    },
    async recordBatch(key, claim, id) { if (map.get(key)?.claim === claim) map.get(key).id = id; },
    async releaseBatch(key, claim) { const entry = map.get(key); if (entry && (entry.claim === claim || entry.id === claim)) map.delete(key); },
    expired: [],
    async expireBatch(key, maxAge) { this.expired.push([key, maxAge]); const entry = map.get(key); if (entry?.old) { map.delete(key); return true; } return false; },
  };
}

function setup(options = {}, wallet = {}) {
  forgetV2DeploymentChecks();
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F1/F4): priced pools, honest targets and bases (fx.honest).
  const chain = createV2Chain({ balances: { [fx.USDG]: 5_000_000_000n }, atomic: 'supported', simulateV1: true, pools: fx.PRICED, ...options });
  const w = walletOf(chain, wallet);
  const raw = createZapClient(w, chains.v2Chain(chain.home), chain.contracts, () => fx.NOW);
  const latch = memoryLatch();
  const latchFor = (chainId, owner) => { latch.asked.push([chainId, owner]); return latch; };
  return { chain, wallet: w, client: fx.honest(raw, chain), raw, latch, latchFor };
}
const quoteOf = (plan, extra = {}) => ({ requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null }, ...extra });
const reviewOf = (client, action, plan, extra = {}) => client.review({ chainId: 4663, plan: { action, plan }, consent: 'direct', quote: quoteOf(plan, extra.quote ?? {}), ...extra.input });
const methods = (chain, name) => chain.log.filter((method) => method === name).length;

test('consentFor reads the wallet’s batches and the account’s code on THIS chain, and picks the path of §2.5.4', async () => {
  const batching = setup();
  assert.deepEqual({ ...(await batching.client.consentFor('create', [{ token: fx.USDG }])) }, { path: 'batch', planConsent: 'direct', reason: 'wallet_batches', atomic: 'supported', account: 'plain' });
  assert.equal(batching.chain.sends.length, 0, 'reads only');
  const ready = setup({ atomic: 'ready' });
  assert.equal((await ready.client.consentFor('exit', [])).path, 'batch');
  const plain = setup({ atomic: null });
  assert.deepEqual({ ...(await plain.client.consentFor('create', [{ token: fx.USDG }])) }, { path: 'permit2', planConsent: 'permit2', reason: 'plain_account_erc20', atomic: 'unsupported', account: 'plain' });
  assert.equal((await plain.client.consentFor('create', [{ token: fx.ZERO }])).reason, 'native_input');
  assert.equal((await plain.client.consentFor('changeRange', [])).reason, 'position_action');
  const delegated = setup({ atomic: null, ownerCode: 'delegated' });
  assert.deepEqual({ ...(await delegated.client.consentFor('increase', [{ token: fx.USDG }])) }, { path: 'direct', planConsent: 'direct', reason: 'account_has_code', atomic: 'unsupported', account: 'delegated' });
  // Another chain's wallet: switch first.
  plain.chain.switchTo(8453);
  await assert.rejects(plain.client.consentFor('create', [{ token: fx.USDG }]), /wallet_wrong_chain/);
});

test('a direct create as ONE batch: [approve(zap, exact), create(plan)], simulated through the wallet, offered once on 0x1237, its receipt found by the intentHash', async () => {
  const { chain, client, latch, latchFor } = setup();
  const plan = fx.createWithSwap();
  const review = await reviewOf(client, 'create', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
  const batch = await client.prepareBatch(review, GAS);
  assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.calls));
  assert.deepEqual(batch.kinds, ['approve', 'action']);
  assert.equal(batch.key, review.intentHash);
  assert.equal(batch.calls.length, 2);
  assert.deepEqual([batch.calls[0].to, batch.calls[0].value], [fx.USDG, '0x0']);
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: batch.calls[0].data }).args, [ZAP_V4, 1_000_000_000n], 'exact, never unlimited');
  assert.deepEqual([batch.calls[1].to, batch.calls[1].value, batch.calls[1].data.slice(0, 10)], [ZAP_V4, '0x0', '0x0e97b041']);
  assert.equal(decodeFunctionData({ abi: ZAP_ABI, data: batch.calls[1].data }).functionName, 'create');
  // Exactly as the step-by-step path would send the action.
  assert.ok(batch.gasUsed > 0n && batch.networkFeeWei === ((batch.gasUsed + 150_000n) * 120n + 99n) / 100n * GAS.maxFeePerGas);
  assert.equal(methods(chain, 'eth_simulateV1'), 1);
  assert.equal(chain.sends.length, 0, 'nothing sent by preparing');

  const id = await client.sendBatch(batch, true, latchFor);
  assert.deepEqual(latch.asked, [[4663, fx.OWNER]], 'the latch of the review’s chain');
  assert.equal(latch.map.get(review.intentHash).id, id, 'the wallet’s id kept beside the claim');
  assert.equal(chain.batches.length, 1);
  assert.deepEqual(chain.batches[0].calls, batch.calls.map((call) => ({ ...call })), 'the wallet sees exactly the prepared calls');
  const offer = chain.asked.find(({ method }) => method === 'wallet_sendCalls').params[0];
  assert.deepEqual([offer.version, offer.chainId, offer.from, offer.atomicRequired], ['2.0.0', '0x1237', fx.OWNER, true]);
  assert.equal(methods(chain, 'eth_simulateV1'), 2, 'simulated again right before the wallet');
  const askedOrder = chain.log.filter((m) => m === 'eth_chainId' || m === 'wallet_sendCalls');
  assert.deepEqual(askedOrder.slice(-2), ['eth_chainId', 'wallet_sendCalls'], 'the chain read right before the offer');

  await assert.rejects(client.sendBatch(batch, true, latchFor), /wallet_review_required/, 'a batch is offered once');
  await assert.rejects(client.prepareBatch(review, GAS), /review_already_sent/);
  await assert.rejects(client.prepareStep(review, 1, GAS), /review_already_sent/, 'nor its action step by step');
  assert.equal(client.handedOver(review), true);

  const receipt = await client.batchReceipt(id, latchFor);
  assert.equal(receipt.state, 'finalized');
  const read = readZapReceipt({ chainId: 4663, zap: review.zap, intent: review.plan.plan.intent, owner: fx.OWNER, receipt: { status: '0x1', logs: receipt.logs, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice } });
  assert.equal(read.summary.actionName, 'create');
  assert.deepEqual(read.fee, { token: fx.USDG, amount: 3_250_000n, payer: fx.OWNER });
  assert.ok(chain.nft(4, read.summary.tokenId), 'the position exists');
  assert.equal(latch.map.has(review.intentHash), false, 'read back on chain: the latch goes, as V1 setup\'s does');
  assert.equal(client.handedOver(review), true, 'and this client still never offers the plan again');
  await assert.rejects(client.prepareBatch(review, GAS), /review_already_sent/);
});

test('a short non-zero allowance of a zero-first token: [approve(0), approve(exact), action]; an NFT approval for a v4 exit: [approve(zap, tokenId), exit]', async () => {
  const { client } = setup({ zeroFirst: [fx.USDG], allowances: [{ token: fx.USDG, spender: ZAP_V4, amount: 5n }] });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve-reset', 'approve', 'action']);
  const batch = await client.prepareBatch(review, GAS);
  assert.deepEqual(batch.kinds, ['approve-reset', 'approve', 'action']);
  assert.deepEqual(batch.calls.slice(0, 2).map((call) => decodeFunctionData({ abi: ERC20, data: call.data }).args[1]), [0n, 1_000_000_000n]);

  const position = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: [10n ** 18n, 2_000_000_000n], fees: [10n ** 15n, 1_000_000n] };
  const exit = setup({ positions: [position] });
  const plan = fx.exitConverted();
  const exitReview = await reviewOf(exit.client, 'exit', plan, { quote: { expectedRemoved: [10n ** 18n, 2_000_000_000n] } });
  assert.deepEqual(exitReview.steps.map((step) => step.kind), ['approve-nft', 'action']);
  const exitBatch = await exit.client.prepareBatch(exitReview, GAS);
  assert.deepEqual(exitBatch.kinds, ['approve-nft', 'action']);
  assert.equal(exitBatch.calls[0].to, fx.ROBINHOOD.uniswap.v4.positionManager);
  assert.deepEqual(decodeFunctionData({ abi: NFT, data: exitBatch.calls[0].data }).args, [ZAP_V4, fx.POSITION.tokenId], 'one tokenId, never for all');
  const id = await exit.client.sendBatch(exitBatch, true, exit.latchFor);
  assert.equal((await exit.client.batchReceipt(id, exit.latchFor)).state, 'finalized');
  assert.equal(exit.chain.nft(4, fx.POSITION.tokenId), undefined, 'burned with the full removal');
});

test('a wallet without eth_simulateV1: no batch (no other node is asked), the steps go one by one', async () => {
  const { chain, client } = setup({ simulateV1: false });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  await assert.rejects(client.prepareBatch(review, GAS), /batch_simulation_unavailable/);
  assert.equal(methods(chain, 'wallet_sendCalls'), 0);
  // The step-by-step path is still open for this review.
  await client.send(await client.prepareStep(review, 0, GAS), true);
  await client.send(await client.prepareStep(review, 1, GAS), true);
  assert.equal(chain.sends.length, 2);
});

test('a refusal in the wallet, or a wallet that cannot batch, lets the latch and the plan go: a new batch can be offered', async () => {
  for (const code of [4001, 5700, 5750]) {
    const { chain, client, latch, latchFor } = setup();
    const review = await reviewOf(client, 'create', fx.createWithSwap());
    chain.declineBatch(code);
    await assert.rejects(client.sendBatch(await client.prepareBatch(review, GAS), true, latchFor), code === 4001 ? /User rejected/ : code === 5750 ? /batch_upgrade_declined/ : /batch_unsupported/);
    assert.equal(latch.map.size, 0, `${code}: released`);
    assert.equal(client.handedOver(review), false, `${code}: nothing ran`);
    const id = await client.sendBatch(await client.prepareBatch(review, GAS), true, latchFor);
    assert.equal((await client.batchReceipt(id, latchFor)).state, 'finalized');
  }
});

test('a latch another tab holds is never offered over; the wrong chain right before the offer is refused before any claim', async () => {
  const held = setup();
  const review = await reviewOf(held.client, 'create', fx.createWithSwap());
  const batch = await held.client.prepareBatch(review, GAS);
  await held.latch.claimBatch(review.intentHash);
  await assert.rejects(held.client.sendBatch(batch, true, held.latchFor), /batch_already_offered/);
  assert.equal(methods(held.chain, 'wallet_sendCalls'), 0);
  assert.deepEqual(held.latch.expired, [[review.intentHash, 1500]], 'a latch met again is let go only past 1,500 s (V1 setup\'s BATCH_LATCH_EXPIRY_S)');
  // Past it, the stale latch goes and the batch is offered.
  held.latch.map.get(review.intentHash).old = true;
  const id = await held.client.sendBatch(batch, true, held.latchFor);
  assert.equal(held.latch.map.get(review.intentHash).id, id);

  const moved = setup();
  const review2 = await reviewOf(moved.client, 'create', fx.createWithSwap());
  const batch2 = await moved.client.prepareBatch(review2, GAS);
  moved.chain.once('eth_simulateV1', () => moved.chain.switchTo(8453));
  await assert.rejects(moved.client.sendBatch(batch2, true, moved.latchFor), /wallet_wrong_chain/);
  assert.equal(moved.latch.map.size, 0, 'nothing claimed');
  assert.equal(moved.client.handedOver(review2), false);
  assert.equal(methods(moved.chain, 'wallet_sendCalls'), 0);
  await assert.rejects(moved.client.sendBatch(batch2, false, moved.latchFor), /wallet_review_required/);
});

test('batchReceipt: pending while the wallet says 100, then the transaction found by the intentHash; a reverted batch frees the latch and the plan', async () => {
  const { chain, client, latch, latchFor } = setup();
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const id = await client.sendBatch(await client.prepareBatch(review, GAS), true, latchFor);
  chain.holdBatches();
  assert.deepEqual(await client.batchReceipt(id, latchFor), { state: 'pending' });
  chain.releaseBatches();
  const done = await client.batchReceipt(id, latchFor);
  assert.equal(done.state, 'finalized');
  const getLogs = chain.asked.find(({ method }) => method === 'eth_getLogs').params[0];
  assert.deepEqual(getLogs.topics, ['0xf6a97c0d2054864127258f1e392259b35bdb4e5360f3f78285bf30675b4b8b9a', review.intentHash], 'PositionLiquidityChanged with this plan’s intentHash');
  assert.equal(getLogs.address, ZAP_V4);
  await assert.rejects(client.batchReceipt('batch-unknown', latchFor), /receipt_not_from_this_review/);

  const reverting = setup();
  const review2 = await reviewOf(reverting.client, 'create', fx.createWithSwap());
  const batch2 = await reverting.client.prepareBatch(review2, GAS);
  // The simulation right before the offer passes; the price then moves before the wallet runs the calls.
  reverting.chain.once('eth_simulateV1', () => reverting.chain.movePrice());
  const id2 = await reverting.client.sendBatch(batch2, true, reverting.latchFor);
  assert.deepEqual(await reverting.client.batchReceipt(id2, reverting.latchFor), { state: 'batch-reverted' });
  assert.equal(reverting.latch.map.size, 0);
  assert.equal(reverting.client.handedOver(review2), false);
  assert.equal(latch.map.has(review.intentHash), false, 'the finalized batch let its latch go');
});

test('F1: an action whose outcome is unknown is never handed over again; a definite refusal lets the same review be sent', async () => {
  let connected = true;
  const { chain, client } = setup({ atomic: null }, { current: () => connected });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  await client.send(await client.prepareStep(review, 0, GAS), true);
  const action = await client.prepareStep(review, 1, GAS);
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F2): the wallet sends it and answers, then the page loses
  // the connector: its hash is KEPT (the step is followed to its receipt), and the plan is never handed over again.
  chain.once('eth_sendTransaction', () => { connected = false; });
  const kept = await client.send(action, true);
  connected = true;
  assert.match(kept, /^0x[0-9a-f]{64}$/);
  assert.equal(chain.sends.length, 2, 'it was sent');
  assert.equal(client.handedOver(review), true);
  await assert.rejects(client.prepareStep(review, 1, GAS), /review_already_sent/);
  await assert.rejects(client.prepareBatch(review, GAS), /review_already_sent/);
  assert.equal((await client.receipt(kept)).state, 'finalized', 'followed to its receipt');

  // The wallet sends it and answers nothing usable: the outcome is unknown, the plan never handed over again.
  const lost = setup({ atomic: null });
  const lostReview = await reviewOf(lost.client, 'create', fx.createWithSwap());
  await lost.client.send(await lost.client.prepareStep(lostReview, 0, GAS), true);
  const lostAction = await lost.client.prepareStep(lostReview, 1, GAS);
  const answers = lost.chain.request;
  lost.chain.request = async (method, params) => {
    const reply = await answers(method, params);
    return method === 'eth_sendTransaction' ? { result: null } : reply;
  };
  await assert.rejects(lost.client.send(lostAction, true), /wallet_result_unknown/);
  lost.chain.request = answers;
  assert.equal(lost.client.handedOver(lostReview), true);
  await assert.rejects(lost.client.prepareStep(lostReview, 1, GAS), /review_already_sent/);

  const refusing = setup({ atomic: null });
  const review2 = await reviewOf(refusing.client, 'create', fx.createWithSwap());
  await refusing.client.send(await refusing.client.prepareStep(review2, 0, GAS), true);
  refusing.chain.decline();
  await assert.rejects(refusing.client.send(await refusing.client.prepareStep(review2, 1, GAS), true), /User rejected/);
  assert.equal(refusing.client.handedOver(review2), false, 'nothing was sent');
  await refusing.client.send(await refusing.client.prepareStep(review2, 1, GAS), true);
  assert.equal(refusing.client.handedOver(review2), true);
  await assert.rejects(refusing.client.prepareStep(review2, 1, GAS), /review_already_sent/);
  // A refusal of the shared sender before the wallet was asked (an unacknowledged step) keeps nothing.
  const quiet = setup({ atomic: null, allowances: [{ token: fx.USDG, spender: ZAP_V4, amount: 1_000_000_000n }] });
  const review3 = await reviewOf(quiet.client, 'create', fx.createWithSwap());
  await assert.rejects(quiet.client.send(await quiet.client.prepareStep(review3, 0, GAS), false), /wallet_review_required/);
  assert.equal(quiet.client.handedOver(review3), false);
});

test('F3: the Permit2 prompt runs through the bounded calls: a chain change during it is said after the answer, and the nonce stays held', async () => {
  const { chain, wallet, client } = setup({ atomic: null });
  const nonce = await client.chooseNonce('permit2');
  const plan = fx.sealed({ ...fx.createWithSwap(), intent: { ...fx.createWithSwap().intent, nonce } }, fx.USDG);
  const review = await client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'permit2', quote: quoteOf(plan) });
  await client.send(await client.prepareStep(review, 0, GAS), true);
  chain.once('eth_signTypedData_v4', () => chain.switchTo(8453));
  await assert.rejects(client.signPermit(review), /wallet_wrong_chain/);
  assert.equal(chain.signed.length, 1, 'the wallet signed');
  assert.equal(wallet.signatures.held({ chainId: 4663, owner: fx.OWNER, space: 'permit2', verifier: PERMIT2, nonce }), true, 'a signature may exist: the nonce stays held for cancelling');
  chain.switchTo(4663);
  await assert.rejects(client.prepareStep(review, 2, GAS), /permit_signature_missing/, 'a signature the page did not keep is never used');
});

test('item 7: nothing of this owner in flight before a batch is offered (the pending nonce is the latest, none held here)', async () => {
  const { chain, wallet, client, latchFor } = setup();
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const batch = await client.prepareBatch(review);
  // A step of this page holds the next nonce in its journal: a request may still be open in the wallet.
  await wallet.claimNonce(4663, BigInt(chain.sends.length));
  await assert.rejects(client.sendBatch(batch, true, latchFor), /pending_wallet_transaction/);
  assert.equal(methods(chain, 'wallet_sendCalls'), 0);
  assert.equal(client.handedOver(review), false);
});

test('F8: the batch reads its budget inside its own operation; on Base its cost adds the L1 data fee ceiling of its whole calldata', async () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const ETH_USDC_V4 = { dex: 4, currency0: fx.ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: fx.ZERO };
  forgetV2DeploymentChecks();
  const chain = createV2Chain({ chainId: 8453, balances: { [USDC]: 5_000_000_000n }, atomic: 'supported', simulateV1: true, pools: fx.PRICED });
  const client = fx.honest(createZapClient(walletOf(chain), chains.v2Chain(8453), chain.contracts, () => fx.NOW), chain);
  const legs = [{ kind: 3, router: fx.ZERO, tokenIn: USDC, tokenOut: fx.ZERO, amountIn: 500_000_000n, minAmountOut: 190_000_000_000_000_000n, data: fx.v4Path(ETH_USDC_V4) }];
  const plan = fx.sealed({ intent: fx.intent({ pool: ETH_USDC_V4, tickLower: -201060, tickUpper: -198060 }), inputs: [{ token: USDC, amount: 1_000_000_000n }], legs, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, initSqrtPriceX96: 0n }, USDC);
  const review = await client.review({ chainId: 8453, plan: { action: 'create', plan }, consent: 'direct', quote: quoteOf(plan) });
  const before = chain.log.filter((m) => m === 'eth_gasPrice').length;
  const batch = await client.prepareBatch(review);
  assert.equal(chain.log.filter((m) => m === 'eth_gasPrice').length, before + 1, 'the budget is read at the batch\'s review');
  const limit = ((batch.gasUsed + 150_000n) * 120n + 99n) / 100n;
  assert.equal(batch.networkFeeWei, limit * 200_000_000n + 7_000_000_000n, 'the gas at the fee ceiling plus the oracle\'s L1 ceiling');
  const oracle = chain.asked.filter(({ method, params }) => method === 'eth_call' && params[0].to === '0x420000000000000000000000000000000000000f');
  assert.equal(oracle.length, 1);
  const calldata = batch.calls.reduce((sum, call) => sum + BigInt((call.data.length - 2) / 2) + 64n, 0n);
  assert.equal(BigInt(`0x${oracle[0].params[0].data.slice(10)}`), calldata + 160n, 'asked for the batch\'s whole calldata');
});

test('F9: a batch offer the port refuses before the provider is invoked was never asked: the latch and the plan are let go', async () => {
  let armed = 0;
  const current = () => {
    if (armed === 0) return true;
    armed -= 1;
    return armed !== 0;
  };
  const { chain, client, latch, latchFor } = setup({}, { current });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const batch = await client.prepareBatch(review);
  // Right after the claim: offerBatch's own check passes, then the port's check before wallet_sendCalls refuses.
  const claim = latch.claimBatch.bind(latch);
  latch.claimBatch = async (key) => { const token = await claim(key); armed = 2; return token; };
  await assert.rejects(client.sendBatch(batch, true, latchFor), /wallet_action_expired/);
  assert.equal(methods(chain, 'wallet_sendCalls'), 0, 'the wallet never saw it');
  assert.equal(latch.map.size, 0, 'the latch is let go');
  assert.equal(client.handedOver(review), false, 'and the plan');
  latch.claimBatch = claim;
  const id = await client.sendBatch(await client.prepareBatch(review), true, latchFor);
  assert.equal((await client.batchReceipt(id, latchFor)).state, 'finalized');
});

test('F9: a signature the port refused before the prompt forgets its nonce (nothing was signed)', async () => {
  let armed = 0;
  const current = () => {
    if (armed === 0) return true;
    armed -= 1;
    return armed !== 0;
  };
  const { chain, wallet, client } = setup({ atomic: null }, { current });
  const nonce = await client.chooseNonce('permit2');
  const plan = fx.sealed({ ...fx.createWithSwap(), intent: { ...fx.createWithSwap().intent, nonce } }, fx.USDG);
  const review = await client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'permit2', quote: quoteOf(plan) });
  await client.send(await client.prepareStep(review, 0), true);
  // The signer's own eth_chainId read: then its check passes and the port refuses the prompt before the provider sees it.
  const request = chain.request;
  let seen = 0;
  chain.request = async (method, params) => {
    const reply = await request(method, params);
    if (method === 'eth_chainId' && ++seen === 2) armed = 3;
    return reply;
  };
  await assert.rejects(client.signPermit(review), /wallet_action_expired/);
  chain.request = request;
  assert.equal(chain.signed.length, 0, 'never prompted');
  assert.equal(wallet.signatures.held({ chainId: 4663, owner: fx.OWNER, space: 'permit2', verifier: PERMIT2, nonce }), false, 'nothing signed: the nonce is let go');
  await client.signPermit(review);
  assert.equal(chain.signed.length, 1);
});

// Changed on purpose (data) 2026-10-02 (rev2 §2.13 decision #5, §2.6.5 decision #7): an armed root's increase and exit are
// allowed after the pause warning, its change of range refused; a pool is created only when it reads unpriced, at the
// app's own price (check 13).
test('rev2 §2.13: on a vault\'s armed root a change of range is refused, an increase or an exit waits for the pause warning; a successor is refused', async () => {
  const VAULT = '0x00000000000000000000000000000000000000aa';
  const base = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: [10n ** 18n, 2_000_000_000n], fees: [0n, 0n] };
  const root = setup({ positions: [{ ...base, approved: VAULT }], vaults: [VAULT] });
  const exit = fx.exitConverted();
  const review = await reviewOf(root.client, 'exit', exit, { quote: { expectedRemoved: [10n ** 18n, 2_000_000_000n] } });
  assert.equal(review.pausesAutomation, VAULT);
  assert.equal(review.replacesApproval, VAULT, 'approving the zap replaces the vault’s own approval (an NFT holds one)');
  await assert.rejects(root.client.prepareStep(review, 0), /automation_pause_unacknowledged/);
  await assert.rejects(root.client.prepareBatch(review), /automation_pause_unacknowledged/);
  root.client.acknowledgePause(review);
  const prepared = await root.client.prepareStep(review, 0);
  assert.ok(prepared, 'prepared once the warning is ticked');
  await assert.rejects(reviewOf(root.client, 'changeRange', fx.changeRangePlan(), { quote: { expectedRemoved: [10n ** 18n, 2_000_000_000n] } }), (error) => error.failures.includes('position_vault_root'));
  const increase = await reviewOf(root.client, 'increase', fx.increasePlan());
  assert.equal(increase.pausesAutomation, VAULT);
  const successor = setup({ positions: [{ ...base, owner: VAULT }], vaults: [VAULT] });
  await assert.rejects(reviewOf(successor.client, 'exit', exit, { quote: { expectedRemoved: [10n ** 18n, 2_000_000_000n] } }), (error) => error.failures.includes('position_vault_successor'));
  // Another app's approval is no vault: the review goes on, pauses nothing, and says whose approval the step replaces.
  const other = setup({ positions: [{ ...base, approved: fx.OTHER }], vaults: [VAULT] });
  const plain = await reviewOf(other.client, 'exit', exit, { quote: { expectedRemoved: [10n ** 18n, 2_000_000_000n] } });
  assert.equal(plain.replacesApproval, fx.OTHER);
  assert.equal(plain.pausesAutomation, null);
});

test('rev2 §2.6.5, check 13: a pool is initialized only when it reads unpriced, at exactly the price the app computed', async () => {
  const init = 3961408125713216879677197n;
  const creating = fx.createWithSwap({ initSqrtPriceX96: init });
  // Unpriced, and the app's own value: a review that creates the pool. Changed on purpose (data) 2026-10-02 (Domino V2
  // rev2 review, F4): the fake chain prices the plans' pools by default; here the pool has no price (`pools: []`).
  const fresh = setup({ pools: [] });
  const review = await reviewOf(fresh.client, 'create', creating, { input: { initSqrtPriceX96: init } });
  assert.equal(review.createsPool, true);
  // The app computed nothing (or another value): refused.
  await assert.rejects(reviewOf(setup({ pools: [] }).client, 'create', creating), (error) => error.failures.includes('plan_init_price_mismatch'));
  await assert.rejects(reviewOf(setup({ pools: [] }).client, 'create', creating, { input: { initSqrtPriceX96: init + 1n } }), (error) => error.failures.includes('plan_init_price_mismatch'));
  // A price the app computed for a plan that initializes nothing: refused too.
  await assert.rejects(reviewOf(setup({ pools: [] }).client, 'create', fx.createWithSwap(), { input: { initSqrtPriceX96: init } }), (error) => error.failures.includes('plan_init_price_mismatch'));
  // The pool has a price by now (someone created it): refused, said as the race.
  const priced = setup({ pools: [{ pool: fx.ETH_USDG_V4, sqrtPriceX96: init + 7n, tick: -198080 }] });
  await assert.rejects(reviewOf(priced.client, 'create', creating, { input: { initSqrtPriceX96: init } }), (error) => error.failures.includes('plan_pool_has_price'));
  // The pool read through the wallet, as the pool choice reads it.
  const read = await priced.client.readPool(fx.ETH_USDG_V4);
  assert.equal(read.initialized, true);
  assert.equal(read.sqrtPriceX96, init + 7n);
  const none = await fresh.client.readPool({ ...fx.ETH_USDG_V4, fee: 500, tickSpacing: 10 });
  assert.equal(none.initialized, false);
});
