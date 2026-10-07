import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { quoteFor } from '../support/crosschain-quotes.mjs';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/funds/fundingIntent.js');
const OWNER = `0x${'11'.repeat(20)}`;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const USDC = { 8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' };
const holding = (chainId, amount) => ({ chainId, chainName: String(chainId), token: USDC[chainId], symbol: 'USDC', decimals: 6, raw: BigInt(amount) * 1_000_000n });
const request = (h, amount, max = null) => ({ originChainId: h.chainId, originToken: h.token, destinationChainId: 4663, destinationToken: USDG,
  amountKind: max === null ? 'exact_input' : 'output', amountRaw: String(amount), maxInputRaw: max === null ? null : String(max), slippageBps: 50, destinationGas: false });
const quote = async (request) => ({ quote: quoteFor(request, OWNER).quote, timing: { sentMono: 0, receivedMono: 1 } });
const plan = (holdings, required = 60_000_000n) => model.planFunding({ destinationChainId: 4663, destinationToken: USDG, required, holdings, destinationGas: false, quote, cancelled: () => false });
const freeze = (legs) => model.freezeFunding({ id: 'test', owner: OWNER, destinationChainId: 4663, destinationToken: USDG, scope: 'pool:range:60', requiredRaw: '60000000', createdAt: 1 }, legs);

test('20 + 50 can fund 60 net, using two separate origins and only the missing portion of the last', async () => {
  const legs = await plan([holding(8453, 20), holding(42161, 50)]);
  assert.equal(legs.length, 2);
  assert.deepEqual(new Set(legs.map((leg) => leg.holding.chainId)), new Set([8453, 42161]));
  assert.ok(legs.reduce((n, leg) => n + model.winningMinimum(leg.quote), 0n) >= 60_000_000n);
  const intent = freeze(legs);
  assert.ok(BigInt(intent.legs.find((leg) => leg.originChainId === 8453).maxInputRaw) < 20_000_000n, 'only the remainder is brought');
});

test('a quoted single origin is preferred over splitting the same need', async () => {
  const legs = await plan([holding(8453, 20), holding(42161, 100)]);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].holding.chainId, 42161);
  assert.ok(BigInt(freeze(legs).legs[0].maxInputRaw) < 100_000_000n);
});

test('70 gross cannot promise 70 net after provider costs', async () => {
  assert.equal(await plan([holding(8453, 20), holding(42161, 50)], 70_000_000n), null);
});

test('accepted refreshes preserve the actual reviewed debit and minimum net output', async () => {
  const legs = await plan([holding(42161, 100)]);
  const intent = freeze(legs), leg = intent.legs[0];
  const wanted = model.requestForLeg(intent, leg);
  assert.equal(wanted.maxInputRaw, leg.maxInputRaw);
  assert.notEqual(wanted.maxInputRaw, '100000000');
  assert.ok(model.respectsLeg(intent, leg, legs[0].quote));
  const bigger = structuredClone(legs[0].quote);
  bigger.candidates.find((c) => c.provider === bigger.decision).inputRaw = String(BigInt(leg.maxInputRaw) + 1n);
  assert.equal(model.respectsLeg(intent, leg, bigger), false);
  const less = structuredClone(legs[0].quote);
  less.candidates.find((c) => c.provider === less.decision).minimumOutputRaw = String(BigInt(leg.minimumOutputRaw) - 1n);
  assert.equal(model.respectsLeg(intent, leg, less), false);
  const wrong = structuredClone(legs[0].quote);
  wrong.request.destinationToken = USDC[8453];
  assert.equal(model.respectsLeg(intent, leg, wrong), false);
});

test('reload preserves partial success, treats a wallet request as unknown and never resends either', async () => {
  const intent = freeze(await plan([holding(8453, 20), holding(42161, 50)]));
  intent.legs[0].state = 'sent'; intent.legs[0].depositTxHash = `0x${'aa'.repeat(32)}`;
  intent.legs[1].state = 'sending';
  const restored = model.parseFunding(JSON.stringify(intent), OWNER, 4663);
  assert.equal(restored.legs[1].state, 'unknown');
  assert.deepEqual(model.outstandingLegs(restored), []);
  const totals = model.fundingTotals(restored);
  assert.ok(totals.sent > 0n && totals.unknown > 0n);
  assert.equal(totals.remaining, 0n, 'inflight reservations are not another deficit');
});

test('persisted hints are bounded, owner-scoped, and strip unknown signing data', async () => {
  const intent = freeze(await plan([holding(42161, 100)]));
  assert.equal(model.parseFunding(JSON.stringify(intent), `0x${'22'.repeat(20)}`, 4663), null);
  assert.equal(model.parseFunding(JSON.stringify(intent), OWNER, 8453), null);
  assert.equal(model.parseFunding(JSON.stringify({ ...intent, legs: [...intent.legs, ...intent.legs] }), OWNER, 4663), null);
  const extra = { ...intent, quote: { calldata: 'secret' }, legs: intent.legs.map((leg) => ({ ...leg, signature: 'secret' })) };
  const restored = model.parseFunding(JSON.stringify(extra), OWNER, 4663);
  assert.equal(JSON.stringify(restored).includes('secret'), false);
});

test('cancelled preparation cannot produce a transfer proposal', async () => {
  await assert.rejects(model.planFunding({ destinationChainId: 4663, destinationToken: USDG, required: 1n, holdings: [holding(8453, 20)], destinationGas: false, quote, cancelled: () => true }), /funding_cancelled/);
});

test('different destination assets cannot be summed as coverage', async () => {
  const a = { holding: holding(8453, 20), ...await quote(request(holding(8453, 20), 20_000_000n)) };
  const b = { holding: holding(42161, 50), ...await quote(request(holding(42161, 50), 50_000_000n)) };
  b.quote.request.destinationToken = USDC[8453];
  assert.throws(() => model.chooseContributions([a, b], 60_000_000n), /funding_destination_mismatch/);
});

test('aggregate destination gas is paid once without adding it on top of a source already at its maximum', async () => {
  const legs = await model.planFunding({ destinationChainId: 4663, destinationToken: USDG, required: 60_000_000n,
    holdings: [holding(8453, 20), holding(42161, 50)], destinationGas: true,
    quote: async (request) => ({ quote: quoteFor(request, OWNER, request.destinationGas ? 'variants/quote.destination-gas' : 'responses/quote').quote, timing: { sentMono: 0, receivedMono: 1 } }),
    cancelled: () => false,
  });
  assert.equal(legs.length, 2);
  assert.equal(legs.filter((leg) => leg.quote.request.destinationGas).length, 1);
  assert.ok(legs.reduce((sum, leg) => sum + model.winningMinimum(leg.quote), 0n) >= 60_000_000n);
});

const ZERO = '0x0000000000000000000000000000000000000000';
const E18 = 10n ** 18n;
const native = (raw) => ({ chainId: 1, chainName: 'Ethereum', token: ZERO, symbol: 'ETH', decimals: 18, raw });
const retryQuote = async (request) => ({ quote: quoteFor(request, OWNER, 'responses/quote', request.originToken === ZERO ? { rate: { num: 4_000_000_000n, den: E18 }, relayOnly: true } : {}).quote, timing: { sentMono: 0, receivedMono: 1 } });
const ethereumIntent = (amount = '40000000', cap = '9000000000000000') => ({ version: 1, id: 'ethereum-gas', owner: OWNER, destinationChainId: 4663, destinationToken: USDG,
  scope: 'unchanged-original-input', requiredRaw: amount, createdAt: 1,
  legs: [{ id: 'ethereum-native', originChainId: 1, originToken: ZERO, symbol: 'ETH', decimals: 18, maxInputRaw: cap, minimumOutputRaw: amount, destinationGas: false, state: 'stopped', depositTxHash: null }],
});

test('only confirmed unsent Ethereum gas failures permit the higher-reserve review', () => {
  const original = ethereumIntent();
  const failed = model.withGasFailure(original, 'ethereum-native', 'native_balance_insufficient', false);
  assert.deepEqual(failed.gasRecovery, { mode: 'native', reviewNeeded: true });
  assert.equal(model.withGasFailure(original, 'ethereum-native', 'wallet_error', false), null);
  assert.equal(model.withGasFailure(original, 'ethereum-native', 'native_balance_insufficient', true), null);
  for (const state of ['sent', 'settled', 'unknown', 'sending']) {
    assert.equal(model.withGasFailure({ ...original, legs: [{ ...original.legs[0], state }] }, 'ethereum-native', 'funding_gas_short', false), null);
  }
  assert.equal(original.gasRecovery, undefined, 'classifying never changes accepted evidence');
});

test('gas recovery combines only unsent sources, keeps 0.006 ETH, and retains both the target and prior debit caps', async () => {
  const original = model.withGasFailure(ethereumIntent(), 'ethereum-native', 'native_balance_insufficient', false);
  const calls = [];
  const revised = await model.planGasRecovery(original, [native(12_000_000_000_000_000n), holding(42161, 20)], async (request) => { calls.push(request); return retryQuote(request); }, () => false, 'review-1');
  assert.ok(revised);
  assert.equal(revised.intent.legs.length, 2);
  const eth = revised.intent.legs.find((leg) => leg.originChainId === 1);
  assert.equal(eth.reserveRaw, '6000000000000000');
  assert.ok(BigInt(eth.maxInputRaw) <= 6_000_000_000_000_000n);
  assert.equal(revised.intent.requiredRaw, original.requiredRaw);
  assert.equal(revised.intent.scope, original.scope);
  assert.equal(original.gasRecovery.reviewNeeded, true, 'a proposal never accepts itself');
  assert.equal(revised.recoveryFrom, model.gasRecoveryKey(original));
  assert.ok(calls.filter((call) => call.originChainId === 1).every((call) => BigInt(call.maxInputRaw ?? call.amountRaw) <= 6_000_000_000_000_000n));
  assert.ok(revised.intent.legs.reduce((sum, leg) => sum + BigInt(leg.minimumOutputRaw), 0n) >= 40_000_000n);
});

test('a sent contribution is retained verbatim, never requoted, while only the outstanding amount is recovered', async () => {
  const original = model.withGasFailure(ethereumIntent('30000000', '10000000000000000'), 'ethereum-native', 'native_balance_insufficient', false);
  const sent = { ...original.legs[0], id: 'already-sent', originChainId: 8453, originToken: USDC[8453], symbol: 'USDC', decimals: 6, maxInputRaw: '20000000', minimumOutputRaw: '19000000', state: 'sent', depositTxHash: `0x${'cc'.repeat(32)}` };
  original.requiredRaw = '49000000'; original.legs.unshift(sent);
  const requests = [];
  const revised = await model.planGasRecovery(original, [holding(8453, 100), native(20_000_000_000_000_000n)], async (request) => { requests.push(request); return retryQuote(request); }, () => false, 'review-2');
  assert.ok(revised);
  assert.deepEqual(revised.intent.legs[0], sent);
  assert.ok(requests.every((request) => request.originChainId !== 8453));
  assert.equal(requests[0].amountRaw, '30000000');
  assert.equal(requests[0].maxInputRaw, '10000000000000000', 'more wallet balance does not enlarge the reviewed debit');
  assert.equal(revised.intent.requiredRaw, '49000000');
  assert.equal(await model.planGasRecovery({ ...original, legs: [{ ...sent, state: 'unknown' }, original.legs[1]] }, [native(E18)], retryQuote, () => false, 'review-3'), null);
});

test('reducing ERC20 cannot release Ethereum gas: offer another origin or no proposal', async () => {
  const original = ethereumIntent('30000000');
  Object.assign(original.legs[0], { originToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, maxInputRaw: '31000000' });
  const failed = model.withGasFailure(original, 'ethereum-native', 'native_balance_insufficient', false);
  const requests = [];
  const revised = await model.planGasRecovery(failed, [native(E18), holding(42161, 40)], async (request) => { requests.push(request); return retryQuote(request); }, () => false, 'review-4');
  assert.ok(revised);
  assert.ok(requests.every((request) => request.originChainId !== 1));
  assert.equal(await model.planGasRecovery(failed, [native(E18)], retryQuote, () => false, 'review-5'), null);
  assert.equal(failed.legs[0].maxInputRaw, '31000000');
});

test('gas recovery metadata survives reload while invalid reservations fail closed', async () => {
  const failed = model.withGasFailure(ethereumIntent('30000000', '10000000000000000'), 'ethereum-native', 'native_balance_insufficient', false);
  const revised = await model.planGasRecovery(failed, [native(20_000_000_000_000_000n)], retryQuote, () => false, 'review-6');
  const restored = model.parseFunding(JSON.stringify(revised.intent), OWNER, 4663);
  assert.equal(restored.legs[0].reserveRaw, '6000000000000000');
  assert.equal(model.fundingSpendable(native(10_000_000_000_000_000n), restored.legs[0]), 4_000_000_000_000_000n);
  restored.legs[0].reserveRaw = '1';
  assert.equal(model.parseFunding(JSON.stringify(restored), OWNER, 4663), null);
});
