/**
 * The S1 client's signature paths (src/finance/v2/zap.ts) against the fake V2 chain: the Permit2 batch witness
 * (approve Permit2 exactly, sign, createWithPermit with { permitted, nonce, deadline } only), the nonce discipline
 * (free on chain, not held, recorded before the prompt, forgotten only when nothing was signed, settled from the
 * bitmaps), an EIP-7702 account kept to the direct path, cancelling a held nonce, and the relayed signature that is
 * built but never submitted.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, recoverTypedDataAddress } from 'viem';
import { createV2Chain, walletOf } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createZapClient, ZapRefusal } = require('../../.test-build/app/src/finance/v2/zap.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const ZAP_ABI = [...abiOf('IDominoPositionActions'), ...abiOf('IDominoZap')];
const PERMIT2_ABI = [{ name: 'invalidateUnorderedNonces', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'wordPos', type: 'uint256' }, { name: 'mask', type: 'uint256' }], outputs: [] }];

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZAP_V4 = fx.FAKE.zapV4.toLowerCase();
const PERMIT2 = fx.ROBINHOOD.permit2;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function setup(options = {}, random) {
  // The deployment check is once per page session (finance/v2/deployment.ts): each test is a fresh session.
  forgetV2DeploymentChecks();
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F1/F4): priced pools, honest targets and bases (fx.honest).
  const chain = createV2Chain({ balances: { [fx.USDG]: 5_000_000_000n }, pools: fx.PRICED, ...options });
  const wallet = walletOf(chain);
  const client = fx.honest(createZapClient(wallet, chains.v2Chain(chain.home), chain.contracts, () => fx.NOW, random), chain);
  return { chain, wallet, client };
}
const quoteOf = (plan, extra = {}) => ({ requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null }, ...extra });
/** The create of §2.8 example 1 with the intent's nonce set, routesHash and fee terms sealed. */
const createWithNonce = (nonce) => fx.sealed({ ...fx.createWithSwap(), intent: { ...fx.createWithSwap().intent, nonce } }, fx.USDG);
const permitReview = (client, plan) => client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'permit2', quote: quoteOf(plan) });
const entryOf = (space, verifier, nonce) => ({ chainId: 4663, owner: fx.OWNER, space, verifier, nonce });

test('Permit2 create: approve Permit2 exactly, one signature that recovers to the owner, then createWithPermit (0xec627dfe) with { permitted, nonce, deadline } only', async () => {
  const { chain, wallet, client } = setup();
  const nonce = await client.chooseNonce('permit2');
  assert.equal(chain.permit2NonceUsed(nonce), false);
  const plan = createWithNonce(nonce);
  const review = await permitReview(client, plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'sign-permit', 'action']);
  assert.deepEqual({ ...review.steps[0] }, { kind: 'approve', token: fx.USDG, spender: PERMIT2, amount: 1_000_000_000n });
  assert.deepEqual({ ...review.steps[2] }, { kind: 'action', functionName: 'createWithPermit', to: ZAP_V4, value: 0n });

  await assert.rejects(client.signPermit(review), /permit_allowance_missing/, 'the approvals first');
  assert.equal(wallet.signatures.held(entryOf('permit2', PERMIT2, nonce)), false, 'nothing recorded when nothing was asked');
  await assert.rejects(client.prepareStep(review, 2, GAS), /approval_missing/);
  await client.send(await client.prepareStep(review, 0, GAS), true);
  assert.equal(chain.allowance(fx.USDG, PERMIT2), 1_000_000_000n);
  await assert.rejects(client.prepareStep(review, 1, GAS), /step_is_signature/);
  await assert.rejects(client.prepareStep(review, 2, GAS), /permit_signature_missing/);

  const signed = await client.signPermit(review);
  assert.equal(wallet.signatures.held(entryOf('permit2', PERMIT2, nonce)), true, 'held until used or cancelled');
  const { typed, signature } = chain.signed[0];
  assert.equal(signed.signature, signature.toLowerCase());
  assert.deepEqual(typed.types.EIP712Domain.map((field) => field.name), ['name', 'chainId', 'verifyingContract'], 'Permit2\'s domain has no version');
  assert.deepEqual(typed.domain, { name: 'Permit2', chainId: 4663, verifyingContract: PERMIT2 });
  assert.equal(typed.message.spender, ZAP_V4);
  assert.equal(typed.message.nonce, nonce.toString());
  assert.equal(typed.message.witness.nonce, nonce.toString(), 'permit nonce = intent nonce');
  assert.equal(typed.message.deadline, plan.intent.deadline.toString());
  const { EIP712Domain, ...types } = typed.types;
  void EIP712Domain;
  assert.equal((await recoverTypedDataAddress({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message, signature })).toLowerCase(), fx.OWNER);
  await assert.rejects(client.signPermit(review), /permit_already_signed/, 'one signature per review');

  const action = await client.prepareStep(review, 2, GAS);
  assert.equal(action.transaction.data.slice(0, 10), '0xec627dfe');
  assert.equal(action.transaction.value, '0x0');
  const { functionName, args } = decodeFunctionData({ abi: ZAP_ABI, data: action.transaction.data });
  assert.equal(functionName, 'createWithPermit');
  assert.deepEqual(Object.keys(args[1]).sort(), ['deadline', 'nonce', 'permitted']);
  assert.deepEqual(args[1].permitted, [{ token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', amount: 1_000_000_000n }]);
  assert.deepEqual([args[1].nonce, args[1].deadline], [nonce, plan.intent.deadline]);
  assert.equal(args[2], signed.signature);
  const receipt = await client.receipt(await client.send(action, true));
  assert.equal(receipt.state, 'finalized');
  assert.equal(chain.permit2NonceUsed(nonce), true, 'Permit2 consumed the nonce');
  assert.equal(chain.allowance(fx.USDG, PERMIT2), 0n);

  const { settled, held } = await client.settleSignedNonces();
  assert.deepEqual([settled.map((entry) => entry.nonce), held.length], [[nonce], 0]);
  assert.equal(wallet.signatures.held(entryOf('permit2', PERMIT2, nonce)), false);
});

test('a 4001 at the signature forgets the nonce (nothing was signed); the same review can then be signed', async () => {
  const { chain, wallet, client } = setup({ allowances: [{ token: fx.USDG, spender: fx.ROBINHOOD.permit2, amount: 1_000_000_000n }] });
  const nonce = await client.chooseNonce('permit2');
  const review = await permitReview(client, createWithNonce(nonce));
  assert.deepEqual(review.steps.map((step) => step.kind), ['sign-permit', 'action'], 'the Permit2 allowance is already enough');
  chain.declineSignature();
  await assert.rejects(client.signPermit(review), (error) => error.code === 4001);
  assert.equal(wallet.signatures.held(entryOf('permit2', PERMIT2, nonce)), false);
  await client.signPermit(review);
  assert.equal(wallet.signatures.held(entryOf('permit2', PERMIT2, nonce)), true);
});

test('the same nonce cannot be signed twice: a held nonce, or one used on chain, refuses the plan (plan_nonce_used)', async () => {
  const { chain, client } = setup({ allowances: [{ token: fx.USDG, spender: fx.ROBINHOOD.permit2, amount: 1_000_000_000n }] });
  const nonce = await client.chooseNonce('permit2');
  const plan = createWithNonce(nonce);
  await client.signPermit(await permitReview(client, plan));
  await assert.rejects(permitReview(client, plan), (error) => error instanceof ZapRefusal && error.failures.includes('plan_nonce_used'));
  // A nonce another app used (Permit2's bitmap is shared by every SignatureTransfer app of this wallet).
  chain.markPermit2Nonce(77n);
  await assert.rejects(permitReview(client, createWithNonce(77n)), (error) => error.failures.includes('plan_nonce_used'));
  assert.equal(chain.signed.length, 1);
});

test('chooseNonce: a random word, its lowest bit free on chain and not held', async () => {
  const word = 0x1234n;
  const { chain, wallet, client } = setup({}, () => word);
  for (const bit of [0n, 1n, 2n]) chain.markPermit2Nonce((word << 8n) | bit);
  await wallet.signatures.record(entryOf('permit2', PERMIT2, (word << 8n) | 3n));
  assert.equal(await client.chooseNonce('permit2'), (word << 8n) | 4n);
  // The zap's own space (relayed nonces) is another bitmap.
  assert.equal(await client.chooseNonce('zap', 4), word << 8n);
  chain.markZapNonce(4, word << 8n);
  assert.equal(await client.chooseNonce('zap', 4), (word << 8n) | 1n);
  // A real draw is a 248-bit word.
  const drawn = await setup().client.chooseNonce('permit2');
  assert.ok(drawn >= 0n && drawn < 1n << 256n);
});

test('an EIP-7702 delegated account is refused Permit2 and offered the direct path', async () => {
  const { chain, client } = setup({ ownerCode: 'delegated' });
  const plan = createWithNonce(5n);
  await assert.rejects(permitReview(client, plan), (error) => error instanceof ZapRefusal && error.failures.includes('permit2_account_not_plain'));
  const direct = await client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'direct', quote: quoteOf(plan) });
  assert.deepEqual([direct.account, direct.permit2Offered], ['delegated', false]);
  assert.deepEqual(direct.steps.map((step) => step.kind), ['approve', 'action']);
  assert.equal(chain.signed.length, 0);
});

test('cancelling a held Permit2 nonce: invalidateUnorderedNonces (0x3ff9dcb1) with its word and one-bit mask; settled afterwards', async () => {
  const { chain, wallet, client } = setup({ allowances: [{ token: fx.USDG, spender: fx.ROBINHOOD.permit2, amount: 1_000_000_000n }] });
  const nonce = (0xabcn << 8n) | 7n;
  await client.signPermit(await permitReview(client, createWithNonce(nonce)));
  const entry = entryOf('permit2', PERMIT2, nonce);
  await assert.rejects(client.prepareCancelNonce(entryOf('permit2', PERMIT2, nonce + 1n), GAS), /nonce_not_held/);
  const cancel = await client.prepareCancelNonce(entry, GAS);
  assert.equal(cancel.transaction.to, PERMIT2);
  assert.equal(cancel.transaction.data.slice(0, 10), '0x3ff9dcb1');
  assert.deepEqual(decodeFunctionData({ abi: PERMIT2_ABI, data: cancel.transaction.data }).args, [0xabcn, 1n << 7n]);
  await client.send(cancel, true);
  assert.equal(chain.permit2NonceUsed(nonce), true);
  await assert.rejects(client.prepareCancelNonce(entry, GAS), /nonce_already_settled/);
  const { settled } = await client.settleSignedNonces();
  assert.deepEqual(settled.map((item) => item.nonce), [nonce]);
  assert.equal(wallet.signatures.held(entry), false);
});

test('the relayed exit is signed (RelayedPositionAction, low s, the zap\'s nonce held first), never submitted; cancelled with invalidateNonces (0x2bce68d2)', async () => {
  const position = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: [5n * 10n ** 17n, 2_000_000_000n], fees: [10n ** 15n, 1_000_000n] };
  const { chain, wallet, client } = setup({ positions: [position] });
  const nonce = await client.chooseNonce('zap', 4);
  const exit = fx.exitConverted();
  const plan = fx.sealed({ ...exit, intent: { ...exit.intent, nonce } }, fx.USDG);
  const quote = quoteOf(plan, { expectedRemoved: [5n * 10n ** 17n, 2_000_000_000n] });
  const review = await client.review({ chainId: 4663, plan: { action: 'exit', plan }, consent: 'direct', quote });
  await assert.rejects(client.review({ chainId: 4663, plan: { action: 'exit', plan }, consent: 'relayed', quote }), /relayed_not_offered/, 'no relayer exists');
  await assert.rejects(client.signRelayed(review), /nft_approval_missing/, 'the NFT must already be approved to the zap');
  chain.approveNft(4, position.tokenId, fx.FAKE.zapV4);

  const signed = await client.signRelayed(review);
  const { typed } = chain.signed[0];
  assert.equal(typed.primaryType, 'RelayedPositionAction');
  assert.deepEqual(typed.domain, { name: 'Domino', version: '2', chainId: 4663, verifyingContract: ZAP_V4 });
  assert.deepEqual([typed.message.amount0Max, typed.message.amount1Max, typed.message.burn], ['0', '0', true], 'an exit signs zero caps');
  assert.equal(typed.message.intent.nonce, nonce.toString());
  assert.ok(BigInt(`0x${signed.signature.slice(66, 130)}`) <= SECP256K1_HALF_N, 'low s (EIP-2)');
  const entry = entryOf('zap', ZAP_V4, nonce);
  assert.equal(wallet.signatures.held(entry), true);
  await assert.rejects(client.signRelayed(review), /plan_nonce_used/, 'never twice');
  assert.equal(chain.sends.length, 0, 'nothing submits it');

  const cancel = await client.prepareCancelNonce(entry, GAS);
  assert.equal(cancel.transaction.to, ZAP_V4);
  assert.equal(cancel.transaction.data.slice(0, 10), '0x2bce68d2');
  assert.deepEqual(decodeFunctionData({ abi: ZAP_ABI, data: cancel.transaction.data }).args, [nonce >> 8n, 1n << (nonce & 255n)]);
  const receipt = await client.receipt(await client.send(cancel, true));
  assert.equal(receipt.logs.length, 1, 'NoncesInvalidated');
  assert.equal(chain.zapNonceUsed(4, nonce), true);
  assert.deepEqual((await client.settleSignedNonces()).settled.map((item) => item.space), ['zap']);
});

test('a v4 increase through Permit2 still needs the NFT approval: approve Permit2, approve the NFT, sign, then increaseWithPermit (0xc6b4277b)', async () => {
  const position = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: [5n * 10n ** 17n, 2_000_000_000n], fees: [0n, 0n] };
  const { chain, client } = setup({ positions: [position] });
  const nonce = await client.chooseNonce('permit2');
  const increase = fx.increasePlan();
  const plan = fx.sealed({ ...increase, intent: { ...increase.intent, nonce } }, fx.USDG);
  const review = await client.review({ chainId: 4663, plan: { action: 'increase', plan }, consent: 'permit2', quote: quoteOf(plan) });
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'approve-nft', 'sign-permit', 'action']);
  await client.send(await client.prepareStep(review, 0, GAS), true);
  await assert.rejects(client.signPermit(review), /nft_approval_missing/, 'every approval in place before the signature');
  await client.send(await client.prepareStep(review, 1, GAS), true);
  await client.signPermit(review);
  const action = await client.prepareStep(review, 3, GAS);
  assert.equal(action.transaction.data.slice(0, 10), '0xc6b4277b');
  const receipt = await client.receipt(await client.send(action, true));
  assert.equal(receipt.state, 'finalized');
  assert.equal(chain.permit2NonceUsed(nonce), true);
  // Change of range and exit take no Permit2.
  const exit = fx.exitConverted();
  await assert.rejects(client.review({ chainId: 4663, plan: { action: 'exit', plan: exit }, consent: 'permit2', quote: quoteOf(exit, { expectedRemoved: [10n ** 18n, 10n ** 10n] }) }), (error) => error.failures.includes('plan_consent'));
});
