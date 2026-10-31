/**
 * The S1 plan API's app side (src/v2/plan, spec F7 rev2 §2.4, position-plan-v1 1.0.0-rc.2): the request written as the
 * contract takes it; every answer through the package's own `validateResponse` (the package's fixtures and variants
 * pass, §7.5) and then the app's own checks (the manifest's zap and the profile's Permit2 and managers, the request it
 * answers, the session's wallet, check 13's starting price, the quote's life, the simulation the app accepts); the
 * error answers with their codes; the client and the transports.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { planAnswer, planError, v4Path, ZERO } from '../support/s1-plans.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const { planRequestWire, S1_SLIPPAGE_MIN_BPS, S1_SLIPPAGE_MAX_BPS } = require(`${BUILD}v2/plan/request.js`);
const { parsePlanAnswer } = require(`${BUILD}v2/plan/parse.js`);
const { requestS1Plan } = require(`${BUILD}v2/plan/client.js`);
const { createS1PlanFixtureTransport } = require(`${BUILD}v2/plan/fixtureTransport.js`);
const { createHttpS1PlanTransport, createSessionPlanTransport } = require(`${BUILD}v2/plan/httpTransport.js`);
const { initialSqrtPrice, parsePriceText } = require(`${BUILD}v2/plan/initialPrice.js`);
const { smallerUpToPercent, planNetworkCost, conversionSummary } = require(`${BUILD}v2/plan/present.js`);
const { S1_PLAN_CONTRACT_VERSION } = require(`${BUILD}v2/plan/types.js`);

const FIXTURES = new URL('../../../api-contracts/position-plan-v1/fixtures/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const MANAGER = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const show = (result) => JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)).slice(0, 300);

/** The app's request for a fixture's echoed request, as a screen would build it. */
function requestOf(d) {
  const r = d.request;
  const out = { chainId: r.chainId, action: r.action, consent: r.consent, slippageBps: r.slippageBps };
  if (r.pool) out.pool = r.pool;
  if (r.position) out.position = { dex: r.position.dex, tokenId: BigInt(r.position.tokenId) };
  if (r.tickLower !== null) Object.assign(out, { tickLower: r.tickLower, tickUpper: r.tickUpper });
  if (r.inputs) out.inputs = r.inputs.map((x) => ({ token: x.token, amount: BigInt(x.amountRaw) }));
  if (r.liquidityToRemove !== null) out.liquidityToRemove = r.liquidityToRemove === 'all' ? 'all' : BigInt(r.liquidityToRemove);
  if (r.burn !== null) out.burn = r.burn;
  if (r.receive) out.receive = r.receive.mode === 'both' ? 'both' : { convertTo: r.receive.token };
  if (r.initialPrice) {
    const base = r.initialPrice.baseToken.toLowerCase() === r.pool.currency0 ? 'currency0' : 'currency1';
    const exact = initialSqrtPrice({ price: parsePriceText(r.initialPrice.price), base, decimals0: r.initialPrice.decimals0, decimals1: r.initialPrice.decimals1 });
    out.initialPrice = { ...r.initialPrice, sqrtPriceX96: exact.sqrtPriceX96 };
  }
  return out;
}
/** What the app holds a fixture to: its own owner, its zap as the manifest's, the canonical Permit2, the local managers. */
const contextOf = (d, over = {}) => ({ owner: d.owner, zaps: { 3: d.zap, 4: d.zap }, permit2: PERMIT2, managers: { 3: MANAGER, 4: MANAGER }, now: d.requestedAt + 1, ...over });
function parseFixture(body, over = {}, request = requestOf(body.plan)) {
  return parsePlanAnswer({ status: 200, body }, request, planRequestWire(request), contextOf(body.plan, over), runtime);
}

const variants = readdirSync(new URL('variants/', FIXTURES)).map((name) => [name, read(`variants/${name}`)]);

test('the package\'s own answers pass, and the app reads them into the zap client\'s shape (rev2 §7.5)', () => {
  for (const [name, body] of [['responses/plan.json', read('responses/plan.json')], ...variants]) {
    if (body.plan.consent === 'relayed') continue;
    const result = parseFixture(body);
    assert.equal(result.kind, 'ok', `${name}: ${show(result)}`);
    const { plan, quote, facts } = result.reply;
    const d = body.plan;
    assert.equal(plan.action, d.action);
    assert.equal(plan.plan.intent.minLiquidity, BigInt(d.minimums.liquidity), name);
    assert.equal(plan.plan.intent.deadline, BigInt(d.deadline));
    assert.equal(quote.requestedAt, d.requestedAt);
    assert.equal(quote.expiresAt, d.requestedAt + 180, '3-minute quote (decision #3)');
    assert.equal(facts.deadline, BigInt(d.requestedAt + 300), '5-minute deadline (decision #3)');
    assert.deepEqual(quote.ranks, d.fee.ranks.map((r) => ({ token: r.token, rank: r.rank })));
    assert.equal(quote.legs.length, d.legs.length);
    assert.equal(facts.minimums.liquidity, BigInt(d.minimums.liquidity));
    if (d.action === 'changeRange' || d.action === 'exit') {
      assert.deepEqual(quote.expectedRemoved, [BigInt(d.expected.principal0Raw) + BigInt(d.expected.fees0Raw), BigInt(d.expected.principal1Raw) + BigInt(d.expected.fees1Raw)]);
      assert.deepEqual(facts.minimums.removed, [BigInt(d.minimums.amount0RemovedRaw), BigInt(d.minimums.amount1RemovedRaw)]);
    }
  }
});

test('the L1 data fee per stack: Base\'s oracle with its ceiling; Robinhood\'s measured 0; unavailable never 0', () => {
  const base = parseFixture(read('responses/plan.json'));
  assert.deepEqual(base.reply.facts.l1DataFee, { status: 'ok', source: 'op_gas_price_oracle', wei: 10345963635n, upperBoundWei: 43331441130n });
  const robinhood = parseFixture(variants.find(([n]) => n.includes('robinhood'))[1]);
  assert.equal(robinhood.reply.facts.l1DataFee.status, 'ok');
  assert.equal(robinhood.reply.facts.l1DataFee.source, 'nitro_node_interface');
  assert.equal(robinhood.reply.facts.l1DataFee.wei, 0n, 'a measured zero');
  const body = read('responses/plan.json');
  Object.assign(body.plan.l1DataFee, { status: 'unavailable', weiRaw: null, upperBoundWeiRaw: null, transactionBytes: null });
  const result = parseFixture(body);
  assert.equal(result.kind, 'ok', show(result));
  assert.deepEqual(result.reply.facts.l1DataFee, { status: 'unavailable', source: 'op_gas_price_oracle' });
});

test('app check 1: every Domino address is the manifest\'s, Uniswap\'s and Permit2\'s the profile\'s; never the answer\'s', () => {
  const body = read('responses/plan.json');
  const other = '0x' + '9'.repeat(40);
  assert.equal(parseFixture(body, { zaps: { 3: other, 4: other } }).detail, 'zap');
  assert.equal(parseFixture(body, { permit2: other }).detail, 'typed_data_address');
  const increase = variants.find(([n]) => n.includes('increase'))[1];
  assert.equal(parseFixture(increase, { managers: { 3: other, 4: other } }).detail, 'approve_position_step');
  const exit = variants.find(([n]) => n.includes('exit-converted'))[1];
  assert.equal(parseFixture(exit, { managers: { 3: MANAGER, 4: other } }).kind, 'invalid');
});

test('the answer is the request\'s, for the session\'s wallet: another owner, another request or another DEX is invalid', () => {
  const body = read('responses/plan.json');
  assert.equal(parseFixture(body, { owner: '0x' + '1'.repeat(40) }).detail, 'owner');
  const request = { ...requestOf(body.plan), slippageBps: 60 };
  assert.equal(parseFixture(body, {}, request).detail, 'request');
  const swapped = { ...requestOf(body.plan), inputs: [{ token: body.plan.request.inputs[0].token, amount: 1n }] };
  assert.equal(parseFixture(body, {}, swapped).detail, 'request');
  // A plan the package's runtime refuses never reaches the app's checks.
  const tampered = clone(body);
  tampered.plan.zapPlan.legs[0].minAmountOut = '1';
  assert.deepEqual(parseFixture(tampered), { kind: 'invalid', detail: 'contract' });
});

test('check 13: a new pool\'s starting price is the app\'s own exact value; a plan for a priced pool carries none', () => {
  const body = variants.find(([n]) => n.includes('new-pool'))[1];
  const request = requestOf(body.plan);
  assert.equal(parseFixture(body, {}, request).kind, 'ok');
  const off = { ...request, initialPrice: { ...request.initialPrice, sqrtPriceX96: request.initialPrice.sqrtPriceX96 + 1n } };
  assert.equal(parseFixture(body, {}, off).detail, 'initial_price');
  const facts = parseFixture(body, {}, request).reply.facts;
  assert.equal(facts.initialPrice.tick, body.plan.initialPrice.tick);
  assert.equal(facts.pool.initialized, false);
});

test('the quote\'s life: at or after expiresAt the answer is expired (asked again without a word)', () => {
  const body = read('responses/plan.json');
  assert.equal(parseFixture(body, { now: body.plan.expiresAt }).kind, 'expired');
  assert.equal(parseFixture(body, { now: body.plan.expiresAt - 1 }).kind, 'ok');
});

test('the server\'s simulation: ok; not_run only with approvals_missing; reverted said with its error; a low simulated liquidity refused', () => {
  const body = read('responses/plan.json');
  const notRun = (reason) => {
    const b = clone(body);
    b.plan.simulation = { status: 'not_run', reason, method: null, error: null, gasUnits: null, result: null };
    return parseFixture(b);
  };
  assert.equal(notRun('approvals_missing').kind, 'ok', 'the app simulates the exact call itself before the wallet');
  assert.equal(notRun('approvals_missing').reply.facts.gasUnits, null);
  assert.deepEqual(notRun('simulation_disabled'), { kind: 'unsimulated', reason: 'simulation_disabled' });
  assert.deepEqual(notRun('approval_reverted'), { kind: 'unsimulated', reason: 'approval_reverted' });
  const reverted = clone(body);
  reverted.plan.simulation = { status: 'reverted', reason: null, method: 'eth_simulateV1', error: { selector: '0x374aa3d7', name: 'SwapEffectMismatch()' }, gasUnits: null, result: null };
  reverted.plan.warnings = ['simulation_reverted'];
  assert.deepEqual(parseFixture(reverted), { kind: 'reverted', selector: '0x374aa3d7', name: 'SwapEffectMismatch()' });
  const low = clone(body);
  low.plan.warnings = ['simulated_liquidity_below_minimum'];
  assert.deepEqual(parseFixture(low), { kind: 'reverted', selector: '0xe49b763d', name: 'InsufficientLiquidity(uint128,uint128)' });
});

test('error answers: every code of the package, validated, is refused with its code; anything else is unavailable', () => {
  const errors = read('errors.json');
  const answer = read('responses/plan.json');
  const request = requestOf(answer.plan);
  const wire = planRequestWire(request);
  for (const [code, { status, body }] of Object.entries(errors)) {
    const result = parsePlanAnswer({ status, body }, request, wire, contextOf(answer.plan), runtime);
    assert.deepEqual(result, { kind: 'refused', code, status }, code);
  }
  assert.deepEqual(parsePlanAnswer({ status: 404, body: null }, request, wire, contextOf(answer.plan), runtime), { kind: 'unavailable', reason: 'http_404' });
  assert.deepEqual(parsePlanAnswer({ status: 409, body: { error: 'made_up' } }, request, wire, contextOf(answer.plan), runtime), { kind: 'unavailable', reason: 'http_409' });
});

test('the request: exactly the action\'s fields, as the contract takes them; the package\'s validateRequest accepts each', () => {
  const pool = { dex: 4, currency0: ZERO, currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 3000, tickSpacing: 60, hooks: ZERO };
  const create = planRequestWire({ chainId: 4663, action: 'create', consent: 'direct', pool, tickLower: -201060, tickUpper: -198060, inputs: [{ token: pool.currency1, amount: 1_000_000_000n }], slippageBps: 50 });
  assert.deepEqual(Object.keys(create), ['chainId', 'action', 'consent', 'pool', 'tickLower', 'tickUpper', 'inputs', 'slippageBps']);
  assert.deepEqual(create.inputs, [{ token: pool.currency1, amountRaw: '1000000000' }]);
  const exit = planRequestWire({ chainId: 8453, action: 'exit', consent: 'direct', position: { dex: 4, tokenId: 7n }, liquidityToRemove: 'all', burn: true, receive: { convertTo: pool.currency1 }, slippageBps: 50 });
  assert.deepEqual(exit, { chainId: 8453, action: 'exit', consent: 'direct', position: { dex: 4, tokenId: '7' }, liquidityToRemove: 'all', burn: true, receive: { mode: 'converted', token: pool.currency1 }, slippageBps: 50 });
  const collect = planRequestWire({ chainId: 8453, action: 'exit', consent: 'direct', position: { dex: 3, tokenId: 9n }, liquidityToRemove: 0n, burn: false, receive: 'both', slippageBps: 10 });
  assert.equal(collect.liquidityToRemove, '0');
  assert.deepEqual(collect.receive, { mode: 'both' });
  const change = planRequestWire({ chainId: 42161, action: 'changeRange', consent: 'direct', position: { dex: 3, tokenId: 9n }, tickLower: -60, tickUpper: 60, liquidityToRemove: 5n, burn: false, slippageBps: 500 });
  const increase = planRequestWire({ chainId: 4663, action: 'increase', consent: 'permit2', position: { dex: 4, tokenId: 3n }, inputs: [{ token: pool.currency1, amount: 5n }], slippageBps: 50 });
  const fresh = planRequestWire({ chainId: 4663, action: 'create', consent: 'direct', pool, tickLower: -201060, tickUpper: -198060, inputs: [{ token: pool.currency1, amount: 1n }], slippageBps: 50, initialPrice: { price: '2500', baseToken: ZERO, decimals0: 18, decimals1: 6, sqrtPriceX96: 3961408125713216879677197n } });
  assert.deepEqual(fresh.initialPrice, { price: '2500', baseToken: ZERO, decimals0: 18, decimals1: 6 }, 'the app\'s own value is never sent');
  for (const wire of [create, exit, collect, change, increase, fresh]) assert.ok(runtime.validateRequest('plan', wire), JSON.stringify(wire));
});

test('the request refuses what the app would never send', () => {
  const pool = { dex: 4, currency0: ZERO, currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 3000, tickSpacing: 60, hooks: ZERO };
  const base = { chainId: 4663, action: 'create', consent: 'direct', pool, tickLower: -201060, tickUpper: -198060, inputs: [{ token: pool.currency1, amount: 1n }], slippageBps: 50 };
  const refused = (over, code) => assert.throws(() => planRequestWire({ ...base, ...over }), new RegExp(code));
  refused({ slippageBps: S1_SLIPPAGE_MIN_BPS - 1 }, 'plan_request_slippage');
  refused({ slippageBps: S1_SLIPPAGE_MAX_BPS + 1 }, 'plan_request_slippage');
  refused({ consent: 'relayed' }, 'plan_request_consent');
  refused({ pool: { ...pool, hooks: '0x' + '4'.repeat(40) } }, 'plan_request_pool_hooked');
  refused({ pool: { ...pool, currency0: pool.currency1, currency1: ZERO } }, 'plan_request_pool');
  refused({ tickLower: -201061 }, 'plan_request_range');
  refused({ inputs: [{ token: ZERO, amount: 1n }], consent: 'permit2' }, 'plan_request_permit2_native');
  refused({ inputs: [{ token: ZERO, amount: 1n }, { token: pool.currency1, amount: 1n }, { token: '0x' + '7'.repeat(40), amount: 1n }] }, 'plan_request_inputs');
  refused({ initialPrice: { price: '0', baseToken: ZERO, decimals0: 18, decimals1: 6, sqrtPriceX96: 1n } }, 'plan_request_initial_price');
  const exit = { chainId: 4663, action: 'exit', consent: 'direct', position: { dex: 4, tokenId: 7n }, liquidityToRemove: 5n, burn: true, receive: 'both', slippageBps: 50 };
  assert.throws(() => planRequestWire(exit), /plan_request_burn/, 'a burn needs everything');
  assert.throws(() => planRequestWire({ ...exit, burn: false, consent: 'permit2' }), /plan_request_consent/);
  assert.throws(() => planRequestWire({ ...exit, burn: false, receive: undefined }), /plan_request_receive/);
  assert.throws(() => planRequestWire({ ...exit, burn: false, position: { dex: 4, tokenId: 0n } }), /plan_request_position/);
});

test('a planner built with the package\'s runtime (the browser suites\' own) passes its validator and the app\'s checks', () => {
  const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const ZAP = '0x' + 'd4'.repeat(20);
  const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const request = { chainId: 4663, action: 'create', consent: 'direct', pool, tickLower: -201060, tickUpper: -198060, inputs: [{ token: USDG, amount: 1_000_000_000n }], slippageBps: 50 };
  const wire = planRequestWire(request);
  const now = 1_790_870_000;
  const body = planAnswer(wire, { owner: OWNER, zap: ZAP, now, pool: { sqrtPriceX96: 3961408125713216879677197n, tick: -198080 }, legs: [{ tokenIn: USDG, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 199_000_000_000_000_000n, data: v4Path(pool) }], expected: { amounts: [199_000_000_000_000_000n, 496_750_000n] } });
  assert.ok(runtime.validateResponse('plan', body));
  const result = parsePlanAnswer({ status: 200, body }, request, wire, { owner: OWNER, zaps: { 3: ZAP, 4: ZAP }, permit2: PERMIT2, managers: { 3: MANAGER, 4: MANAGER }, now: now + 1 }, runtime);
  assert.equal(result.kind, 'ok', show(result));
  assert.equal(result.reply.facts.fee.token, USDG, 'USDG is the input and the best rank');
  assert.equal(result.reply.facts.fee.amount, 3_250_000n, '§2.8 example 1: 3.25 USDG on 500 USDG');
});

test('the client: a request the app would never send is invalid and never sent; a transport failure is unavailable; consent and version', async () => {
  const body = read('responses/plan.json');
  const request = requestOf(body.plan);
  const transport = createS1PlanFixtureTransport();
  const ctx = (d) => ({ owner: d.owner, zaps: { 3: d.zap, 4: d.zap }, permit2: PERMIT2, managers: { 3: MANAGER, 4: MANAGER } });
  assert.deepEqual(await requestS1Plan(transport, runtime, { ...request, slippageBps: 0 }, ctx(body.plan)), { kind: 'invalid', detail: 'plan_request_slippage' });
  assert.equal(transport.calls().length, 0, 'never sent');
  assert.deepEqual(await requestS1Plan(transport, runtime, request, ctx(body.plan), () => body.plan.requestedAt), { kind: 'unavailable', reason: 'network' });
  transport.script(() => body);
  const ok = await requestS1Plan(transport, runtime, request, ctx(body.plan), () => body.plan.requestedAt + 1);
  assert.equal(ok.kind, 'ok', show(ok));
  transport.script(() => planError('position_plan_consent_unsupported'));
  assert.deepEqual(await requestS1Plan(transport, runtime, request, ctx(body.plan)), { kind: 'refused', code: 'position_plan_consent_unsupported', status: 422 });
  assert.equal(S1_PLAN_CONTRACT_VERSION, runtime.CONTRACT_VERSION);
  assert.deepEqual(await requestS1Plan(transport, { ...runtime, CONTRACT_VERSION: '1.0.0-rc.1' }, request, ctx(body.plan)), { kind: 'invalid', detail: 'contract_version' });
});

test('the http transport (unwired): the route, the contract header and CSRF; a reply without the contract header has no body', async () => {
  const seen = [];
  const reply = (status, header, text) => ({ kind: 'reply', reply: { status, opaqueRedirect: false, contentType: 'application/json', contractHeader: header, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text } } });
  let next = reply(200, '1.0.0-rc.2', '{"error":"preview_expired"}');
  const transport = createHttpS1PlanTransport({ post: async (url, init, options) => { seen.push({ url, init, options }); return next; }, csrf: () => 'token-1' });
  assert.deepEqual(await transport.plan({ chainId: 4663 }), { status: 200, body: { error: 'preview_expired' } });
  assert.equal(seen[0].url, '/api/position-plan/v1/plan');
  assert.equal(seen[0].init.headers['X-Domino-Position-Plan-Contract'], '1.0.0-rc.2');
  assert.equal(seen[0].init.headers['X-Domino-CSRF'], 'token-1');
  assert.equal(seen[0].options.timeoutMs, 22_000);
  next = reply(401, null, '{"error":"beta_access_required"}');
  assert.deepEqual(await transport.plan({ chainId: 4663 }), { status: 401, body: null });
  next = { kind: 'timeout' };
  await assert.rejects(transport.plan({ chainId: 4663 }), /timeout/);
  const noSession = createHttpS1PlanTransport({ post: async () => next, csrf: () => null });
  await assert.rejects(noSession.plan({ chainId: 4663 }), /session_required/);
});

test('a quote nobody waits for any more stops: the caller\'s abort reaches the POST, and the page\'s deadline is said as timeout (2026-10-30, INST-2)', async () => {
  const body = read('responses/plan.json');
  const request = requestOf(body.plan);
  const ctx = { owner: body.plan.owner, zaps: { 3: body.plan.zap, 4: body.plan.zap }, permit2: PERMIT2, managers: { 3: MANAGER, 4: MANAGER } };
  const seen = [];
  let next = { kind: 'timeout' };
  const transport = createHttpS1PlanTransport({ post: async (url, init, options) => { seen.push(options); return next; }, csrf: () => 'token-1' });
  const controller = new AbortController();
  assert.deepEqual(await requestS1Plan(transport, runtime, request, ctx, undefined, controller.signal), { kind: 'unavailable', reason: 'timeout' }, 'the page\'s own deadline');
  assert.equal(seen[0].signal, controller.signal, 'the abort is handed to the POST');
  next = { kind: 'network' };
  assert.deepEqual(await requestS1Plan(transport, runtime, request, ctx), { kind: 'unavailable', reason: 'network' });
  assert.equal(seen[1].signal, undefined, 'no abort, none handed on');
  next = { kind: 'aborted' };
  controller.abort();
  const sent = seen.length;
  assert.deepEqual(await requestS1Plan(transport, runtime, request, ctx, undefined, controller.signal), { kind: 'unavailable', reason: 'aborted' });
  assert.equal(seen.length, sent, 'an aborted quote sends nothing');
  const late = new AbortController();
  const stopping = createHttpS1PlanTransport({ post: async () => { late.abort(); return { kind: 'aborted' }; }, csrf: () => 'token-1' });
  assert.deepEqual(await requestS1Plan(stopping, runtime, request, ctx, undefined, late.signal), { kind: 'unavailable', reason: 'aborted' }, 'stopped on the way');
  const session = createSessionPlanTransport({ post: async (url, init, options) => { seen.push(options); return { kind: 'timeout' }; }, session: { csrfAccess: true, epoch: () => 1, withCsrf: async (epoch, fn) => ({ ok: true, value: await fn('token-2') }) } });
  const lent = new AbortController();
  await assert.rejects(session.plan({ chainId: 4663 }, lent.signal), /timeout/);
  assert.equal(seen.at(-1).signal, lent.signal, 'through the session\'s transport too');
});

test('the review\'s figures: how much smaller the position may come out, the network cost per stack, a converted exit\'s rest', () => {
  assert.equal(smallerUpToPercent(1000n, 660n), '34');
  assert.equal(smallerUpToPercent(1000n, 994n), '0.6');
  assert.equal(smallerUpToPercent(3n, 2n), '33.4', 'rounded up');
  assert.equal(smallerUpToPercent(0n, 0n), null);
  assert.deepEqual(planNetworkCost({ gasUnits: 500_000n, feePerGas: 10n, l1: { source: 'nitro_node_interface', wei: 55_053_012_000n, l1GasUnits: 2751n } }), { l2: 5_000_000n, l1: 27_510n, total: 5_027_510n, ceiling: null });
  assert.deepEqual(planNetworkCost({ gasUnits: 500_000n, feePerGas: 10n, l1: { source: 'op_gas_price_oracle', wei: 100n, upperBoundWei: 400n } }), { l2: 5_000_000n, l1: 100n, total: 5_000_100n, ceiling: 5_000_400n });
  assert.deepEqual(planNetworkCost({ gasUnits: 1n, feePerGas: 1n, l1: null }), { l2: 1n, l1: null, total: 1n, ceiling: null });
  const pool = { dex: 4, currency0: ZERO, currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 3000, tickSpacing: 60, hooks: ZERO };
  const legs = [{ kind: 3, router: ZERO, tokenIn: ZERO, tokenOut: pool.currency1, amountIn: 80n, minAmountOut: 1n, data: '0x' }];
  assert.deepEqual(conversionSummary({ pool, legs, expectedRemoved: [100n, 5n], offerAbovePercent: 10 }), { token: ZERO, converted: 80n, rest: 20n, offer: true });
  assert.deepEqual(conversionSummary({ pool, legs, expectedRemoved: [85n, 5n], offerAbovePercent: 10 }), { token: ZERO, converted: 80n, rest: 5n, offer: false });
});
