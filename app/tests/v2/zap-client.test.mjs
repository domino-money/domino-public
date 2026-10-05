/**
 * The S1 money client (src/finance/v2/zap.ts), direct path, driven against the fake V2 chain
 * (tests/support/v2-chain.mjs): the steps a review computes, exact approvals (and the reset to zero first), the
 * native value, the calldata, the chain read right before every send, the receipt's events carrying the client's
 * intentHash, every plan check refusing before anything is asked, the wrong chain, the code check, and a revert in
 * simulation. Nothing here touches a network; the keys are Anvil's public dev keys, on a fake chain only.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeEventLog, decodeFunctionData, decodeErrorResult, numberToHex, parseAbi } from 'viem';
import { createV2Chain, walletOf, SWAP_LEG_EXECUTED, REVERTS } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createZapClient, ZapRefusal, MIN_DEADLINE_LEFT_S } = require('../../.test-build/app/src/finance/v2/zap.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const { V2Revert } = require('../../.test-build/app/src/finance/v2/transact.js');
const chains = require('../../.test-build/app/src/v2/chains.js');
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const ZAP_ABI = [...abiOf('IDominoPositionActions'), ...abiOf('IDominoZap')];
const EVENTS_ABI = [...ZAP_ABI, ...abiOf('IDominoFeeEvents'), SWAP_LEG_EXECUTED];
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROBINHOOD = chains.v2Chain(4663);
const ZAP_V4 = fx.FAKE.zapV4.toLowerCase();
const ZAP_V3 = fx.FAKE.zapV3.toLowerCase();
const WETH_USDG_V3 = { dex: 3, currency0: fx.WETH, currency1: fx.USDG, fee: 3000, tickSpacing: 60, hooks: fx.ZERO };

function setup(options = {}, { clock = () => fx.NOW } = {}) {
  // The deployment check is once per page session (finance/v2/deployment.ts): each test is a fresh session.
  forgetV2DeploymentChecks();
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F1/F4): the plans' pools priced on the fake chain, and
  // every review carrying the request's target and the plan's basis as an honest planner gives them (fx.honest).
  const chain = createV2Chain({ pools: fx.PRICED, ...options });
  const wallet = walletOf(chain);
  const raw = createZapClient(wallet, chains.v2Chain(chain.home), chain.contracts, clock);
  return { chain, wallet, client: fx.honest(raw, chain), raw };
}
const quoteOf = (plan, extra = {}) => ({ requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null }, ...extra });
const reviewOf = (client, action, plan, extra = {}) => client.review({ chainId: 4663, plan: { action, plan }, consent: 'direct', quote: quoteOf(plan), ...extra });
const eventsOf = (receipt) => receipt.logs.map((entry) => decodeEventLog({ abi: EVENTS_ABI, data: entry.data, topics: entry.topics }));
const sendsTo = (chain) => chain.log.filter((method) => method === 'eth_sendTransaction').length;

/** Every step of a review, prepared and sent in order, each receipt read; the signature step is skipped. */
async function runAll(client, review) {
  const receipts = [];
  for (let i = 0; i < review.steps.length; i++) {
    if (review.steps[i].kind === 'sign-permit') continue;
    const hash = await client.send(await client.prepareStep(review, i, GAS), true);
    receipts.push(await client.receipt(hash));
  }
  return receipts;
}

test('direct create with a USDG input and a swap leg: one exact approval, then create (0x0e97b041) with no value; the events carry the intentHash', async () => {
  const { chain, wallet, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  const plan = fx.createWithSwap();
  const review = await reviewOf(client, 'create', plan);
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.steps) && Object.isFrozen(review.plan.plan.intent));
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
  assert.deepEqual({ ...review.steps[0] }, { kind: 'approve', token: fx.USDG, spender: ZAP_V4, amount: 1_000_000_000n }, 'the approval is the input, to the zap');
  assert.deepEqual({ ...review.steps[1] }, { kind: 'action', functionName: 'create', to: ZAP_V4, value: 0n });
  assert.deepEqual([review.chainId, review.zap, review.consent, review.account, review.permit2Offered], [4663, ZAP_V4, 'direct', 'plain', true]);
  // Spec §2.8 example 1: 0.65% of the 500 USDG swapped, on top, in USDG (input).
  assert.deepEqual({ ...review.fee }, { estimate: true, bps: 65, token: fx.USDG, place: 'input', swapped: 500_000_000n, amount: 3_250_000n });
  assert.equal(review.legs.length, 1);
  assert.deepEqual(review.warnings, []);
  // Every read of the review is pinned to one block, through the wallet.
  const reviewReads = chain.asked.filter(({ method }) => method === 'eth_call');
  const pinned = chain.asked.find(({ method }) => method === 'eth_getBlockByNumber');
  assert.ok(pinned && reviewReads.length > 0);
  const tag = chain.asked.filter(({ method }) => method === 'eth_call')[0].params[1];
  assert.match(tag, /^0x[0-9a-f]+$/, 'a block number, not "latest"');
  assert.ok(reviewReads.every(({ params }) => params[1] === tag));

  const approve = await client.prepareStep(review, 0, GAS);
  assert.equal(approve.transaction.to, fx.USDG);
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: approve.transaction.data }).args, [ZAP_V4, 1_000_000_000n], 'exact, never unlimited');
  await client.send(approve, true);
  assert.equal(chain.allowance(fx.USDG, ZAP_V4), 1_000_000_000n);

  const action = await client.prepareStep(review, 1, GAS);
  assert.equal(action.transaction.data.slice(0, 10), '0x0e97b041');
  assert.equal(action.transaction.value, '0x0');
  assert.equal(action.transaction.to, ZAP_V4);
  assert.equal(action.transaction.chainId, '0x1237');
  const { functionName, args } = decodeFunctionData({ abi: ZAP_ABI, data: action.transaction.data });
  assert.equal(functionName, 'create');
  assert.equal(args[0].intent.routesHash, plan.intent.routesHash);
  assert.equal(args[0].inputs[0].amount, 1_000_000_000n);
  const before = chain.log.length;
  const hash = await client.send(action, true);
  // The last thing read before the wallet is asked to send is the chain.
  const sent = chain.log.slice(before);
  assert.equal(sent[sent.indexOf('eth_sendTransaction') - 1], 'eth_chainId');
  await assert.rejects(client.send(action, true), /wallet_review_required/, 'never sent twice');

  const receipt = await client.receipt(hash);
  assert.equal(receipt.state, 'finalized');
  const events = eventsOf(receipt);
  assert.deepEqual(events.map((event) => event.eventName), ['InputPulled', 'SwapLegExecuted', 'FeeCharged', 'PositionLiquidityChanged', 'Refunded', 'Refunded', 'PositionActionExecuted']);
  const executed = events.at(-1).args;
  assert.equal(executed.intentHash, review.intentHash, 'the receipt matches the plan by its intentHash');
  assert.equal(chain.intentHashOf(ZAP_V4, plan.intent), review.intentHash, 'the fake hashes the intent on its own and agrees');
  assert.equal(events[0].args.intentHash, review.intentHash);
  assert.deepEqual([events[2].args.token.toLowerCase(), events[2].args.amount, events[2].args.ref], [fx.USDG, 3_250_000n, review.intentHash]);
  assert.equal(chain.nft(4, executed.tokenId).owner, fx.OWNER, 'the NFT goes to the wallet');
  assert.equal(chain.allowance(fx.USDG, ZAP_V4), 0n, 'the zap pulled exactly the approval');
  assert.deepEqual([chain.sends.length, chain.offChain.length, chain.missing.length, wallet.claims.length], [2, 0, 0, 2]);
});

test('direct create paying ETH on v4: the value is the native input and nothing is approved', async () => {
  const { chain, client } = setup();
  const legs = [{ kind: 3, router: fx.ZERO, tokenIn: fx.ZERO, tokenOut: fx.USDG, amountIn: 400_000_000_000_000_000n, minAmountOut: 900_000_000n, data: fx.v4Path(fx.ETH_USDG_V4) }];
  const plan = fx.sealed({ intent: fx.intent({}), inputs: [{ token: fx.ZERO, amount: 10n ** 18n }], legs, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, initSqrtPriceX96: 0n }, fx.USDG);
  const review = await reviewOf(client, 'create', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['action']);
  assert.equal(review.value, 10n ** 18n);
  assert.equal(review.permit2Offered, false, 'Paying with ETH needs a direct transaction');
  assert.deepEqual([review.fee.token, review.fee.place], [fx.USDG, 'output'], 'the rank wins over the place: USDG at the output');
  const prepared = await client.prepareStep(review, 0, GAS);
  assert.equal(prepared.transaction.value, numberToHex(10n ** 18n));
  const ethBefore = chain.balanceOf(fx.ZERO);
  const receipt = await client.receipt(await client.send(prepared, true));
  const events = eventsOf(receipt);
  assert.deepEqual([events[0].eventName, events[0].args.token, events[0].args.amount], ['InputPulled', fx.ZERO, 10n ** 18n]);
  assert.ok(chain.balanceOf(fx.ZERO) < ethBefore);
  // A Permit2 review of the same plan is refused: native ETH cannot go through a signature.
  await assert.rejects(client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'permit2', quote: quoteOf(plan) }), (error) => error instanceof ZapRefusal && error.failures.includes('plan_permit_native'));
});

test('a v3 WETH pool paid with ETH: the ETH is wrapped, what is left comes back as WETH, and the review says so', async () => {
  const { chain, client } = setup();
  const legs = [{ kind: 3, router: fx.ZERO, tokenIn: fx.ZERO, tokenOut: fx.USDG, amountIn: 400_000_000_000_000_000n, minAmountOut: 900_000_000n, data: fx.v4Path(fx.ETH_USDG_V4) }];
  const plan = fx.sealed({ intent: fx.intent({ pool: WETH_USDG_V3 }), inputs: [{ token: fx.ZERO, amount: 10n ** 18n }], legs, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, initSqrtPriceX96: 0n }, fx.USDG);
  const review = await reviewOf(client, 'create', plan);
  assert.equal(review.zap, ZAP_V3, 'dex 3 picks zap.v3');
  assert.deepEqual(review.warnings, ['v3_weth_leftovers']);
  assert.deepEqual(review.steps.map((step) => step.kind), ['action']);
  const receipt = await client.receipt(await client.send(await client.prepareStep(review, 0, GAS), true));
  const refunds = eventsOf(receipt).filter((event) => event.eventName === 'Refunded').map((event) => event.args.token.toLowerCase());
  assert.ok(refunds.includes(fx.WETH), 'unused ETH came back as WETH');
  assert.equal(refunds.includes(fx.ZERO), false);
  assert.ok(chain.balanceOf(fx.WETH) > 0n, 'the wallet now holds WETH it did not send');
});

test('a short non-zero allowance is reset to zero first, then set exactly (a USDT-like token refuses otherwise)', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1n }], zeroFirst: [fx.USDG] });
  const plan = fx.createWithSwap();
  const review = await reviewOf(client, 'create', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve-reset', 'approve', 'action']);
  await assert.rejects(client.prepareStep(review, 1, GAS), /step_out_of_order/, 'the exact approval waits for the reset');
  await assert.rejects(client.prepareStep(review, 2, GAS), /approval_missing/, 'the action waits for both');
  // What the reset avoids: this token refuses a non-zero to non-zero change.
  const direct = await chain.request('eth_call', [{ from: chain.owner, to: fx.USDG, data: '0x095ea7b3' + ZAP_V4.slice(2).padStart(64, '0') + (10n ** 9n).toString(16).padStart(64, '0') }, 'latest']);
  assert.equal(direct.error?.code, 3);

  const reset = await client.prepareStep(review, 0, GAS);
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: reset.transaction.data }).args, [ZAP_V4, 0n]);
  await client.send(reset, true);
  assert.equal(chain.allowance(fx.USDG, ZAP_V4), 0n);
  await assert.rejects(client.prepareStep(review, 0, GAS), /step_not_needed/, 'a reset already done is not offered again');
  const exact = await client.prepareStep(review, 1, GAS);
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: exact.transaction.data }).args, [ZAP_V4, 1_000_000_000n]);
  await client.send(exact, true);
  const receipt = await client.receipt(await client.send(await client.prepareStep(review, 2, GAS), true));
  assert.equal(receipt.state, 'finalized');
  assert.equal(chain.sends.length, 3);
});

test('enough allowance: no approval step; an approval made elsewhere after the review is step_not_needed', async () => {
  const enough = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 2_000_000_000n }] });
  const plan = fx.createWithSwap();
  const review = await reviewOf(enough.client, 'create', plan);
  assert.deepEqual(review.steps.map((step) => step.kind), ['action']);

  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  const short = await reviewOf(client, 'create', plan);
  assert.deepEqual(short.steps.map((step) => step.kind), ['approve', 'action']);
  chain.setAllowance(fx.USDG, fx.FAKE.zapV4, 1_000_000_000n);
  await assert.rejects(client.prepareStep(short, 0, GAS), /step_not_needed/);
  assert.equal(sendsTo(chain), 0);
  await assert.rejects(client.prepareStep(short, 5, GAS), /step_unknown/);
  await assert.rejects(client.prepareStep({ ...short }, 1, GAS), /review_not_from_this_client/, 'a copy of a review is not a review');
});

test('every plan-check failure surfaces from review, with every reason, and nothing is asked of the wallet but reads', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  const plan = fx.createWithSwap();
  const refusal = async (zapPlan, extra = {}) => {
    try {
      await client.review({ chainId: 4663, plan: { action: 'create', plan: zapPlan }, consent: 'direct', quote: quoteOf(zapPlan), ...extra });
    } catch (error) {
      assert.ok(error instanceof ZapRefusal, String(error));
      assert.equal(error.message, error.failures[0]);
      return error.failures;
    }
    assert.fail('the review should be refused');
  };
  // A tampered route: the legs changed, the signed routesHash did not.
  assert.ok((await refusal({ ...plan, legs: [{ ...plan.legs[0], minAmountOut: 1n }] })).includes('plan_routes_hash'));
  // The wrong fee token: ETH instead of USDG.
  assert.deepEqual(await refusal({ ...plan, intent: { ...plan.intent, feeToken: fx.ZERO } }), ['plan_fee_terms']);
  // A hooked v4 pool, while hookedPoolsAllowed() is false.
  const hooked = fx.sealed({ ...plan, intent: { ...plan.intent, pool: { ...fx.ETH_USDG_V4, hooks: '0x0000000000000000000000000000000000004444' } } }, fx.USDG);
  assert.ok((await refusal(hooked)).includes('plan_pool_hooked'));
  // A plan built for another chain's manifest.
  assert.deepEqual(await refusal(plan, { chainId: 8453 }), ['plan_wrong_chain']);
  // A recipient nobody chose, a deadline past the quote, a failed server simulation.
  assert.ok((await refusal({ ...plan, intent: { ...plan.intent, recipient: fx.OTHER } })).includes('plan_recipient'));
  // Changed on purpose (data) 2026-10-02 (rev2 §2.4 decision #3): a deadline more than 5 minutes after the quote, and a quote past its expiry.
  assert.ok((await refusal(plan, { quote: quoteOf(plan, { requestedAt: fx.NOW - 60 }) })).includes('plan_deadline'));
  assert.ok((await refusal(plan, { quote: quoteOf(plan, { expiresAt: fx.NOW }) })).includes('plan_quote_expired'));
  assert.ok((await refusal(plan, { quote: quoteOf(plan, { simulation: { ok: false, block: 1n, error: 'SwapEffectMismatch' } }) })).includes('plan_simulation'));
  // A plan whose fields are not typed as the contract's are refused before any check.
  assert.deepEqual(await refusal({ ...plan, intent: { ...plan.intent, minLiquidity: '1000000' } }), ['plan_shape']);
  assert.deepEqual(await refusal({ ...plan, legs: [{ ...plan.legs[0], amountIn: 5e8 }] }), ['plan_shape']);
  await assert.rejects(client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'relayed', quote: quoteOf(plan) }), /relayed_not_offered/);
  assert.deepEqual([sendsTo(chain), chain.signed.length], [0, 0]);
  assert.equal(chain.log.includes('eth_signTypedData_v4'), false);
});

test('the registry is the rank source: a rank that disagrees with the chain profile refuses the plan', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  chain.setRank(fx.USDG, 2);
  await assert.rejects(reviewOf(client, 'create', fx.createWithSwap()), (error) => error.failures.includes('registry_rank_mismatch'));
});

test('a plan within a minute of its deadline is not prepared or sent: re-quote', async () => {
  let clock = fx.NOW;
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1_000_000_000n }] }, { clock: () => clock });
  const plan = fx.createWithSwap();
  const review = await reviewOf(client, 'create', plan);
  const prepared = await client.prepareStep(review, 0, GAS);
  clock = Number(plan.intent.deadline) - MIN_DEADLINE_LEFT_S + 1;
  await assert.rejects(client.prepareStep(review, 0, GAS), /plan_expiring/);
  await assert.rejects(client.send(prepared, true), /plan_expiring|wallet_review_required/);
  assert.equal(sendsTo(chain), 0);
  // A review of a plan already that close is refused too.
  await assert.rejects(reviewOf(client, 'create', plan, { quote: quoteOf(plan) }), (error) => error.failures.includes('plan_expiring'));
});

test('the wallet on Base for a Robinhood plan: wallet_wrong_chain before anything is read or prepared', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  chain.switchTo(8453);
  await assert.rejects(reviewOf(client, 'create', fx.createWithSwap()), /wallet_wrong_chain/);
  // The connector itself reports Base: nothing is asked of the wallet at all (finance/v2/transact.ts).
  assert.deepEqual(chain.log, []);
  assert.deepEqual(chain.offChain, []);
});

test('a wallet that moves to another chain between review and send is caught right before the send, and its nonce claim released', async () => {
  const { chain, wallet, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1_000_000_000n }] });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const prepared = await client.prepareStep(review, 0, GAS);
  const claim = wallet.claimNonce;
  wallet.claimNonce = async (...args) => {
    const token = await claim(...args);
    chain.switchTo(8453);
    return token;
  };
  await assert.rejects(client.send(prepared, true), /wallet_wrong_chain/);
  assert.deepEqual(wallet.claims, [['claim', 4663, 0n], ['release', 4663, 0n]]);
  assert.equal(wallet.nonces.size, 0);
  assert.deepEqual([sendsTo(chain), chain.sends.length], [0, 0]);
});

test('the deployment: code that changed or is missing is refused before any write, checked once per session (finance/v2/deployment.ts); the zap must name the profile\'s manager', async () => {
  const changed = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  changed.chain.setCode(fx.FAKE.zapV4, '0x600460d0d1');
  await assert.rejects(reviewOf(changed.client, 'create', fx.createWithSwap()), /deployment_code_changed/);
  const missing = setup();
  missing.chain.setCode(fx.FAKE.registry, '0x');
  await assert.rejects(reviewOf(missing.client, 'create', fx.createWithSwap()), /deployment_missing/);
  const manager = setup();
  manager.chain.setPositionManager(fx.BASE.uniswap.v4.positionManager);
  await assert.rejects(reviewOf(manager.client, 'create', fx.createWithSwap()), /deployment_identity_changed/);
  assert.equal(sendsTo(changed.chain) + sendsTo(missing.chain) + sendsTo(manager.chain), 0);

  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  await reviewOf(client, 'create', fx.createWithSwap());
  await reviewOf(client, 'create', fx.createWithSwap());
  // Another client of the same page session does not read again: the check is per session, chain and component.
  const sibling = fx.honest(createZapClient(walletOf(chain), ROBINHOOD, chain.contracts, () => fx.NOW), chain);
  await reviewOf(sibling, 'create', fx.createWithSwap());
  const codeReads = chain.asked.filter(({ method, params }) => method === 'eth_getCode' && params[0].toLowerCase() === ZAP_V4);
  assert.equal(codeReads.length, 1, 'once per session');
  // A new session checks again, and sees a change.
  forgetV2DeploymentChecks();
  chain.setCode(fx.FAKE.zapV4, '0x600460d0d1');
  const fresh = fx.honest(createZapClient(walletOf(chain), ROBINHOOD, chain.contracts, () => fx.NOW), chain);
  await assert.rejects(reviewOf(fresh, 'create', fx.createWithSwap()), /deployment_code_changed/);
});

test('a contracts set for another chain is refused when the client is made; so is a set with a malformed address', () => {
  const chain = createV2Chain();
  assert.throws(() => createZapClient(walletOf(chain), ROBINHOOD, { ...chain.contracts, chainId: 8453 }, () => fx.NOW), /deployment_wrong_chain/);
  assert.throws(() => createZapClient(walletOf(chain), ROBINHOOD, { ...chain.contracts, addresses: { ...chain.contracts.addresses, zapV4: '0x1234' } }, () => fx.NOW), /deployment_invalid/);
});

test('a revert in simulation is a V2Revert with the contract\'s own selector; nothing is sent and no nonce stays claimed', async () => {
  const { chain, wallet, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1_000_000_000n }] });
  const plan = fx.createWithSwap();
  const review = await reviewOf(client, 'create', plan);
  const prepared = await client.prepareStep(review, 0, GAS);
  // The price moves between the review and the send: the exact transaction is simulated again and refused.
  chain.movePrice();
  await assert.rejects(client.send(prepared, true), (error) => error instanceof V2Revert && error.data.startsWith('0xe49b763d'));
  await assert.rejects(client.prepareStep(review, 0, GAS), (error) => {
    assert.ok(error instanceof V2Revert);
    const decoded = decodeErrorResult({ abi: parseAbi(['error InsufficientLiquidity(uint128 liquidity, uint128 minimum)']), data: error.data });
    assert.deepEqual(decoded.args, [plan.intent.minLiquidity - 1n, plan.intent.minLiquidity]);
    return true;
  });
  assert.equal(REVERTS.insufficientLiquidity(1n, 2n).slice(0, 10), '0xe49b763d', 'the spec\'s selector');
  assert.deepEqual([sendsTo(chain), wallet.claims.length, wallet.nonces.size], [0, 0, 0]);
  assert.equal(wallet.nonceOffered(4663, 0n), false);
});

test('a refusal in the wallet (4001) releases the nonce; the same step is prepared again and sent', async () => {
  const { chain, wallet, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1_000_000_000n }] });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  chain.decline();
  await assert.rejects(client.send(await client.prepareStep(review, 0, GAS), true), (error) => error.code === 4001);
  assert.deepEqual(wallet.claims, [['claim', 4663, 0n], ['release', 4663, 0n]]);
  const receipts = await runAll(client, review);
  assert.equal(receipts[0].state, 'finalized');
  assert.equal(chain.sends.length, 1);
});

test('a transaction the chain includes with status 0 reads as reverted, with no events', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, allowances: [{ token: fx.USDG, spender: fx.FAKE.zapV4, amount: 1_000_000_000n }] });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  chain.revert();
  const receipt = await client.receipt(await client.send(await client.prepareStep(review, 0, GAS), true));
  assert.equal(receipt.state, 'reverted');
  assert.deepEqual(receipt.logs, []);
});

test('an account whose code refuses plain ETH is not offered an action that pays ETH back to it', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n }, ownerCode: 'delegated', refusesEth: true });
  await assert.rejects(reviewOf(client, 'create', fx.createWithSwap()), (error) => error.failures.includes('native_eth_refused'));
  assert.equal(chain.sends.length, 0);
});

test('Base: the same client on 8453 (USDC is the rank-1 currency), its own manifest, and the L1 data fee of the receipt', async () => {
  const USDC = fx.BASE.chargeCurrencies.find((currency) => currency.rank === 1).address;
  const ETH_USDC_V4 = { dex: 4, currency0: fx.ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: fx.ZERO };
  const legs = [{ kind: 3, router: fx.ZERO, tokenIn: USDC, tokenOut: fx.ZERO, amountIn: 500_000_000n, minAmountOut: 190_000_000_000_000_000n, data: fx.v4Path(ETH_USDC_V4) }];
  const plan = fx.sealed({ intent: fx.intent({ pool: ETH_USDC_V4, tickLower: -201060, tickUpper: -198060 }), inputs: [{ token: USDC, amount: 1_000_000_000n }], legs, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, initSqrtPriceX96: 0n }, USDC);
  const { chain, client } = setup({ chainId: 8453, balances: { [USDC]: 5_000_000_000n } });
  assert.equal(chain.contracts.chainId, 8453);
  await assert.rejects(reviewOf(client, 'create', plan), /plan_wrong_chain/, 'a plan named for Robinhood is not for Base');
  const review = await client.review({ chainId: 8453, plan: { action: 'create', plan }, consent: 'direct', quote: quoteOf(plan) });
  assert.deepEqual([review.chainId, review.fee.token, review.fee.amount], [8453, USDC, 3_250_000n]);
  assert.equal(chain.intentHashOf(ZAP_V4, plan.intent), review.intentHash, 'hashed in the domain of Base');
  assert.notEqual(createV2Chain({ chainId: 4663 }).intentHashOf(ZAP_V4, plan.intent), review.intentHash, 'the same intent on Robinhood is another hash');
  const receipts = await runAll(client, review);
  assert.deepEqual(receipts.map((receipt) => [receipt.state, receipt.l1Fee]), [['finalized', 42n], ['finalized', 42n]]);
  assert.ok(chain.sends.every(({ tx }) => tx.chainId === '0x2105'));
});

test('a Universal Router leg: only the profile router 2.1.2, as the registry admits it, shown "as quoted"', async () => {
  const router = fx.ROBINHOOD.uniswap.universalRouter.address;
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, L3): the router's calldata carries its own deadline.
  const leg = { kind: 1, router, tokenIn: fx.USDG, tokenOut: fx.ZERO, amountIn: 500_000_000n, minAmountOut: 190_000_000_000_000_000n, data: fx.urExecute(BigInt(fx.NOW + 300)) };
  const plan = fx.sealed({ ...fx.createWithSwap(), legs: [leg] }, fx.USDG);
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  const review = await reviewOf(client, 'create', plan);
  assert.equal(review.legs[0].asQuoted, true);
  assert.ok(chain.asked.some(({ method, params }) => method === 'eth_call' && params[0].to === fx.FAKE.registry && params[0].data.startsWith('0x39827635')), 'routerVersion read');
  const receipts = await runAll(client, review);
  assert.equal(eventsOf(receipts.at(-1)).find((event) => event.eventName === 'SwapLegExecuted').args.venue.toLowerCase(), router);

  const demoted = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  demoted.chain.setRouterVersion(router, 211);
  await assert.rejects(reviewOf(demoted.client, 'create', plan), (error) => error.failures.includes('plan_leg_router_not_admitted'));
});

test('a wallet node that fails now and then: the review fails with it, nothing is sent, and the next review answers', async () => {
  const { chain, client } = setup({ balances: { [fx.USDG]: 5_000_000_000n } });
  chain.failNext('eth_getBlockByNumber');
  await assert.rejects(reviewOf(client, 'create', fx.createWithSwap()), (error) => error.code === -32603);
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
  assert.equal(chain.sends.length, 0);
});
