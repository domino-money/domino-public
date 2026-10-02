// Producer fixtures pass; altered plans that would change what the owner signs, pays or receives fail.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as runtime from './runtime.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
// The goldens keep wide integers as JSON numbers; read them as strings, exactly.
const goldens = JSON.parse(readFileSync(new URL('../v2/eip712-goldens.json', import.meta.url), 'utf8')
  .replace(/(:\s*)(\d{16,})(?=\s*[,}\]])/gu, '$1"$2"'));
const request = read('./fixtures/requests/plan.json');
const response = read('./fixtures/responses/plan.json');
const variants = readdirSync(new URL('./fixtures/variants/', import.meta.url)).map((name) => [name, read(`./fixtures/variants/${name}`)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const OTHER = '0x' + '9'.repeat(40);
const utf8 = (text) => new TextEncoder().encode(text);

test('keccak-256 and the EIP-712 goldens', () => {
  assert.equal(runtime.keccakHex(new Uint8Array()), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(runtime.keccakHex(utf8('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(runtime.keccakHex(new Uint8Array(200).fill(7)).length, 66);
  assert.equal(runtime.routesHash([]), '0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd');
  const legs = goldens.fixtures.SwapLeg.map((leg) => ({ ...leg, amountIn: String(leg.amountIn), minAmountOut: String(leg.minAmountOut) }));
  assert.equal(runtime.routesHash(legs), goldens.routesHash);
  const stringify = (intent) => ({ ...intent, tokenId: String(intent.tokenId), minLiquidity: String(intent.minLiquidity),
    nonce: String(intent.nonce), deadline: String(intent.deadline) });
  const intent = stringify(goldens.fixtures.PositionIntent);
  const domain = goldens.domain;
  assert.equal(runtime.intentHash(domain.chainId, domain.verifyingContract, intent), goldens.digests.PositionIntent);
  const permit = goldens.fixtures.Permit2;
  const permitted = permit.permitted.map((p) => ({ token: p.token, amount: String(p.amount) }));
  assert.equal(runtime.permit2Digest(domain.chainId, permit.spender, { permitted, nonce: String(permit.nonce),
    deadline: String(permit.deadline) }, intent), goldens.digests.Permit2BatchWitness);
  const relayed = goldens.fixtures.RelayedPositionAction;
  assert.equal(runtime.relayedDigest(domain.chainId, domain.verifyingContract, {
    ...Object.fromEntries(Object.entries(relayed).filter(([k]) => !['intent', 'burn'].includes(k)).map(([k, v]) => [k, String(v)])),
    intent: stringify(relayed.intent), burn: relayed.burn }), goldens.digests.RelayedPositionAction);
});

test('the fee rule is F1b\'s table', () => {
  const [USDG, MANY, TSLA, WETH, NVDA, ETH] = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20),
    '0x' + '44'.repeat(20), '0x' + '55'.repeat(20), '0x' + '0'.repeat(40)];
  const ranks = { [USDG]: 1, [ETH]: 2, [WETH]: 2 };
  const rank = (t) => ranks[t] || 0;
  const legs = (...pairs) => pairs.map(([tokenIn, tokenOut]) => ({ tokenIn, tokenOut, amountIn: '100' }));
  const table = [
    [legs([USDG, MANY]), [USDG, 'input']], [legs([MANY, USDG]), [USDG, 'output']],
    [legs([TSLA, USDG], [USDG, MANY]), [USDG, 'hop']], [legs([TSLA, MANY]), [TSLA, 'fallback']],
    [legs([WETH, USDG]), [USDG, 'output']], [legs([ETH, MANY]), [ETH, 'input']], [legs([ETH, WETH]), [ETH, 'input']],
    [legs([TSLA, WETH], [WETH, MANY], [NVDA, ETH]), [ETH, 'output']],
    [legs([TSLA, WETH], [WETH, MANY], [NVDA, ETH], [ETH, MANY]), [WETH, 'hop']],
  ];
  for (const [route, expected] of table) assert.deepEqual(runtime.feeToken(route, rank), expected);
  assert.equal(runtime.swappedAmount([{ tokenIn: TSLA, tokenOut: USDG, amountIn: '100' }, { tokenIn: USDG, tokenOut: MANY, amountIn: '1' }],
    ['1000', '5'], USDG), 1000n);
});

test('producer fixtures, variants and errors validate', () => {
  assert(runtime.validateRequest('plan', request));
  assert(runtime.validateResponse('plan', response));
  assert(variants.length >= 6);
  for (const [name, body] of variants) assert(runtime.validateResponse('plan', body), name);
  for (const [code, { status, body }] of Object.entries(read('./fixtures/errors.json'))) assert(runtime.validateError(status, body), code);
  assert.equal(runtime.revertName('0x374aa3d7'), 'SwapEffectMismatch()');
});

test('requests never name an owner or a recipient and keep each action\'s fields', () => {
  for (const field of ['owner', 'recipient', 'feeToken', 'zap']) assert(!runtime.validateRequest('plan', { ...request, [field]: OTHER }), field);
  assert(!runtime.validateRequest('plan', { ...request, slippageBps: 501 }));
  assert(!runtime.validateRequest('plan', { ...request, slippageBps: 9 }));
  assert(!runtime.validateRequest('plan', { ...request, consent: 'relayed' }));
  assert(!runtime.validateRequest('plan', { ...request, action: 'exit' }));
  assert(!runtime.validateRequest('plan', { ...request, chainId: 1 }));
  assert(!runtime.validateRequest('plan', { ...request, inputs: [] }));
  assert(!runtime.validateRequest('plan', { ...request, position: { dex: 4, tokenId: '1' } }));
});

test('a plan cannot change what the owner signs, pays or receives', () => {
  const mutate = (change) => { const value = clone(response); change(value.plan); return runtime.validateResponse('plan', value); };
  const p = (plan) => plan.zapPlan;
  assert(!mutate((d) => { p(d).intent.recipient = OTHER; }));
  assert(!mutate((d) => { p(d).intent.feeToken = p(d).legs[0].tokenOut; }));
  assert(!mutate((d) => { p(d).intent.feeBps = 64; }));
  assert(!mutate((d) => { p(d).intent.minLiquidity = String(BigInt(p(d).intent.minLiquidity) - 1n); }));
  assert(!mutate((d) => { p(d).legs[0].minAmountOut = '1'; d.legs[0].minAmountOutRaw = '1'; }));
  assert(!mutate((d) => { p(d).legs[0].amountIn = String(BigInt(p(d).legs[0].amountIn) + 1n); }));
  assert(!mutate((d) => { p(d).intent.deadline = String(Number(p(d).intent.deadline) + 3600); }));
  assert(!mutate((d) => { d.expiresAt += 60; }));
  assert(!mutate((d) => { d.signature.permit.nonce = '1'; }));
  assert(!mutate((d) => { d.signature.typedData.message.spender = OTHER; }));
  assert(!mutate((d) => { d.signature.typedData.message.witness.minLiquidity = '1'; }));
  assert(!mutate((d) => { d.signature.digest = '0x' + '00'.repeat(32); }));
  assert(!mutate((d) => { d.intentHash = '0x' + '11'.repeat(32); }));
  assert(!mutate((d) => { d.call.selector = '0x0e97b041'; }));
  assert(!mutate((d) => { d.fee.ranks[0].rank = 0; }));
  assert(!mutate((d) => { d.fee.amountRaw = '0'; }));
  assert(!mutate((d) => { d.readiness.account.kind = 'eip7702'; }));
  assert(!mutate((d) => { d.zapPlan.inputs[0].amount = '1'; }));
});

test('direct plans carry the exact call; relayed plans sign the removal bounds', () => {
  const direct = variants.find(([name]) => name === 'plan.increase-direct.json')[1];
  assert(direct.plan.call.data.startsWith(direct.plan.call.selector));
  assert.equal(direct.plan.call.data, runtime.callData('increase', direct.plan.zapPlan));
  const mutated = clone(direct);
  mutated.plan.call.data = mutated.plan.call.data.slice(0, -2) + 'ff';
  assert(!runtime.validateResponse('plan', mutated));
  const relayed = variants.find(([name]) => name === 'plan.exit-relayed.json')[1];
  assert.equal(relayed.plan.signature.typedData.message.amount0Max, '0');
  const lowered = clone(relayed);
  lowered.plan.zapPlan.amount0MinRemoved = '0';
  assert(!runtime.validateResponse('plan', lowered));
  const native = variants.find(([name]) => name === 'plan.create-native-direct.json')[1];
  assert.equal(native.plan.call.valueRaw, native.plan.zapPlan.inputs[0].amount);
  assert.deepEqual(native.plan.readiness.account.consents, ['direct']);
  const fresh = variants.find(([name]) => name === 'plan.create-new-pool-direct.json')[1];
  assert.equal(fresh.plan.pool.initialized, false);
  assert.notEqual(fresh.plan.zapPlan.initSqrtPriceX96, '0');
});

test('the minimums hold at the worst price within ±s, with the zap\'s exact math (rc.2)', () => {
  // TickMath and the SDK's band, against values the Python side computes.
  assert.equal(runtime.sqrtAtTick(0), 1n << 96n);
  assert.equal(runtime.sqrtAtTick(-198080), 3961339671291671466576572n);  // F7 §2.6.5's tick
  assert.equal(runtime.sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.equal(runtime.sqrtAtTick(-887272), 4295128739n);
  assert.equal(runtime.bandSqrtPrice(1n << 96n, 50, 2), 79425985949584624389260073348n);
  assert.equal(runtime.bandSqrtPrice(1n << 96n, 50, -2), 79029843899059723247256258061n);
  for (const n of [0n, 1n, 15n, 16n, (1n << 207n) + 12345n, (1n << 256n) - 1n]) {
    const r = runtime.isqrt(n);
    assert(r * r <= n && (r + 1n) * (r + 1n) > n);
  }
  // Every fixture's minimums are planMinimums of its own fields.
  for (const [name, body] of [['plan.json', response], ...variants]) {
    const d = body.plan, want = runtime.planMinimums(d);
    assert.equal(d.zapPlan.intent.minLiquidity, String(want.liquidity), name);
    assert.deepEqual(d.minimums.mintBand, want.mintBand, name);
    assert.deepEqual(d.minimums.removalBand, want.removalBand, name);
  }
  // A plan cannot narrow or widen its band, nor change a minimum it implies.
  const mutate = (base, change) => { const value = clone(base); change(value.plan); return runtime.validateResponse('plan', value); };
  assert(!mutate(response, (d) => { d.minimums.mintBand.lowerSqrtPriceX96 = String(BigInt(d.minimums.mintBand.lowerSqrtPriceX96) + 1n); }));
  assert(!mutate(response, (d) => { d.expected.sqrtPriceX96After = String(BigInt(d.expected.sqrtPriceX96After) + (1n << 80n)); }));
  const exit = variants.find(([name]) => name === 'plan.exit-converted-direct.json')[1];
  assert(!mutate(exit, (d) => { d.zapPlan.amount1MinRemoved = String(BigInt(d.zapPlan.amount1MinRemoved) - 1n); d.minimums.amount1RemovedRaw = d.zapPlan.amount1MinRemoved; }));
  assert(!mutate(exit, (d) => { d.minimums.removalBand = null; }));
});

test('the L1 data fee is the chain\'s own source at the plan\'s block', () => {
  assert.equal(response.plan.l1DataFee.source, 'op_gas_price_oracle');
  assert.equal(response.plan.l1DataFee.block, response.plan.block.number);
  const nitro = variants.find(([name]) => name === 'plan.create-robinhood-direct.json')[1];
  const fee = nitro.plan.l1DataFee;
  assert.equal(fee.source, 'nitro_node_interface');
  assert.equal(BigInt(fee.weiRaw), BigInt(fee.l1GasUnits) * BigInt(fee.l2BaseFeeWei));
  const mutate = (base, change) => { const value = clone(base); change(value.plan); return runtime.validateResponse('plan', value); };
  assert(!mutate(response, (d) => { d.l1DataFee.block = '1'; }));
  assert(!mutate(response, (d) => { d.l1DataFee.source = 'nitro_node_interface'; }));
  assert(!mutate(nitro, (d) => { d.l1DataFee.weiRaw = '1'; }));
  assert(mutate(response, (d) => { Object.assign(d.l1DataFee, { status: 'unavailable', weiRaw: null, upperBoundWeiRaw: null, transactionBytes: null }); }));
});
