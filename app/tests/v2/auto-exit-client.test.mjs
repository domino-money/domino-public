/**
 * The V2 auto-exit client (src/finance/v2/autoExit.ts; spec F7 §4) against the fake V2 chain: the review of an order for
 * a position in the owner's vault, its id (the struct hash, as typedData.mandateId and the module compute it), every
 * §4.2 term refused with its reason before anything is signed, receiveMode never inferred, the module-enabling step only
 * when missing, the signature (nonce journaled before the prompt, a 4001 forgetting it, a used or held nonce never
 * chosen) registered with the owner as the module's recovered signer, the §4.5 status conditions, and the owner's
 * revoke, cancelNonce and claim.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, hashTypedData } from 'viem';
import { ABI, MANDATE_TYPES, OTHER, OWNER, ZERO, createVaultChain, mandateHash, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { FAKE, MANY, TSLA, USDG, WETH } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const AUTO_EXIT_JS = require.resolve('../../.test-build/app/src/finance/v2/autoExit.js');
const VAULT_JS = require.resolve('../../.test-build/app/src/finance/v2/vault.js');
const DEPLOYMENT_JS = require.resolve('../../.test-build/app/src/finance/v2/deployment.js');
const auto = require(AUTO_EXIT_JS);
const { createVaultClient } = require(VAULT_JS);
const { forgetV2DeploymentChecks } = require(DEPLOYMENT_JS);
const typed = require('../../.test-build/app/src/finance/v2/typedData.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROOT = 3_409_682n; // the golden's tokenId
const ROOT_V3 = 77n;
const CHILD = 3_500_001n;
const Q96 = 79228162514264337593543950336n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const WETH_USDG_V3 = { currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60 };
/** The golden's terms (api-contracts/v2/eip712-goldens.json), on this owner's vault. */
const golden = (vault, fields = {}) => ({
  vault, tokenId: ROOT, triggerBelowSqrtPriceX96: Q96, triggerAboveSqrtPriceX96: 0n, receiveMode: 1, convertTo: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  maxSlippageBps: 100, validUntil: 1_798_646_400n, acknowledgedWarnings: true, ...fields,
});

/** Random draws from a list, then a counter: the tests decide which nonces the client sees. */
const draws = (...values) => {
  let next = 1_000n;
  return () => (values.length ? values.shift() : next++);
};

async function setup({ account, ownerCode = null, random = draws(1n), module = ZERO, signatures, finality = 'final' } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ positions: [
    { dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 },
    { dex: 3, tokenId: ROOT_V3, pool: WETH_USDG_V3 },
  ], timestamp: NOW, ownerCode, finality });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, policy: { mode: 2, triggerDistanceBps: 500, maxOverlapBps: 1000, minimumIntervalSeconds: 3600, maxPositions: 3 } });
  const vaultV3 = await chain.seedVault({ dex: 3, tokenId: ROOT_V3, limits: { maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 600, upsideBps: 1000 } });
  chain.addSuccessor(vault, { tokenId: CHILD, parent: ROOT });
  if (module !== ZERO) chain.setExitModule(vault, module);
  const wallet = walletOf(chain, { ...(account ? { account } : {}), ...(signatures ? { signatures } : {}) });
  const client = auto.createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW, random);
  return { chain, wallet, client, vault, vaultV3 };
}
async function step(client, review, index) {
  const prepared = await client.prepareStep(review, index, GAS);
  const hash = await client.send(prepared, true);
  return { prepared, hash, receipt: await client.receipt(hash) };
}
async function registered(context, fields = {}) {
  const review = await context.client.reviewMandate(golden(context.vault, fields));
  const kinds = review.steps.map((s) => s.kind);
  if (kinds[0] === 'enable-exit-module') await step(context.client, review, 0);
  await context.client.signMandate(review);
  const register = await step(context.client, review, kinds.indexOf('register-mandate'));
  return { review, register };
}

test('the golden-like order: the review\'s id is the struct hash typedData.mandateId gives, the module\'s own id, and not the digest', async () => {
  const { client, vault } = await setup();
  const review = await client.reviewMandate(golden(vault));
  assert.equal(review.mandate.nonce, 1n, 'the golden\'s nonce, drawn');
  assert.equal(review.mandate.owner, OWNER);
  assert.equal(review.mandate.vault, vault);
  assert.equal(review.id, typed.mandateId(review.mandate));
  assert.equal(review.id, mandateHash(review.mandate), 'the module computes the same id');
  assert.notEqual(review.id, review.digest);
  assert.equal(review.digest, hashTypedData({ domain: { name: 'Domino', version: '2', chainId: 4663, verifyingContract: FAKE.autoExit }, types: MANDATE_TYPES, primaryType: 'ExitMandate', message: review.mandate }));
  assert.equal(review.typedData.domain.verifyingContract, FAKE.autoExit);
  assert.equal(review.typedData.domain.chainId, 4663);
  // With the golden's owner and vault, the same builder gives the golden's struct hash.
  assert.equal(typed.mandateId({ ...review.mandate, owner: '0x0000000000000000000000000000000000000b0b', vault: '0x000000000000000000000000000000000000cafe' }), '0x9e9e81446114b3d191bec32453583427ce0931f2021588367c86505e91213025');
  assert.equal(review.role, 'root');
  assert.deepEqual(review.receive, { mode: 'converted', token: USDG });
  assert.deepEqual(review.feeRule, { key: 'autoexit_fee_converted_charge', token: USDG });
  assert.equal(review.snapshot.chainId, 4663);
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.mandate));
});

test('§4.2: every invalid term is refused with its reason before anything is signed or sent', async () => {
  const context = await setup();
  const { chain, client, vault } = context;
  const cases = [
    [{ triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: 0n }, 'mandate_no_trigger'],
    [{ triggerBelowSqrtPriceX96: Q96, triggerAboveSqrtPriceX96: Q96 }, 'mandate_trigger_order'],
    [{ triggerBelowSqrtPriceX96: Q96 + 1n, triggerAboveSqrtPriceX96: Q96 }, 'mandate_trigger_order'],
    [{ triggerBelowSqrtPriceX96: 1n << 160n }, 'mandate_trigger_range'],
    [{ triggerAboveSqrtPriceX96: -1n }, 'mandate_trigger_range'],
    [{ triggerBelowSqrtPriceX96: 5 }, 'mandate_trigger_range'],
    [{ receiveMode: 2 }, 'mandate_receive_mode'],
    [{ receiveMode: '1' }, 'mandate_receive_mode'],
    [{ receiveMode: 0, convertTo: USDG }, 'mandate_convert_to_both'],
    [{ receiveMode: 1, convertTo: TSLA }, 'mandate_convert_to_token'],
    [{ receiveMode: 1, convertTo: WETH }, 'mandate_convert_to_token'],
    [{ maxSlippageBps: 0 }, 'mandate_slippage'],
    [{ maxSlippageBps: 1001 }, 'mandate_slippage'],
    [{ maxSlippageBps: 1.5 }, 'mandate_slippage'],
    [{ validUntil: BigInt(NOW) }, 'mandate_valid_until'],
    [{ validUntil: BigInt(NOW - 1) }, 'mandate_valid_until'],
    [{ validUntil: 1n << 64n }, 'mandate_valid_until'],
    [{ validUntil: 1_798_646_400 }, 'mandate_valid_until'],
    [{ tokenId: 999n }, 'mandate_position'],
    [{ acknowledgedWarnings: false }, 'mandate_warnings'],
  ];
  for (const [fields, reason] of cases) {
    await assert.rejects(client.reviewMandate(golden(vault, fields)), (error) => error.message.startsWith('mandate_invalid: ') && error.message.split(' ').includes(reason), `${reason} for ${JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
    assert.equal(typeof auto.MANDATE_REASON_TEXT[reason], 'string');
  }
  // Changed on purpose 2026-10-06 (the owner's point 5: the product is Auto-exit, never an "order" on screen).
  assert.equal(auto.mandateInvalidText('mandate_no_trigger'), "This Auto-exit isn't valid: it needs at least one price to close at.");
  // The edges that ARE allowed: 1 and 1,000 bps, the upper trigger alone, 2^160 − 1, validUntil 2^64 − 1.
  for (const fields of [{ maxSlippageBps: 1 }, { maxSlippageBps: 1000 }, { triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: (1n << 160n) - 1n }, { validUntil: (1n << 64n) - 1n }]) {
    await client.reviewMandate(golden(vault, fields));
  }
  assert.equal(chain.signed.length, 0);
  assert.equal(chain.sends.length, 0);
  assert.equal(chain.log.includes('eth_signTypedData_v4'), false);
});

test('receiveMode is never inferred from convertTo: address(0) is "both" with mode 0 and ETH with mode 1; without a mode it is refused', async () => {
  const { client, vault, vaultV3 } = await setup();
  const both = await client.reviewMandate(golden(vault, { receiveMode: 0, convertTo: ZERO }));
  assert.deepEqual(both.receive, { mode: 'both' });
  assert.equal(both.mandate.receiveMode, 0);
  assert.equal(both.typedData.message.receiveMode, 0);
  assert.deepEqual(both.feeRule, { key: 'autoexit_fee_both_charge', token: USDG }, 'USDG (rank 1) outranks ETH (rank 2)');
  const eth = await client.reviewMandate(golden(vault, { receiveMode: 1, convertTo: ZERO }));
  assert.deepEqual(eth.receive, { mode: 'converted', token: ZERO });
  assert.equal(eth.mandate.receiveMode, 1);
  assert.deepEqual(eth.feeRule, { key: 'autoexit_fee_converted_charge', token: ZERO });
  for (const receiveMode of [undefined, null, '0', true]) {
    await assert.rejects(client.reviewMandate(golden(vault, { receiveMode, convertTo: ZERO })), /mandate_invalid: .*mandate_receive_mode/, String(receiveMode));
  }
  // v3 has no native currency: address(0) is not one of a v3 pool's tokens.
  await assert.rejects(client.reviewMandate(golden(vaultV3, { tokenId: ROOT_V3, receiveMode: 1, convertTo: ZERO })), /mandate_convert_to_token/);
  const weth = await client.reviewMandate(golden(vaultV3, { tokenId: ROOT_V3, receiveMode: 1, convertTo: WETH }));
  assert.deepEqual(weth.receive, { mode: 'converted', token: WETH });
});

test('§4.6: the fee rule of the way to receive, by the pool tokens\' charge-currency ranks', () => {
  const pool = (currency0, currency1) => ({ currency0, currency1 });
  assert.deepEqual(auto.autoExitFeeRule(1, USDG, pool(ZERO, USDG), 2, 1), { key: 'autoexit_fee_converted_charge', token: USDG });
  assert.deepEqual(auto.autoExitFeeRule(1, ZERO, pool(ZERO, MANY), 2, 0), { key: 'autoexit_fee_converted_charge', token: ZERO }, 'ETH/MANY to ETH: 20 bps of the ETH output');
  assert.deepEqual(auto.autoExitFeeRule(1, MANY, pool(ZERO, MANY), 2, 0), { key: 'autoexit_fee_converted_other', token: null }, 'ETH/MANY to MANY: 20 bps of each token withdrawn');
  assert.deepEqual(auto.autoExitFeeRule(0, ZERO, pool(ZERO, USDG), 2, 1), { key: 'autoexit_fee_both_charge', token: USDG });
  assert.deepEqual(auto.autoExitFeeRule(0, ZERO, pool(WETH, ZERO), 2, 2), { key: 'autoexit_fee_both_charge', token: WETH }, 'a tie: token0');
  assert.deepEqual(auto.autoExitFeeRule(0, ZERO, pool(TSLA, MANY), 0, 0), { key: 'autoexit_fee_both_none', token: null }, 'MANY/TSLA both: 20 bps of each');
  assert.equal(auto.AUTO_EXIT_TEXT.autoexit_fee_line, "Fee: 0.2% of the position's value, only if it closes. It's the only fee.");
});

test('the warnings must be acknowledged; the v3 TWAP one is on a v3 vault only, the fee line last', async () => {
  const { client, vault, vaultV3 } = await setup();
  await assert.rejects(client.reviewMandate(golden(vault, { acknowledgedWarnings: false })), /mandate_warnings/);
  await assert.rejects(client.reviewMandate(golden(vault, { acknowledgedWarnings: 'yes' })), /mandate_warnings/);
  const v4 = await client.reviewMandate(golden(vault));
  assert.deepEqual(v4.warnings, ['autoexit_warning_not_guaranteed', 'autoexit_warning_reference_price', 'autoexit_warning_slippage_on_top', 'autoexit_warning_turn_off_pauses', 'autoexit_warning_other_orders', 'autoexit_warning_halt', 'autoexit_fee_line']);
  const v3 = await client.reviewMandate(golden(vaultV3, { tokenId: ROOT_V3, convertTo: USDG }));
  assert.deepEqual(v3.warnings.slice(0, 3), ['autoexit_warning_not_guaranteed', 'autoexit_warning_reference_price', 'autoexit_warning_v3_twap']);
  assert.equal(v3.warnings.length, 8);
  for (const key of v3.warnings) assert.equal(typeof auto.AUTO_EXIT_TEXT[key], 'string');
});

test('the order\'s position: the vault\'s root or an ACTIVE successor; the vault the factory\'s and the wallet\'s', async () => {
  const { chain, client, vault } = await setup();
  const child = await client.reviewMandate(golden(vault, { tokenId: CHILD }));
  assert.equal(child.role, 'successor');
  await assert.rejects(client.reviewMandate(golden(OTHER)), /vault_unknown/);
  await assert.rejects(client.reviewMandate(golden(chain.predict(4, OWNER, 7n))), /vault_unknown/);
  const other = await setup({ account: OTHER });
  await assert.rejects(other.client.reviewMandate(golden(other.vault)), /vault_not_owner/);
});

test('the module-enabling step is offered only when the vault\'s module is not the manifest\'s auto-exit, and only ever names it', async () => {
  const off = await setup();
  const review = await off.client.reviewMandate(golden(off.vault));
  assert.deepEqual(review.steps.map((s) => s.kind), ['enable-exit-module', 'sign-mandate', 'register-mandate']);
  const { prepared } = await step(off.client, review, 0);
  assert.equal(prepared.transaction.to, off.vault);
  const call = decodeFunctionData({ abi: ABI.vault, data: prepared.transaction.data });
  assert.equal(call.functionName, 'setExitModule');
  assert.equal(call.args[0].toLowerCase(), FAKE.autoExit);
  assert.equal(off.chain.vault(off.vault).exitModule, FAKE.autoExit);
  await assert.rejects(off.client.prepareStep(review, 0, GAS), /mandate_step_not_needed/, 'not twice');
  await assert.rejects(off.client.prepareStep(review, 1, GAS), /mandate_step_is_signature/);

  const on = await setup({ module: FAKE.autoExit });
  const ready = await on.client.reviewMandate(golden(on.vault));
  assert.deepEqual(ready.steps.map((s) => s.kind), ['sign-mandate', 'register-mandate']);
});

test('sign then register: the nonce is journaled before the prompt, the signature checked, the module recovers the owner; the nonce is let go once finalized', async () => {
  const context = await setup();
  const { chain, wallet, client, vault } = context;
  const review = await client.reviewMandate(golden(vault));
  await step(client, review, 0);
  await assert.rejects(client.prepareStep(review, 2, GAS), /mandate_not_signed/, 'no registration without the signature');
  const signed = await client.signMandate(review);
  assert.equal(signed.shape, 'ecdsa-low-s', 'a plain account signs ECDSA with a low s');
  assert.equal(signed.digest, review.digest);
  // The journal held the nonce before the wallet was asked.
  const recorded = wallet.journal.find(([kind]) => kind === 'record');
  assert.deepEqual(recorded.slice(0, 2), ['record', review.mandate.nonce]);
  assert.ok(recorded[2] < chain.log.lastIndexOf('eth_signTypedData_v4') + 1 && chain.log.slice(recorded[2]).includes('eth_signTypedData_v4'), 'recorded before the prompt');
  assert.equal(chain.log.slice(0, recorded[2]).includes('eth_signTypedData_v4'), false);
  assert.deepEqual(client.heldNonces().map((e) => e.nonce), [review.mandate.nonce]);
  await assert.rejects(client.signMandate(review), /mandate_already_signed/);

  const { prepared, receipt } = await step(client, review, 2);
  assert.equal(prepared.transaction.to, FAKE.autoExit);
  assert.equal(prepared.transaction.data.slice(0, 10), '0x68c665c2');
  const call = decodeFunctionData({ abi: ABI.autoExit, data: prepared.transaction.data });
  assert.equal(call.args[1], signed.signature, 'the review\'s own signature');
  assert.equal(receipt.state, 'finalized');
  const event = receipt.events.find((e) => e.eventName === 'MandateRegistered');
  assert.equal(event.args.mandateHash, review.id);
  assert.equal(event.args.owner.toLowerCase(), OWNER);
  assert.equal(event.args.vault.toLowerCase(), vault);
  assert.equal(event.args.tokenId, ROOT);
  assert.equal(event.args.validUntil, review.mandate.validUntil);
  assert.equal(chain.module().records.get(review.id).signer, OWNER, 'the module recovered the vault\'s owner');
  assert.deepEqual(client.heldNonces(), [], 'finalized: the chain now holds the nonce as used');
  await assert.rejects(client.prepareStep(review, 2, GAS), /mandate_nonce_used/, 'never registered twice');
  const status = await client.status(review.id);
  assert.equal(status.status, 'active');
  assert.equal(status.canFire, true);
  assert.deepEqual(status.failing, []);
});

test('what is signed is built from the review’s frozen order: a caller changing the review’s typed data changes nothing', async () => {
  const { chain, client, vault } = await setup({ module: FAKE.autoExit });
  const review = await client.reviewMandate(golden(vault));
  assert.throws(() => { review.mandate.convertTo = ZERO; }, TypeError, 'the order itself is frozen');
  review.typedData.message.convertTo = ZERO;
  review.typedData.message.maxSlippageBps = 1000;
  const signed = await client.signMandate(review);
  assert.equal(signed.digest, review.digest);
  assert.equal(chain.signed[0].wire.message.convertTo, review.mandate.convertTo);
  assert.equal(Number(chain.signed[0].wire.message.maxSlippageBps), 100);
  const { receipt } = await step(client, review, 1);
  assert.ok(receipt.events.some((e) => e.eventName === 'MandateRegistered' && e.args.mandateHash === review.id));
});

test('status reads everything at one block', async () => {
  const context = await setup();
  const { review } = await registered(context);
  const from = context.chain.calls.length;
  const status = await context.client.status(review.id);
  const reads = context.chain.callsSince(from).filter((c) => c.method === 'eth_call');
  assert.ok(reads.length >= 8);
  assert.equal(new Set(reads.map((c) => c.block)).size, 1);
  assert.equal(reads[0].block, `0x${status.blockNumber.toString(16)}`);
  assert.equal(status.record.vault, context.vault);
  assert.equal(status.record.tokenId, ROOT);
  assert.equal(status.record.convertTo, USDG);
});

test('a registration only included (not yet finalized) keeps the nonce held', async () => {
  const context = await setup({ finality: 'lagging', module: FAKE.autoExit });
  const review = await context.client.reviewMandate(golden(context.vault));
  await context.client.signMandate(review);
  const { receipt } = await step(context.client, review, 1);
  assert.equal(receipt.state, 'included');
  assert.equal(context.client.heldNonces().length, 1);
  // Used at the latest block but not at the finalized one: refused, and STILL held (a reorg could drop the
  // registration and leave the signed order valid; only a finalized use lets the journal go).
  await assert.rejects(context.client.prepareStep(review, 1, GAS), /mandate_nonce_used/);
  await assert.rejects(context.client.prepareCancelNonce(review.mandate.nonce, GAS), /mandate_nonce_used/);
  assert.deepEqual(context.client.heldNonces().map((entry) => entry.nonce), [review.mandate.nonce]);
  assert.deepEqual((await context.client.reconcileNonces()).map((entry) => entry.nonce), [review.mandate.nonce]);
});

test('a registration used at the finalized block lets the journal go when the step is tried again', async () => {
  const context = await setup({ module: FAKE.autoExit });
  const review = await context.client.reviewMandate(golden(context.vault));
  await context.client.signMandate(review);
  await step(context.client, review, 1);
  await assert.rejects(context.client.prepareStep(review, 1, GAS), /mandate_nonce_used/);
  assert.deepEqual(context.client.heldNonces(), []);
});

test('a refusal at signing (4001) forgets the nonce; any other failure keeps it held', async () => {
  const { chain, wallet, client, vault } = await setup({ module: FAKE.autoExit });
  const review = await client.reviewMandate(golden(vault));
  chain.decline();
  await assert.rejects(client.signMandate(review), (error) => error.code === 4001);
  assert.deepEqual(wallet.journal.map(([kind, nonce]) => [kind, nonce]), [['record', 1n], ['forget', 1n]]);
  assert.deepEqual(client.heldNonces(), []);
  // Nothing was signed: the same review may be signed now.
  await client.signMandate(review);
  assert.equal(client.heldNonces().length, 1);

  const other = await setup({ module: FAKE.autoExit });
  const again = await other.client.reviewMandate(golden(other.vault));
  other.chain.failNext('eth_signTypedData_v4');
  await assert.rejects(other.client.signMandate(again));
  assert.deepEqual(other.client.heldNonces().map((e) => e.nonce), [1n], 'an unknown outcome keeps the nonce held: it may need cancelling');
  await assert.rejects(other.client.signMandate(again), /mandate_nonce_held/);
});

test('a nonce used on chain, or held in the page\'s journal, is never chosen', async () => {
  const signatures = new Map();
  const first = await setup({ random: draws(5n, 6n), signatures });
  first.chain.useNonce(OWNER, 5n);
  const review = await first.client.reviewMandate(golden(first.vault));
  assert.equal(review.mandate.nonce, 6n);
  first.chain.setExitModule(first.vault, FAKE.autoExit);
  const fresh = await first.client.reviewMandate(golden(first.vault));
  await first.client.signMandate(fresh); // holds 1000n (the counter after 5 and 6)
  const second = auto.createAutoExitClient(walletOf(first.chain, { signatures }), chains.v2Chain(4663), vaultContracts(4663), () => NOW, draws(fresh.mandate.nonce, 6n, 77n));
  const third = await second.reviewMandate(golden(first.vault));
  assert.equal(third.mandate.nonce, 6n, 'the held nonce was skipped; an unregistered review\'s nonce is not reserved on chain');
  const stuck = auto.createAutoExitClient(walletOf(first.chain, { signatures }), chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => 5n);
  await assert.rejects(stuck.reviewMandate(golden(first.vault)), /mandate_nonce_unavailable/);
});

test('a delegated (EIP-7702) owner is verified by EIP-1271: the signature shape is "contract", and it still registers', async () => {
  const designator = '0xef0100000000000000000000000000000000000000d7';
  const { client, vault } = await setup({ ownerCode: designator, module: FAKE.autoExit });
  const review = await client.reviewMandate(golden(vault));
  const signed = await client.signMandate(review);
  assert.equal(signed.shape, 'contract');
  const { receipt } = await step(client, review, 1);
  assert.ok(receipt.events.some((e) => e.eventName === 'MandateRegistered'));
});

test('status (§4.5): active, expired (not a contract status), revoked, executed', async () => {
  const context = await setup();
  const { chain, client } = context;
  const { review } = await registered(context);
  assert.deepEqual((await client.status(review.id)).checks, { active: true, moduleEnabled: true, ownerUnchanged: true, position: true, notHalted: true });
  chain.advance(Number(review.mandate.validUntil) - NOW + 10);
  const expired = await client.status(review.id);
  assert.equal(expired.status, 'active', 'still 1 on chain');
  assert.equal(expired.expired, true);
  assert.deepEqual(expired.failing, ['mandate_status_expired']);
  assert.equal(expired.canFire, false);
  assert.equal(auto.AUTO_EXIT_TEXT.mandate_status_expired, 'Expired');

  const two = await setup();
  const r2 = (await registered(two)).review;
  await two.client.send(await two.client.prepareRevoke(r2.id, GAS), true);
  const revoked = await two.client.status(r2.id);
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(revoked.failing, ['mandate_status_revoked']);

  const three = await setup();
  const r3 = (await registered(three)).review;
  three.chain.executeMandate(r3.id);
  const executed = await three.client.status(r3.id);
  assert.equal(executed.status, 'executed');
  assert.deepEqual(executed.failing, ['mandate_status_executed']);

  const unknown = await three.client.status(`0x${'ab'.repeat(32)}`);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.record, null);
  await assert.rejects(three.client.status('0x1234'), /mandate_invalid_id/);
});

test('status (§4.5): the module off pauses, the vault\'s owner changed, the root\'s approval lost, a successor gone, the chain halted', async () => {
  const context = await setup();
  const { chain, client, vault } = context;
  const { review } = await registered(context);
  // Turning the module off is the vault client's set-exit-module to address(0): it pauses the order, never cancels it.
  const vaults = createVaultClient(walletOf(chain), chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  const off = await vaults.reviewAction(vault, { kind: 'set-exit-module', module: ZERO });
  await vaults.send(await vaults.prepareStep(off, 0, GAS), true);
  const paused = await client.status(review.id);
  assert.equal(paused.status, 'active');
  assert.deepEqual(paused.failing, ['mandate_module_off']);
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation"); 2026-10-06, Auto-exit by its name.
  assert.equal(auto.AUTO_EXIT_TEXT.mandate_module_off, 'Paused: Auto-exit is turned off for this position.');
  chain.setExitModule(vault, FAKE.autoExit);
  assert.deepEqual((await client.status(review.id)).failing, [], 'turned on again: the order is back');

  chain.approveOther(4, ROOT, OTHER);
  assert.deepEqual((await client.status(review.id)).failing, ['mandate_root_custody_lost']);
  chain.approveOther(4, ROOT, vault);
  chain.halt(true);
  assert.deepEqual((await client.status(review.id)).failing, ['mandate_halted']);
  chain.halt(false);
  chain.setVaultOwner(vault, OTHER);
  const changed = await client.status(review.id);
  assert.deepEqual(changed.failing, ['mandate_owner_changed']);
  assert.equal(changed.ownedByWallet, true, 'the order is still this wallet\'s');

  const two = await setup();
  const child = (await registered(two, { tokenId: CHILD })).review;
  assert.deepEqual((await two.client.status(child.id)).failing, []);
  const vaults2 = createVaultClient(walletOf(two.chain), chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  const out = await vaults2.reviewAction(two.vault, { kind: 'withdraw-child', tokenId: CHILD });
  await vaults2.send(await vaults2.prepareStep(out, 0, GAS), true);
  assert.deepEqual((await two.client.status(child.id)).failing, ['mandate_successor_inactive']);
});

test('revoke: only an active order of this owner (0xd91ebc2a); not again; not another owner\'s', async () => {
  const context = await setup();
  const { chain, client } = context;
  const { review } = await registered(context);
  const other = auto.createAutoExitClient(walletOf(chain, { account: OTHER }), chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  await assert.rejects(other.prepareRevoke(review.id, GAS), /mandate_not_owner/);
  const prepared = await client.prepareRevoke(review.id, GAS);
  assert.equal(prepared.transaction.to, FAKE.autoExit);
  assert.equal(prepared.transaction.data.slice(0, 10), '0xd91ebc2a');
  assert.equal(prepared.summary[0], 'Turn off this Auto-exit.');
  const receipt = await client.receipt(await client.send(prepared, true));
  assert.ok(receipt.events.some((e) => e.eventName === 'MandateRevoked' && e.args.mandateHash === review.id));
  await assert.rejects(client.prepareRevoke(review.id, GAS), /mandate_not_active/);
  await assert.rejects(client.prepareRevoke(`0x${'cd'.repeat(32)}`, GAS), /mandate_not_active/);
});

test('cancelNonce (0xcfdd7aea): a signed order never registered is voided; afterwards it can never be registered', async () => {
  const { chain, client, vault } = await setup({ module: FAKE.autoExit });
  const review = await client.reviewMandate(golden(vault));
  await client.signMandate(review);
  await assert.rejects(client.prepareCancelNonce(424242n, GAS), /mandate_nonce_not_held/, 'only a nonce this page signed for');
  const prepared = await client.prepareCancelNonce(review.mandate.nonce, GAS);
  assert.equal(prepared.transaction.data.slice(0, 10), '0xcfdd7aea');
  assert.equal(decodeFunctionData({ abi: ABI.autoExit, data: prepared.transaction.data }).args[0], review.mandate.nonce);
  const receipt = await client.receipt(await client.send(prepared, true));
  assert.ok(receipt.events.some((e) => e.eventName === 'NonceCancelled' && e.args.nonce === review.mandate.nonce));
  assert.deepEqual(client.heldNonces(), []);
  await assert.rejects(client.prepareStep(review, 1, GAS), /mandate_nonce_used/);
  assert.equal(chain.module().status.get(review.id), undefined);
});

test('reconcile: a held nonce the chain says is used is let go', async () => {
  const { chain, client, vault } = await setup({ module: FAKE.autoExit });
  const review = await client.reviewMandate(golden(vault));
  await client.signMandate(review);
  assert.equal(client.heldNonces().length, 1);
  assert.equal((await client.reconcileNonces()).length, 1, 'unused: still held');
  chain.useNonce(OWNER, review.mandate.nonce);
  assert.deepEqual(await client.reconcileNonces(), []);
});

test('claim (0x21c0b342): never to address(0), never for nothing, to the address the owner chose', async () => {
  const { chain, client } = await setup();
  await assert.rejects(client.prepareClaim(USDG, ZERO, GAS), /^Error: claim_invalid_recipient$/);
  await assert.rejects(client.prepareClaim(USDG, 'nope', GAS), /^Error: claim_invalid_recipient$/);
  await assert.rejects(client.prepareClaim(USDG, OTHER, GAS), /^Error: claim_nothing$/);
  chain.setUnclaimed(OWNER, USDG, 12_345n);
  assert.deepEqual((await client.readUnclaimed([ZERO, USDG])).amounts, [{ token: ZERO, amount: 0n }, { token: USDG, amount: 12_345n }]);
  const prepared = await client.prepareClaim(USDG, OTHER, GAS);
  assert.equal(prepared.transaction.data.slice(0, 10), '0x21c0b342');
  assert.deepEqual(decodeFunctionData({ abi: ABI.autoExit, data: prepared.transaction.data }).args.map((a) => a.toLowerCase()), [USDG, OTHER]);
  const receipt = await client.receipt(await client.send(prepared, true));
  const claimed = receipt.events.find((e) => e.eventName === 'Claimed');
  assert.equal(claimed.args.recipient.toLowerCase(), OTHER);
  assert.equal(claimed.args.amount, 12_345n);
  assert.deepEqual(chain.paid.at(-1), { to: OTHER, tokens: [USDG], amounts: [12_345n], why: 'claim' });
  await assert.rejects(client.prepareClaim(USDG, OTHER, GAS), /claim_nothing/);
});

test('the wrong chain is refused before anything is read, signed or prepared; code changed is deployment_code_changed', async () => {
  const { chain, client, vault } = await setup();
  chain.switchChain(8453);
  const before = chain.log.length;
  await assert.rejects(client.reviewMandate(golden(vault)), /wallet_wrong_chain/);
  // The connector itself reports Base: nothing is asked of the wallet at all (finance/v2/transact.ts).
  assert.equal(chain.log.length, before, 'not even the account was read');
  chain.switchChain(4663);
  const review = await client.reviewMandate(golden(vault));
  chain.switchChain(42161);
  await assert.rejects(client.signMandate(review), /wallet_wrong_chain/);
  assert.equal(chain.log.includes('eth_signTypedData_v4'), false);
  assert.deepEqual(client.heldNonces(), [], 'refused before the journal');

  const two = await setup();
  const r2 = await two.client.reviewMandate(golden(two.vault));
  two.chain.setCode(FAKE.autoExit, '0x6000');
  await assert.rejects(two.client.prepareStep(r2, 0, GAS), /deployment_code_changed/);
  two.chain.setCode(FAKE.autoExit, '0x');
  await assert.rejects(two.client.prepareRevoke(`0x${'ab'.repeat(32)}`, GAS), /deployment_missing/);
  assert.equal(two.chain.sends.length, 0);
});

test('a review is only this client\'s own, and a FIXTURE contracts set is refused in a deployable build (fresh module copy)', async () => {
  const one = await setup();
  const two = await setup();
  const review = await one.client.reviewMandate(golden(one.vault));
  await assert.rejects(two.client.signMandate(review), /mandate_review_unknown/);
  await assert.rejects(two.client.prepareStep(review, 0, GAS), /mandate_review_unknown/);
  await assert.rejects(one.client.prepareStep(review, 9, GAS), /mandate_step_unknown/);

  const wallet = walletOf(one.chain);
  assert.throws(() => auto.createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(42161)), /deployment_chain_mismatch/);
  const before = globalThis.__DOMINO_DEPLOYABLE__;
  const fresh = () => {
    for (const path of [AUTO_EXIT_JS, VAULT_JS, DEPLOYMENT_JS]) delete require.cache[path];
    return require(AUTO_EXIT_JS);
  };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = true;
    assert.throws(() => fresh().createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(4663)), /deployment_fixture_refused/);
  } finally {
    if (before === undefined) delete globalThis.__DOMINO_DEPLOYABLE__;
    else globalThis.__DOMINO_DEPLOYABLE__ = before;
    fresh();
  }
});
