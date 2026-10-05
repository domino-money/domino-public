/**
 * The S1 client on existing positions (src/finance/v2/zap.ts) against the fake V2 chain: increase, change range and
 * exit on v4 and v3, the individual NFT approval to the zap only where the action needs it and only when it is not
 * already the zap's, the warnings each flow must show, the fee only with conversion legs, and the position card's
 * approval with its "Revoke".
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem';
import { createV2Chain, walletOf, SWAP_LEG_EXECUTED } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createZapClient } = require('../../.test-build/app/src/finance/v2/zap.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const EVENTS_ABI = [...abiOf('IDominoPositionActions'), ...abiOf('IDominoZap'), ...abiOf('IDominoFeeEvents'), SWAP_LEG_EXECUTED];
const NFT_APPROVE = parseAbi(['function approve(address spender, uint256 tokenId)']);

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZAP_V4 = fx.FAKE.zapV4.toLowerCase();
const ZAP_V3 = fx.FAKE.zapV3.toLowerCase();
const V4_PM = fx.ROBINHOOD.uniswap.v4.positionManager;
const V3_NPM = fx.ROBINHOOD.uniswap.v3.positionManager;
const PRINCIPAL = [5n * 10n ** 17n, 2_000_000_000n];
const V4_POSITION = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: PRINCIPAL, fees: [10n ** 15n, 1_000_000n] };
const V3_POSITION = { dex: 3, tokenId: 777n, pool: fx.USDG_MANY_V3, tickLower: -600, tickUpper: 600, liquidity: 10n ** 15n, principal: [1_000_000_000n, 10n ** 21n], fees: [1_000n, 10n ** 15n] };

function setup(options = {}) {
  // The deployment check is once per page session (finance/v2/deployment.ts): each test is a fresh session.
  forgetV2DeploymentChecks();
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F1/F4): priced pools, honest targets and bases (fx.honest).
  const chain = createV2Chain({ balances: { [fx.USDG]: 5_000_000_000n, [fx.MANY]: 10n ** 22n }, pools: fx.PRICED, ...options });
  const wallet = walletOf(chain);
  const raw = createZapClient(wallet, chains.v2Chain(chain.home), chain.contracts, () => fx.NOW);
  return { chain, wallet, client: fx.honest(raw, chain), raw };
}
const quoteOf = (plan, extra = {}) => ({ requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null }, ...extra });
const reviewOf = (client, action, plan, extra = {}) => client.review({ chainId: 4663, plan: { action, plan }, consent: 'direct', quote: quoteOf(plan, extra) });
const eventsOf = (receipt) => receipt.logs.map((entry) => decodeEventLog({ abi: EVENTS_ABI, data: entry.data, topics: entry.topics }));
async function runAll(client, review) {
  const receipts = [];
  for (let i = 0; i < review.steps.length; i++) receipts.push(await client.receipt(await client.send(await client.prepareStep(review, i, GAS), true)));
  return receipts;
}
/** A v3 plan on the USDG/MANY position: its pool and range. */
const onV3 = (plan, fields = {}) => fx.sealed({ ...plan, intent: { ...plan.intent, pool: fx.USDG_MANY_V3, tokenId: V3_POSITION.tokenId, tickLower: V3_POSITION.tickLower, tickUpper: V3_POSITION.tickUpper, ...fields } }, fx.USDG);

test('v4 increase: the NFT approval step only while getApproved is not the zap; fees accrued go back to the wallet', async () => {
  const { chain, client } = setup({ positions: [V4_POSITION] });
  const plan = fx.increasePlan();
  const review = await reviewOf(client, 'increase', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'approve-nft', 'action']);
  assert.deepEqual({ ...review.steps[1] }, { kind: 'approve-nft', manager: V4_PM, tokenId: V4_POSITION.tokenId, spender: ZAP_V4 });
  assert.deepEqual(review.warnings, ['v4_increase_sends_fees', 'nft_approval_stays']);
  assert.equal(review.fee, null, 'No Domino fee without a swap');
  assert.equal(review.position.liquidity, V4_POSITION.liquidity);

  await client.send(await client.prepareStep(review, 0, GAS), true);
  const nft = await client.prepareStep(review, 1, GAS);
  assert.equal(nft.transaction.to, V4_PM, 'on the chain\'s own PositionManager');
  assert.deepEqual(decodeFunctionData({ abi: NFT_APPROVE, data: nft.transaction.data }).args, [ZAP_V4, V4_POSITION.tokenId], 'one tokenId, never setApprovalForAll');
  await client.send(nft, true);
  assert.equal(chain.nft(4, V4_POSITION.tokenId).approved, ZAP_V4);
  await assert.rejects(client.prepareStep(review, 1, GAS), /step_not_needed/);
  const increase = await client.prepareStep(review, 2, GAS);
  assert.equal(increase.transaction.data.slice(0, 10), '0x2e563c43', 'increase(IncreasePlan)');
  const receipt = await client.receipt(await client.send(increase, true));
  const events = eventsOf(receipt);
  const executed = events.at(-1);
  assert.deepEqual([executed.eventName, executed.args.action, executed.args.tokenId, executed.args.previousTokenId], ['PositionActionExecuted', 2, V4_POSITION.tokenId, V4_POSITION.tokenId]);
  assert.ok(events.some((event) => event.eventName === 'Refunded' && event.args.token === fx.ZERO), 'the accrued ETH fees came back');

  assert.equal(review.replacesApproval, null, 'nothing was approved before');
  // Already approved to the zap: no approval step.
  const again = await reviewOf(client, 'increase', plan);
  assert.deepEqual(again.steps.map((step) => step.kind), ['approve', 'action']);
  assert.equal(again.replacesApproval, null);
});

test('an NFT holds one individual approval: the review names the one (a vault, another app) the approval to the zap would replace', async () => {
  const VAULT = '0x00000000000000000000000000000000000ca117';
  const { chain, client } = setup({ positions: [{ ...V4_POSITION, approved: VAULT }] });
  const review = await reviewOf(client, 'increase', fx.increasePlan());
  assert.equal(review.replacesApproval, VAULT);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'approve-nft', 'action']);
  await runAll(client, review);
  assert.equal(chain.nft(4, V4_POSITION.tokenId).approved, ZAP_V4, 'the vault lost its approval: the screen must say so first');
});

test('v3 increase: no NFT approval at all (the v3 increase is open), the owner still acts as owner', async () => {
  const { chain, client } = setup({ positions: [V3_POSITION] });
  const plan = onV3(fx.increasePlan({ inputs: [{ token: fx.USDG, amount: 100_000_000n }] }));
  const review = await reviewOf(client, 'increase', plan);
  assert.equal(review.zap, ZAP_V3);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
  assert.deepEqual(review.warnings, []);
  const receipts = await runAll(client, review);
  assert.equal(receipts.at(-1).state, 'finalized');
  assert.equal(chain.nft(3, V3_POSITION.tokenId).approved, fx.ZERO);
  assert.ok(chain.nft(3, V3_POSITION.tokenId).liquidity > V3_POSITION.liquidity);
});

test('change range needs the NFT approval on v4 and v3, says a new NFT is made, burns the old one with all of its liquidity', async () => {
  for (const [position, plan] of [
    [V4_POSITION, fx.changeRangePlan()],
    [V3_POSITION, onV3(fx.changeRangePlan({ liquidityToRemove: V3_POSITION.liquidity }), { tickLower: -1200, tickUpper: 1200 })],
  ]) {
    const { chain, client } = setup({ positions: [position] });
    const review = await reviewOf(client, 'changeRange', plan);
    assert.deepEqual(review.steps.map((step) => step.kind), ['approve-nft', 'action'], `v${position.dex}`);
    assert.equal(review.steps[0].manager, position.dex === 4 ? V4_PM : V3_NPM);
    assert.deepEqual(review.warnings, ['change_range_new_nft'], 'the old NFT is burned, so no approval stays on it');
    const receipt = (await runAll(client, review)).at(-1);
    assert.equal(chain.sends.at(-1).tx.data.slice(0, 10), '0x2abb5a53', 'changeRange(ChangeRangePlan)');
    const executed = eventsOf(receipt).at(-1).args;
    assert.equal(executed.previousTokenId, position.tokenId);
    assert.notEqual(executed.tokenId, position.tokenId, 'a new NFT');
    assert.equal(chain.nft(position.dex, position.tokenId), undefined, 'the old one burned');
    assert.equal(chain.nft(position.dex, executed.tokenId).owner, fx.OWNER);
  }
  // Without the burn, the approval stays on the old NFT and the review says so.
  const { client } = setup({ positions: [V4_POSITION] });
  const kept = await reviewOf(client, 'changeRange', fx.changeRangePlan({ liquidityToRemove: V4_POSITION.liquidity / 2n, burnOld: false }));
  assert.deepEqual(kept.warnings, ['change_range_new_nft', 'nft_approval_stays']);
});

test('exit converted carries the 0.65% fee in the rank rule\'s token and the dust warning; collecting only has no fee', async () => {
  const { chain, client } = setup({ positions: [V4_POSITION] });
  const exit = fx.exitConverted();
  const review = await reviewOf(client, 'exit', exit, { expectedRemoved: PRINCIPAL });
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve-nft', 'action']);
  assert.deepEqual(review.warnings, ['exit_conversion_dust']);
  assert.deepEqual([review.fee.token, review.fee.place, review.fee.estimate], [fx.USDG, 'output', true]);
  // §2.8 example 2's shape: 0.65% of what the leg delivers, from the output.
  const expected = fx.quotedFor(exit.legs)[0].expectedOut;
  assert.equal(review.fee.amount, (expected * 65n) / 10_000n);
  const receipt = (await runAll(client, review)).at(-1);
  assert.equal(chain.sends.at(-1).tx.data.slice(0, 10), '0xda5951bb', 'exit(ExitPlan)');
  assert.equal(chain.sends.at(-1).tx.value, '0x0');
  const fee = eventsOf(receipt).find((event) => event.eventName === 'FeeCharged');
  assert.deepEqual([fee.args.kind, fee.args.token.toLowerCase(), fee.args.ref], [1, fx.USDG, review.intentHash]);
  assert.equal(chain.nft(4, V4_POSITION.tokenId), undefined, 'burned with all of its liquidity');

  // An exit converting more than the position is expected to pay is refused before anything is asked.
  const other = setup({ positions: [V4_POSITION] });
  await assert.rejects(reviewOf(other.client, 'exit', exit, { expectedRemoved: [10n ** 17n, PRINCIPAL[1]] }), (error) => error.failures.includes('plan_conversion_exceeds_removal'));

  const collect = fx.sealed({ ...exit, legs: [], liquidityToRemove: 0n, amount0MinRemoved: 0n, amount1MinRemoved: 0n, burn: false, intent: { ...exit.intent, minLiquidity: 0n } }, fx.USDG);
  const collecting = await reviewOf(other.client, 'exit', collect);
  assert.equal(collecting.fee, null, 'No Domino fee');
  assert.deepEqual(collecting.warnings, ['nft_approval_stays']);
  assert.deepEqual(collecting.steps.map((step) => step.kind), ['approve-nft', 'action']);
  const collected = (await runAll(other.client, collecting)).at(-1);
  assert.equal(eventsOf(collected).some((event) => event.eventName === 'FeeCharged'), false);
  assert.equal(other.chain.nft(4, V4_POSITION.tokenId).liquidity, V4_POSITION.liquidity, 'collecting removes no liquidity');
});

test('exit on v3 needs the NFT approval on the NonfungiblePositionManager too; a partial exit keeps the NFT, and its approval stays', async () => {
  const { chain, client } = setup({ positions: [V3_POSITION] });
  const exit = fx.exitConverted();
  const half = V3_POSITION.liquidity / 2n;
  const plan = onV3({ ...exit, legs: [], liquidityToRemove: half, burn: false }, { minLiquidity: half });
  const review = await reviewOf(client, 'exit', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve-nft', 'action']);
  assert.deepEqual([review.steps[0].manager, review.steps[0].spender], [V3_NPM, ZAP_V3]);
  assert.deepEqual(review.warnings, ['nft_approval_stays']);
  assert.equal(review.fee, null, 'to both tokens: no fee');
  await runAll(client, review);
  assert.deepEqual([chain.nft(3, V3_POSITION.tokenId).liquidity, chain.nft(3, V3_POSITION.tokenId).approved], [V3_POSITION.liquidity - half, ZAP_V3]);
});

test('an action on a position this wallet does not hold, or that does not exist, is refused at review', async () => {
  const { client } = setup({ positions: [{ ...V4_POSITION, owner: fx.OTHER }] });
  await assert.rejects(reviewOf(client, 'increase', fx.increasePlan()), (error) => error.failures.includes('plan_not_owner'));
  const none = setup();
  await assert.rejects(reviewOf(none.client, 'increase', fx.increasePlan()), (error) => error.failures.includes('position_not_found'));
});

test('the position card: "Domino can manage this position" only while the zap is approved, and Revoke is approve(address(0), tokenId)', async () => {
  const { chain, client } = setup({ positions: [V4_POSITION, V3_POSITION] });
  const before = await client.positionApproval(4, V4_POSITION.tokenId);
  assert.deepEqual([before.zapApproved, before.revocable, before.holder], [false, false, fx.OWNER]);
  await assert.rejects(client.prepareRevoke(4, V4_POSITION.tokenId, GAS), /revoke_not_offered/);
  chain.approveNft(4, V4_POSITION.tokenId, fx.OTHER);
  await assert.rejects(client.prepareRevoke(4, V4_POSITION.tokenId, GAS), /revoke_not_offered/, 'another app\'s approval is not Domino\'s to revoke');

  for (const [dex, position, manager] of [[4, V4_POSITION, V4_PM], [3, V3_POSITION, V3_NPM]]) {
    chain.approveNft(dex, position.tokenId, dex === 4 ? fx.FAKE.zapV4 : fx.FAKE.zapV3);
    const shown = await client.positionApproval(dex, position.tokenId);
    assert.deepEqual([shown.zapApproved, shown.revocable, shown.manager], [true, true, manager]);
    const revoke = await client.prepareRevoke(dex, position.tokenId, GAS);
    assert.equal(revoke.transaction.to, manager);
    assert.equal(revoke.transaction.data.slice(0, 10), '0x095ea7b3');
    assert.deepEqual(decodeFunctionData({ abi: NFT_APPROVE, data: revoke.transaction.data }).args, [fx.ZERO, position.tokenId]);
    await client.send(revoke, true);
    assert.equal((await client.positionApproval(dex, position.tokenId)).zapApproved, false);
  }
  await assert.rejects(client.positionApproval(4, 999n), /position_not_found/);
});
