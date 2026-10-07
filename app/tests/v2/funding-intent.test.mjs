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
