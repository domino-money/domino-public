/**
 * The onboarding-v1 client (#38): what it sends, and how every reply is
 * interpreted, in order: the transport, the beta gate and other replies
 * without the contract header, the exact version header, JSON and the size
 * bound, then the package runtime, the owner and the echo, then errors.
 * Every package fixture and every one of the 24 error pairs is driven through
 * the real runtime; the gate's replies come from the compiled middleware.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, clone, fakeClock, fakePort, fixture, fixtureText, flush, gateAnswer, onboardingRuntime as runtime, reply } from './support/consumer-fakes.mjs';

const { createOnboardingClient, interpretPreview, PREVIEW_TIMEOUT_MS, SWAP_ROUTE_TIMEOUT_MS, MAX_RESPONSE_BYTES } = build('onboarding/client');
const { requestSwapRoute } = build('onboarding/routed');
const { createPreviewBudget } = build('onboarding/budget');
const { ONBOARDING_ERROR_UI } = build('onboarding/errors');
const { buildSwapRequest, buildPositionRequest } = build('onboarding/inputs');
const { consumerTestCatalog } = build('onboarding/catalog');
const { rawReplyOf, parseRetryAfter, GATE_REFUSAL } = build('lib/http/rawReply');
const { GATE_REFUSAL: READ_GATE_REFUSAL } = build('lib/read/interpret');
const { hundredthsToPercentText, parseSafeInteger, formatWeiEth, formatTokenAmount, groupRaw, UINT256_MAX, isUint256 } = build('lib/raw');

const SWAP_OWNER = '0x4444444444444444444444444444444444444444';
const POSITION_OWNER = '0xabababababababababababababababababababab';
const SYN_A = '0x1111111111111111111111111111111111111111';
const SYN_B = '0x2222222222222222222222222222222222222222';
const REQUEST_ID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const HEADER = 'X-Domino-Onboarding-Contract';

const REQUESTS = { 'swap-preview': fixture('onboarding-v1', 'requests/swap-preview.json'), 'position-preview': fixture('onboarding-v1', 'requests/position-preview.json') };
const onb = (status, body, options = {}) => reply(status, body, { contract: '1.1.0', ...options });
const requestOf = (preview) => {
  const { owner: _owner, ...rest } = preview.request;
  return rest;
};

const RESPONSES = [
  ['swap-preview', 'responses/swap-preview.json', SWAP_OWNER],
  ['swap-preview', 'variants/swap-preview.unknown.json', SWAP_OWNER],
  ['position-preview', 'responses/position-preview.json', POSITION_OWNER],
  ['position-preview', 'variants/position-preview.incomplete.json', POSITION_OWNER],
  ['position-preview', 'variants/position-preview.blocked.json', POSITION_OWNER],
  ['position-preview', 'variants/position-preview.native.json', POSITION_OWNER],
  ...['responses/swap-route.json', 'variants/swap-route.native.json', 'variants/swap-route.unfilled.json', 'variants/swap-route.pool.json', 'variants/swap-route.unavailable.json'].map((path) => ['swap-route', path, SYN_A]),
];

const ROUTED = fixture('onboarding-v1', 'responses/swap-route.json');
const ROUTED_REQUEST = requestOf(ROUTED.preview);
const routeAnswer = (body = ROUTED, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', [HEADER]: '1.1.0' },
});

const SWAP_FORM = { tokenIn: SYN_A, tokenOut: SYN_B, amountRaw: '1000', slippageBps: '50', maxPriceImpactBps: '100' };
const POSITION_FORM = {
  poolId: REQUESTS['position-preview'].poolId,
  independent: '0',
  amountRaw: '100',
  tickLower: '-120',
  tickUpper: '180',
  slippageBps: '50',
  budget0Raw: '110',
  budget1Raw: '220',
  nativeBalanceRaw: '1000',
  nativeGasReserveRaw: '300',
};

// ---- requests -----------------------------------------------------------------

test('the forms serialise exactly to the package request fixtures, which the runtime accepts (T-3, T-4)', () => {
  const swap = buildSwapRequest(SWAP_FORM, consumerTestCatalog);
  assert.ok(swap.ok);
  assert.deepEqual(swap.request, REQUESTS['swap-preview']);
  assert.ok(runtime.validateRequest('swap-preview', swap.request));
  const position = buildPositionRequest(POSITION_FORM, consumerTestCatalog);
  assert.ok(position.ok);
  assert.deepEqual(position.request, REQUESTS['position-preview']);
  assert.ok(runtime.validateRequest('position-preview', position.request));
  for (const request of [swap.request, position.request]) {
    for (const forbidden of ['owner', 'recipient', 'tenant', 'signature', 'calldata']) assert.ok(!(forbidden in request), forbidden);
  }
});

test('local validation: spacing, order, bounds, independent token, budget, reserve, blanks as null (T-5, T-6)', () => {
  const fields = (form) => {
    const out = buildPositionRequest({ ...POSITION_FORM, ...form }, consumerTestCatalog);
    return out.ok ? [] : out.issues.map((issue) => issue.field);
  };
  assert.deepEqual(fields({}), []);
  assert.deepEqual(fields({ tickLower: '-100' }), ['tickLower']);
  assert.match(buildPositionRequest({ ...POSITION_FORM, tickLower: '-100' }, consumerTestCatalog).issues[0].message, /-120 or -60/, 'never snapped silently');
  assert.ok(fields({ tickLower: '180', tickUpper: '120' }).includes('tickUpper'));
  assert.ok(fields({ tickUpper: '887280' }).includes('tickUpper'));
  assert.deepEqual(fields({ budget0Raw: '99' }), ['budget0Raw'], "the independent token's budget must cover the amount");
  assert.deepEqual(fields({ budget1Raw: '1' }), [], "the other token's budget is the server's to judge (blocked)");
  assert.deepEqual(fields({ nativeBalanceRaw: '' }), ['nativeGasReserveRaw'], 'a reserve needs a balance');
  for (const amount of ['0', '1e3', '01', '-5', '1.5', ' ']) assert.ok(fields({ amountRaw: amount }).includes('amountRaw'), amount);
  for (const slippage of ['50.0', '5e1', '-0', '0', '9', '501', '10000']) assert.ok(fields({ slippageBps: slippage }).includes('slippageBps'), slippage);
  for (const slippage of ['10', '500']) assert.deepEqual(fields({ slippageBps: slippage }), [], `${slippage}: the ends of the bound are inside it`);
  assert.ok(fields({ poolId: `0x${'ff'.repeat(32)}` }).includes('poolId'), 'only curated pools');

  const blank = buildPositionRequest({ ...POSITION_FORM, budget0Raw: '', budget1Raw: '', nativeBalanceRaw: '', nativeGasReserveRaw: '' }, consumerTestCatalog);
  assert.deepEqual([blank.request.budget0Raw, blank.request.budget1Raw, blank.request.nativeBalanceRaw, blank.request.nativeGasReserveRaw], [null, null, null, null]);
  assert.equal(buildPositionRequest({ ...POSITION_FORM, budget0Raw: '0', amountRaw: '0' }, consumerTestCatalog).ok, false);

  const native = buildPositionRequest({ ...POSITION_FORM, poolId: '0x06339ed6a3555ccef52e5dd5be2a590cdeaeeb7bd1e0cecee96da150ac14dc58' }, consumerTestCatalog);
  assert.equal(native.request.independentToken, '0x0000000000000000000000000000000000000000', 'native ETH is the zero address, never a wrapped token');

  const big = buildSwapRequest({ ...SWAP_FORM, amountRaw: '123456789012345678901234567890123' }, consumerTestCatalog);
  assert.equal(big.request.amountRaw, '123456789012345678901234567890123', 'raw strings beyond 2^53 are kept exactly');
  assert.ok(buildSwapRequest({ ...SWAP_FORM, amountRaw: UINT256_MAX.toString() }, consumerTestCatalog).ok);
  assert.equal(buildSwapRequest({ ...SWAP_FORM, amountRaw: (UINT256_MAX + 1n).toString() }, consumerTestCatalog).ok, false);
  assert.equal(buildSwapRequest({ ...SWAP_FORM, tokenOut: SYN_A }, consumerTestCatalog).ok, false, 'the two tokens differ');
  assert.equal(buildSwapRequest({ ...SWAP_FORM, maxPriceImpactBps: '10001' }, consumerTestCatalog).ok, false);
});

test('a preview is one same-origin POST with the pinned header and the lent CSRF, and nothing else (T-7)', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(fixtureText('onboarding-v1', 'responses/swap-preview.json'), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', [HEADER]: '1.1.0', 'X-Domino-Request-Id': REQUEST_ID },
    });
  };
  const client = createOnboardingClient({ fetch, runtime, clock: fakeClock() });
  const out = await client.preview('swap-preview', REQUESTS['swap-preview'], { csrf: 'lent-csrf', sessionOwner: SWAP_OWNER });
  assert.equal(out.ok, true);
  assert.equal(out.requestId, REQUEST_ID);
  assert.equal(sent.length, 1);
  const [{ url, init }] = sent;
  assert.equal(url, '/api/onboarding/v1/swap-preview', 'a constant prefix and route: no query, no hash');
  assert.equal(init.method, 'POST');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.referrerPolicy, 'same-origin');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', [HEADER]: '1.1.0', 'X-Domino-CSRF': 'lent-csrf' });
  assert.deepEqual(JSON.parse(init.body), REQUESTS['swap-preview']);
  assert.ok(init.signal instanceof AbortSignal);
});

test('a request the contract rejects is never sent', async () => {
  let sent = 0;
  const client = createOnboardingClient({ fetch: async () => (sent += 1), runtime, clock: fakeClock() });
  for (const bad of [{ ...REQUESTS['swap-preview'], owner: SWAP_OWNER }, { ...REQUESTS['swap-preview'], amountRaw: 1000 }, { ...REQUESTS['swap-preview'], chainId: 1 }]) {
    const out = await client.preview('swap-preview', bad, { csrf: 'c', sessionOwner: SWAP_OWNER });
    assert.equal(out.failure.detail, 'request_contract');
  }
  assert.equal(sent, 0);
});

test('swap-route is one same-origin POST, with nested pool identity and no owner or stored CSRF in its body', async () => {
  const sent = [];
  const client = createOnboardingClient({ fetch: async (url, init) => (sent.push({ url, init }), routeAnswer()), runtime, clock: fakeClock() });
  const out = await client.preview('swap-route', ROUTED_REQUEST, { csrf: 'lent-for-one-route', sessionOwner: SYN_A });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  const [{ url, init }] = sent;
  assert.equal(url, '/api/onboarding/v1/swap-route');
  assert.equal(init.method, 'POST');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers[HEADER], '1.1.0');
  assert.equal(init.headers['X-Domino-CSRF'], 'lent-for-one-route');
  assert.deepEqual(JSON.parse(init.body), ROUTED_REQUEST);
  assert.ok(!('owner' in JSON.parse(init.body)));
  assert.doesNotMatch(init.body, /lent-for-one-route/);
});

test('swap-route validates the exact request bounds before any network call', async () => {
  let sends = 0;
  const client = createOnboardingClient({ fetch: async () => (sends++, routeAnswer()), runtime, clock: fakeClock() });
  const changes = [
    { owner: SYN_A }, { chainId: 1 }, { amountRaw: '0' }, { amountRaw: '01' },
    { amountRaw: (1n << 128n).toString() }, { amountRaw: 1000 },
    { slippageBps: 9 }, { slippageBps: 501 }, { tokenIn: SYN_B },
    { poolKey: { ...ROUTED_REQUEST.poolKey, extra: 1 } },
  ];
  for (const change of changes) {
    const out = await client.preview('swap-route', { ...ROUTED_REQUEST, ...change }, { csrf: 'c', sessionOwner: SYN_A });
    assert.equal(out.failure.detail, 'request_contract', JSON.stringify(change));
  }
  assert.equal(sends, 0);
});

test('only swap-route uses a 12 s deadline; timeouts and cancellations never retry the route', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetch = (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };
  const client = createOnboardingClient({ fetch, runtime, clock });
  let result = null;
  client.preview('swap-route', ROUTED_REQUEST, { csrf: 'c', sessionOwner: SYN_A }).then((out) => (result = out));
  assert.equal(SWAP_ROUTE_TIMEOUT_MS, 12_000);
  assert.equal(PREVIEW_TIMEOUT_MS, 27_000);
  clock.advance(11_999);
  await flush();
  assert.equal(result, null);
  clock.advance(1);
  await flush();
  assert.equal(result.failure.kind, 'timed_out');
  assert.equal(calls, 1);
  const user = new AbortController();
  const aborted = client.preview('swap-route', ROUTED_REQUEST, { csrf: 'c', sessionOwner: SYN_A, signal: user.signal });
  user.abort();
  assert.deepEqual(await aborted, { ok: false, aborted: true });
  assert.equal(calls, 2);
});

test('swap-route checks the runtime, the session owner, every nested pool field and exact amount/slippage echo', () => {
  const interpret = (sent, body = ROUTED, owner = SYN_A) => interpretPreview('swap-route', sent, onb(200, body), runtime, owner);
  assert.equal(interpret(ROUTED_REQUEST, ROUTED, SYN_B).failure.detail, 'owner_mismatch');
  for (const change of [
    { chainId: 1 }, { poolId: '0x' + 'aa'.repeat(32) }, { amountRaw: '1000000001' }, { slippageBps: 51 }, { tokenIn: ROUTED.preview.tokenOut },
    ...Object.keys(ROUTED_REQUEST.poolKey).map((key) => ({ poolKey: { ...ROUTED_REQUEST.poolKey, [key]: typeof ROUTED_REQUEST.poolKey[key] === 'number' ? ROUTED_REQUEST.poolKey[key] + 1 : SYN_B } })),
    { poolKey: { ...ROUTED_REQUEST.poolKey, extra: 1 } },
  ]) assert.equal(interpret({ ...ROUTED_REQUEST, ...change }).failure.detail, 'echo_mismatch', JSON.stringify(change));
  const mixed = clone(ROUTED_REQUEST);
  const mixedCase = (address) => '0x' + address.slice(2).toUpperCase();
  for (const key of ['poolId', 'tokenIn']) mixed[key] = mixedCase(mixed[key]);
  for (const key of ['currency0', 'currency1', 'hooks']) mixed.poolKey[key] = mixedCase(mixed.poolKey[key]);
  assert.equal(interpret(mixed).ok, true, 'currency identity ignores case, never token symbols');
});

test('swap-route rejects changed owners, router, Permit2, calldata selectors, exact allowance and malformed expiry', () => {
  const mutations = {
    owner: (body) => { body.preview.request.owner = SYN_B; },
    'wrong chain': (body) => { body.preview.chainId = 1; },
    router: (body) => { body.preview.uniswap.swapTransaction.to = SYN_B; },
    Permit2: (body) => { body.preview.uniswap.permitTransaction.to = SYN_B; },
    'approval spender': (body) => { body.preview.uniswap.approval.spender = SYN_B; },
    'approval amount': (body) => { body.preview.uniswap.approval.amountRaw = '1000000001'; },
    'permit token': (body) => { body.preview.uniswap.permitTransaction.data = body.preview.uniswap.permitTransaction.data.replace(ROUTED_REQUEST.tokenIn.slice(2), SYN_B.slice(2)); },
    'permit unlimited': (body) => { const p = body.preview.uniswap.permitTransaction; p.data = p.data.slice(0, 138) + '0'.repeat(24) + 'f'.repeat(40) + p.data.slice(202); },
    'permit selector': (body) => { body.preview.uniswap.permitTransaction.data = '0xdeadbeef' + body.preview.uniswap.permitTransaction.data.slice(10); },
    'swap selector': (body) => { body.preview.uniswap.swapTransaction.data = '0xdeadbeef' + body.preview.uniswap.swapTransaction.data.slice(10); },
    'native value on ERC20': (body) => { body.preview.uniswap.swapTransaction.valueRaw = ROUTED_REQUEST.amountRaw; },
    'extended expiry': (body) => { body.preview.expiresAt++; },
    'expires before retrieval': (body) => { body.preview.retrievedAt = body.preview.expiresAt; },
    'fee recipient': (body) => { body.preview.feeRecipient = SYN_B; },
    'forged decision': (body) => { body.preview.decision = 'pool'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const body = clone(ROUTED);
    mutate(body);
    const out = interpretPreview('swap-route', ROUTED_REQUEST, onb(200, body), runtime, SYN_A);
    assert.equal(out.ok, false, name);
    assert.equal(out.failure.detail, name === 'owner' ? 'owner_mismatch' : 'response_contract', name);
  }
  for (const header of [null, '1.0.0', '1.1.1']) {
    const out = interpretPreview('swap-route', ROUTED_REQUEST, onb(200, ROUTED, { contract: header }), runtime, SYN_A);
    assert.equal(out.ok, false, String(header));
  }
});

test('route session helper lends CSRF once and returns a conservative monotonic deadline without retrying', async () => {
  const clock = fakeClock();
  const port = fakePort({ owner: SYN_A });
  const budget = createPreviewBudget({ clock });
  const client = createOnboardingClient({ fetch: async () => { clock.advance(2_000); return routeAnswer(); }, runtime, clock });
  const out = await requestSwapRoute({ client, port, clock, budget }, ROUTED_REQUEST, { owner: SYN_A });
  assert.equal(out.ok, true);
  assert.equal(out.deadlineMono, 40_000, 'the 30 seconds start when the request was sent, not when it arrives');
  assert.equal(out.sessionKey, '1|uid-a|' + SYN_A);
  assert.deepEqual(port.lends, [1]);
  assert.equal(clock.pending(), 0, 'no expiry/refresh timer creates another request');
  clock.setWall(0);
  assert.equal(out.deadlineMono - clock.monoMs(), 28_000, 'device wall-clock changes cannot extend the route');
});

test('route session helper rejects stale/invalid replies and expired transport results for the caller to use the pool', async () => {
  for (const makeAnswer of [() => routeAnswer({ contractVersion: '1.0.0', preview: ROUTED.preview }), () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }), () => { throw new TypeError('offline'); }]) {
    const clock = fakeClock();
    const port = fakePort({ owner: SYN_A });
    const out = await requestSwapRoute({ client: createOnboardingClient({ fetch: makeAnswer, runtime, clock }), port, clock, budget: createPreviewBudget({ clock }) }, ROUTED_REQUEST, { owner: SYN_A });
    assert.deepEqual(out, { ok: false, reason: 'unavailable' });
  }
  const clock = fakeClock();
  const port = fakePort({ owner: SYN_A });
  // A client returning after the lifetime is over cannot hand off an old plan, even if a transport ignores abort.
  const client = { preview: async () => { clock.advance(30_000); return { ok: true, preview: ROUTED.preview, requestId: null }; } };
  assert.deepEqual(await requestSwapRoute({ client, port, clock, budget: createPreviewBudget({ clock }) }, ROUTED_REQUEST, { owner: SYN_A }), { ok: false, reason: 'expired' });
});

test('route session helper aborts on owner, chain, epoch, connector and caller changes, discarding even an uncancellable late reply', async () => {
  const changes = [
    { kind: 'signed_out' }, { kind: 'wrong_network', chainId: 1 },
    { kind: 'signed_in', owner: SYN_B, chainId: 4663, epoch: 1, connectorUid: 'uid-a' },
    { kind: 'signed_in', owner: SYN_A, chainId: 4663, epoch: 2, connectorUid: 'uid-a' },
    { kind: 'signed_in', owner: SYN_A, chainId: 4663, epoch: 1, connectorUid: 'uid-b' },
    null,
  ];
  for (const next of changes) {
    const clock = fakeClock();
    const port = fakePort({ owner: SYN_A });
    const caller = new AbortController();
    let finish, signal;
    const client = { preview: (_route, _request, options) => (signal = options.signal, new Promise((resolve) => { finish = resolve; })) };
    const pending = requestSwapRoute({ client, port, clock, budget: createPreviewBudget({ clock }) }, ROUTED_REQUEST, { owner: SYN_A, signal: caller.signal });
    if (next) port.set(next); else caller.abort();
    assert.equal(signal.aborted, true);
    finish({ ok: true, preview: ROUTED.preview, requestId: null });
    assert.deepEqual(await pending, { ok: false, reason: 'aborted' });
  }
});

test('route session helper shares the preview budget and cooldown; no session, wrong wallet or spent budget means no POST', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = createOnboardingClient({ fetch: async () => (calls++, routeAnswer({ error: 'onboarding_rate_limited' }, 429)), runtime, clock });
  const port = fakePort({ owner: SYN_A });
  const budget = createPreviewBudget({ clock, limit: 1 });
  const deps = { client, port, clock, budget };
  assert.deepEqual(await requestSwapRoute(deps, ROUTED_REQUEST, { owner: SYN_B }), { ok: false, reason: 'session' });
  assert.equal(calls, 0);
  assert.deepEqual(await requestSwapRoute(deps, ROUTED_REQUEST, { owner: SYN_A }), { ok: false, reason: 'unavailable' });
  assert.equal(budget.check().reason, 'cooldown');
  assert.deepEqual(await requestSwapRoute(deps, ROUTED_REQUEST, { owner: SYN_A }), { ok: false, reason: 'budget' });
  assert.equal(calls, 1);
  port.set({ kind: 'signed_out' });
  assert.deepEqual(await requestSwapRoute(deps, ROUTED_REQUEST, { owner: SYN_A }), { ok: false, reason: 'session' });
  assert.equal(calls, 1);
  budget.dispose();
});

test('route session helper reports a session denial only to the epoch which asked', async () => {
  const clock = fakeClock();
  const port = fakePort({ owner: SYN_A, epoch: 9 });
  const client = createOnboardingClient({ fetch: async () => routeAnswer({ error: 'csrf_invalid' }, 403), runtime, clock });
  const out = await requestSwapRoute({ client, port, clock, budget: createPreviewBudget({ clock }) }, ROUTED_REQUEST, { owner: SYN_A });
  assert.equal(out.ok, false);
  assert.deepEqual(port.denials, [{ code: 'csrf_invalid', epoch: 9 }]);
});

test('the browser service fake admits authenticated swap-route and defaults to a valid pool fallback for ERC20 and native directions', async () => {
  const { createFakeOnboarding, routedSwapPreview } = await import('./support/fake-onboarding.mjs');
  const csrf = 'fixture-only-csrf';
  const session = { state: { sessions: new Map([['fixture-cookie', { csrf }]]) }, ownerOfSessionCookie: () => SYN_A, sessionsFor: () => [{ csrf, active: true }] };
  const fake = createFakeOnboarding({ session });
  fake.origin = 'https://domino.test';
  const nativeIn = requestOf(fixture('onboarding-v1', 'variants/swap-route.native.json').preview);
  for (const request of [ROUTED_REQUEST, nativeIn, { ...nativeIn, tokenIn: nativeIn.poolKey.currency1 }]) {
    const response = await fake.handle(new Request('https://domino.test/api/onboarding/v1/swap-route', {
      method: 'POST', headers: { Origin: 'https://domino.test', 'Content-Type': 'application/json', [HEADER]: '1.1.0', 'X-Domino-CSRF': csrf, Cookie: '__Host-domino-session=fixture-cookie' }, body: JSON.stringify(request),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(runtime.validateResponse('swap-route', body), true);
    assert.equal(body.preview.decision, 'pool');
    assert.equal(body.preview.reason, 'uniswap_quote_unavailable');
    assert.equal(body.preview.uniswap, null);
    assert.deepEqual(body.preview.request, { ...request, owner: SYN_A });
  }
  assert.equal(fake.calls('swap-route').length, 3);
  assert.deepEqual(fake.state.violations, []);
  for (const request of [ROUTED_REQUEST, nativeIn, { ...nativeIn, tokenIn: nativeIn.poolKey.currency1 }]) {
    for (const [poolOutRaw, amountOutRaw, decision] of [['440000', '450000', 'uniswap'], ['100000', '100500', 'pool'], ['0', '450000', 'uniswap']]) {
      const preview = routedSwapPreview({ request: { ...request, owner: SYN_A }, now: ROUTED.preview.requestedAt, poolOutRaw, amountOutRaw });
      assert.equal(runtime.validateResponse('swap-route', { contractVersion: '1.1.0', preview }), true);
      assert.equal(preview.decision, decision);
      assert.equal(preview.uniswap.swapTransaction === null, decision === 'pool');
    }
  }
});

test('the page gives up after 27 s of its own clock, a little after the worker would (T-32)', async () => {
  const clock = fakeClock();
  const fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const client = createOnboardingClient({ fetch, runtime, clock });
  let result = null;
  client.preview('swap-preview', REQUESTS['swap-preview'], { csrf: 'c', sessionOwner: SWAP_OWNER }).then((out) => (result = out));
  assert.equal(PREVIEW_TIMEOUT_MS, 27_000);
  clock.advance(26_999);
  await new Promise((done) => setImmediate(done));
  assert.equal(result, null);
  clock.advance(1);
  await new Promise((done) => setImmediate(done));
  assert.equal(result.failure.kind, 'timed_out');

  const user = new AbortController();
  const aborted = client.preview('swap-preview', REQUESTS['swap-preview'], { csrf: 'c', sessionOwner: SWAP_OWNER, signal: user.signal });
  user.abort();
  assert.deepEqual(await aborted, { ok: false, aborted: true }, 'an invalidation is silent');
});

test('a reply keeps its request id in either shape Domino writes, a Worker UUID or a gateway’s 32 hex, and drops anything else', async () => {
  const replyWith = (id) => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', [HEADER]: '1.1.0', 'X-Domino-Request-Id': id } });
  const GATEWAY_ID = 'c549ebea4bfca053878e1646dfe6cf7d';
  assert.equal((await rawReplyOf(replyWith(REQUEST_ID), HEADER, MAX_RESPONSE_BYTES)).requestIdHeader, REQUEST_ID);
  assert.equal((await rawReplyOf(replyWith(GATEWAY_ID), HEADER, MAX_RESPONSE_BYTES)).requestIdHeader, GATEWAY_ID, 'the development gateway’s id, as the local-live proxy passes it on');
  for (const junk of ['-'.repeat(36), GATEWAY_ID.toUpperCase(), 'x'.repeat(32), REQUEST_ID.toUpperCase(), `${GATEWAY_ID}0`]) {
    assert.equal((await rawReplyOf(replyWith(junk), HEADER, MAX_RESPONSE_BYTES)).requestIdHeader, null, junk);
  }
  const without = new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', [HEADER]: '1.1.0' } });
  assert.equal((await rawReplyOf(without, HEADER, MAX_RESPONSE_BYTES)).requestIdHeader, null);
});

test("the worker's own 504 reaches the user as timed out, with its request id (OC-10)", () => {
  const out = interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(504, { error: 'request_timeout' }, { requestId: REQUEST_ID }), runtime, SWAP_OWNER);
  assert.equal(out.failure.kind, 'timed_out');
  assert.equal(out.requestId, REQUEST_ID);
});

// ---- replies without the contract header ---------------------------------------

const watched = () => {
  const reached = [];
  return {
    reached,
    runtime: {
      ...runtime,
      validateResponse: (...args) => (reached.push('validateResponse'), runtime.validateResponse(...args)),
      validateError: (...args) => (reached.push('validateError'), runtime.validateError(...args)),
    },
  };
};

test("the beta gate's real 401 and 503 are recognised before any validator runs (OC-5, T-35)", async () => {
  assert.equal(GATE_REFUSAL, READ_GATE_REFUSAL, 'the same literal as the read adapter');
  const spy = watched();
  const refused = await gateAnswer('/api/onboarding/v1/swap-preview');
  assert.equal(refused.status, 401);
  const raw = await rawReplyOf(refused, HEADER, MAX_RESPONSE_BYTES);
  assert.equal(raw.contractHeader, null);
  const out = interpretPreview('swap-preview', REQUESTS['swap-preview'], { kind: 'reply', reply: raw }, spy.runtime, SWAP_OWNER);
  assert.equal(out.failure.kind, 'gate_required', 'beta access, not signed out');

  const broken = await gateAnswer('/api/onboarding/v1/swap-preview', {});
  assert.equal(broken.status, 503);
  const page = await rawReplyOf(broken, HEADER, MAX_RESPONSE_BYTES);
  assert.equal(interpretPreview('swap-preview', REQUESTS['swap-preview'], { kind: 'reply', reply: page }, spy.runtime, SWAP_OWNER).failure.kind, 'gate_unavailable');
  assert.deepEqual(spy.reached, []);
});

test('other replies without the header: a missing route is "not available", anything else unavailable, a redirect never followed', () => {
  const spy = watched();
  const interpret = (result) => interpretPreview('swap-preview', REQUESTS['swap-preview'], result, spy.runtime, SWAP_OWNER).failure;
  assert.equal(interpret(reply(200, '<!doctype html><title>Domino</title>', { contentType: 'text/html; charset=utf-8' })).kind, 'feature_unavailable');
  assert.equal(interpret(reply(404, 'not found', { contentType: 'text/plain' })).kind, 'feature_unavailable');
  assert.equal(interpret(reply(405, '')).kind, 'feature_unavailable');
  assert.deepEqual([interpret(reply(500, { error: 'upstream_unavailable' })).kind, interpret(reply(500, { error: 'upstream_unavailable' })).detail], ['unavailable', 'upstream_unavailable']);
  assert.equal(interpret(reply(401, { error: 'session_required' })).kind, 'unavailable', 'a 401 without the header is not the session');
  assert.equal(interpret(reply(0, '', { opaqueRedirect: true })).detail, 'redirect');
  assert.equal(interpret({ kind: 'network' }).detail, 'network');
  assert.deepEqual(spy.reached, []);
});

test('the header must be exactly 1.1.0, the body JSON, within bounds and parseable', () => {
  const body = fixture('onboarding-v1', 'responses/swap-preview.json');
  const interpret = (result) => interpretPreview('swap-preview', REQUESTS['swap-preview'], result, runtime, SWAP_OWNER).failure.detail;
  for (const version of ['1.0.0', '1.1.1', '1.1', '1.1.0 ', 'v1.1.0', '2.0.0']) assert.equal(interpret(reply(200, body, { contract: version })), 'contract_version', version);
  assert.equal(interpret(onb(200, body, { contentType: 'text/plain' })), 'not_json');
  const tooLarge = onb(200, body);
  tooLarge.reply.body = { kind: 'too_large' };
  assert.equal(interpret(tooLarge), 'too_large');
  assert.equal(interpret(onb(200, '{"contractVersion":')), 'invalid_json');
});

// ---- successes ---------------------------------------------------------------------

test('every package response fixture is current for its own owner and request (T-8)', () => {
  for (const [route, path, owner] of RESPONSES) {
    const body = fixture('onboarding-v1', path);
    const out = interpretPreview(route, requestOf(body.preview), onb(200, body), runtime, owner);
    assert.equal(out.ok, true, path);
    assert.deepEqual(out.preview, body.preview);
  }
});

test('a preview for another owner is dropped (S-5, T-23)', () => {
  const body = fixture('onboarding-v1', 'responses/swap-preview.json');
  const out = interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(200, body), runtime, POSITION_OWNER);
  assert.equal(out.failure.detail, 'owner_mismatch');
});

test('a preview for other inputs is dropped; identity fields compare without case (INV-2)', () => {
  const body = fixture('onboarding-v1', 'responses/swap-preview.json');
  const echo = (sent) => interpretPreview('swap-preview', sent, onb(200, body), runtime, SWAP_OWNER);
  assert.equal(echo({ ...REQUESTS['swap-preview'], amountRaw: '1001' }).failure.detail, 'echo_mismatch');
  assert.equal(echo({ ...REQUESTS['swap-preview'], slippageBps: 51 }).failure.detail, 'echo_mismatch');
  assert.equal(echo({ ...REQUESTS['swap-preview'], tokenIn: SYN_A.toUpperCase().replace('0X', '0x') }).ok, true);
  const position = fixture('onboarding-v1', 'variants/position-preview.incomplete.json');
  const sent = requestOf(position.preview);
  for (const key of ['budget0Raw', 'budget1Raw', 'nativeBalanceRaw', 'nativeGasReserveRaw']) delete sent[key];
  assert.equal(interpretPreview('position-preview', sent, onb(200, position), runtime, POSITION_OWNER).ok, true, 'omitted optional fields echo as null');
  const withBudget = { ...sent, budget0Raw: '5' };
  assert.equal(interpretPreview('position-preview', withBudget, onb(200, position), runtime, POSITION_OWNER).failure.detail, 'echo_mismatch');
});

test('a response the runtime refuses is unavailable, with nothing kept (T-14)', () => {
  const base = fixture('onboarding-v1', 'responses/swap-preview.json');
  const unknown = fixture('onboarding-v1', 'variants/swap-preview.unknown.json');
  const mutations = {
    'a mutated amount': (body) => (body.preview.quote.grossOutputAmountRaw = '2001'),
    'an extra key': (body) => (body.preview.quote.extra = '1'),
    'executionAvailable true': (body) => (body.preview.executionAvailable = true),
    'a broken route sum': (body) => (body.preview.quote.routes[0][0].amountInRaw = '999'),
    'a numeric amount': (body) => (body.preview.quote.dexInputAmountRaw = 1000),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const body = clone(base);
    mutate(body);
    assert.equal(interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(200, body), runtime, SWAP_OWNER).failure.detail, 'response_contract', label);
  }
  const reordered = clone(unknown);
  reordered.preview.previewChecks.reasons.reverse();
  assert.equal(interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(200, reordered), runtime, SWAP_OWNER).failure.detail, 'response_contract', 'reordered reasons');
});

test('a runtime that throws is unavailable, never an exception on the page', () => {
  const throwing = { ...runtime, validateResponse: () => { throw new TypeError('isWellFormed is not a function'); } };
  const out = interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(200, fixture('onboarding-v1', 'responses/swap-preview.json')), throwing, SWAP_OWNER);
  assert.equal(out.failure.detail, 'runtime_error');
});

// ---- errors ----------------------------------------------------------------------------

test('the error table covers exactly the 24 codes of the runtime', () => {
  assert.deepEqual(Object.keys(ONBOARDING_ERROR_UI).sort(), Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  assert.equal(Object.keys(ONBOARDING_ERROR_UI).length, 24);
});

test('every errors.json pair validates and lands on its state, with no amounts (T-25, T-27, T-28, T-30, T-31)', () => {
  const errors = fixture('onboarding-v1', 'errors.json');
  assert.equal(Object.keys(errors).length, 24);
  for (const [code, { status, body }] of Object.entries(errors)) {
    assert.ok(runtime.validateError(status, body), code);
    const out = interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(status, body, status === 429 ? { retryAfter: '60' } : {}), runtime, SWAP_OWNER);
    assert.equal(out.ok, false);
    assert.equal(out.failure.kind, ONBOARDING_ERROR_UI[code].kind, code);
    assert.equal(out.failure.code, code);
    if (status === 429) {
      assert.equal(out.failure.retryAfterS, 60);
      assert.equal(out.failure.retry, 'after');
    }
  }
  const kind = (code) => ONBOARDING_ERROR_UI[code];
  assert.deepEqual([kind('session_required').kind, kind('session_required').denial], ['signed_out', 'session_required']);
  assert.deepEqual([kind('csrf_invalid').kind, kind('csrf_invalid').denial], ['session_recovery', 'csrf_invalid']);
  assert.deepEqual([kind('account_unsupported').kind, kind('account_unsupported').denial], ['account_unsupported', 'account_unsupported']);
  for (const code of ['session_store_unavailable', 'account_check_unavailable']) {
    assert.equal(kind(code).kind, 'service_busy', `${code} keeps the session`);
    assert.equal(kind(code).denial, undefined);
  }
  assert.deepEqual([kind('route_not_available').kind, kind('route_not_available').retry], ['feature_unavailable', 'none']);
  assert.deepEqual([kind('provider_request_rejected').kind, kind('provider_request_rejected').retry], ['no_route', 'edit']);
  assert.equal(kind('preview_expired').kind, 'expired_before_delivery');
});

test('a mismatched pair, an unknown code and a neighbouring family’s code are all unavailable (T-26, S-9)', () => {
  const interpret = (status, body) => interpretPreview('swap-preview', REQUESTS['swap-preview'], onb(status, body), runtime, SWAP_OWNER).failure;
  for (const [status, body] of [
    [400, { error: 'session_required' }],
    [503, { error: 'invalid_request' }],
    [418, { error: 'teapot' }],
    [409, { error: 'session_exists' }],
    [401, { error: 'session_required', detail: 'x' }],
  ]) {
    const failure = interpret(status, body);
    assert.equal(failure.kind, 'unavailable', JSON.stringify(body));
    assert.equal(failure.detail, 'upstream_unavailable');
  }
});

// ---- exact arithmetic and parsing ----------------------------------------------------

test('hundredths to percent is exact string arithmetic (OC-11)', () => {
  const cases = { 0: '0', 25: '0.25', 9975: '99.75', 10000: '100', '0.5': '0.005', 65: '0.65', 100: '1' };
  for (const [input, output] of Object.entries(cases)) assert.equal(hundredthsToPercentText(String(input)), output, input);
  const long = `1.${'1'.repeat(36)}`;
  assert.equal(hundredthsToPercentText(long), `0.01${'1'.repeat(36)}`);
  for (const bad of ['', '-1', '1e2', '01', '.5', '1.']) assert.equal(hundredthsToPercentText(bad), null, bad);
});

test('integers from text and Retry-After are canonical and bounded', () => {
  assert.equal(parseSafeInteger('-120'), -120);
  for (const bad of ['-0', '01', '1.0', '5e1', ' 1', '9007199254740993', '']) assert.equal(parseSafeInteger(bad), null, bad);
  assert.equal(parseRetryAfter('60'), 60);
  assert.equal(parseRetryAfter('5'), 5);
  for (const bad of [null, '0', '61', '1.5', 'soon', '-1']) assert.equal(parseRetryAfter(bad), 60, String(bad));
});

test('wei and raw amounts format exactly, up to uint256 max, and unknown decimals are never guessed', () => {
  assert.equal(formatWeiEth('33000000'), '0.000000000033 ETH');
  assert.equal(formatWeiEth('0'), '0 ETH');
  assert.equal(groupRaw(UINT256_MAX.toString()), '115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129,639,935');
  assert.equal(formatTokenAmount('1000', null, 'SYN-A'), '1,000 raw units (decimals unknown)');
  assert.equal(formatTokenAmount('1000', 18, 'SYN-A'), '0.000000000000001 SYN-A');
  assert.ok(isUint256(UINT256_MAX.toString()));
  assert.ok(!isUint256((UINT256_MAX + 1n).toString()));
});
