/**
 * The deposit-v1 client (#40/#44): all eight routes over the package fixtures
 * and the real runtime, the exact rc.4 header, the gate, all 49 error pairs,
 * the mutations the runtime must refuse, and the client's own owner binding,
 * which the runtime cannot do. Also the seams around it: the wallet handoff
 * stub, the id-only memory and the pre-sign gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build, clone, depositRuntime as runtime, fakeClock, fakePort, fixture, fixtureText, gateAnswer, reply } from './support/consumer-fakes.mjs';

const { createDepositClient, interpretDeposit, DEPOSIT_ROUTES } = build('deposit/client');
const { createHttpDepositTransport } = build('deposit/httpTransport');
const { createFixtureTransport, reply: scripted } = build('deposit/fixtureTransport');
const { DEPOSIT_ERROR_UI, ERR2 } = build('deposit/errors');
const { DISABLED_WALLET_HANDOFF, WalletHandoffDisabledError, FUTURE_WALLET_STEP } = build('deposit/handoff');
const { createMemory, inMemoryBackend, localStorageBackend, MEMORY_KEY } = build('deposit/memory');
const { checkPreSign } = build('deposit/presign');
const { rawReplyOf } = build('lib/http/rawReply');
const { FIXTURE_OWNER, createFixtureSessionPort, FIXTURE_CSRF } = build('deposit/fixtures/fixtureSession');

const OWNER = FIXTURE_OWNER;
const FOREIGN = '0x1212121212121212121212121212121212121212';
const HEADER = 'X-Domino-Deposit-Contract';
const dep = (status, body, options = {}) => reply(status, body, { contract: '1.1.0-rc.4', ...options });
const ROUTES = ['allowances', 'cancel', 'create', 'get', 'list', 'prepare', 'reconcile', 'report'];
const VARIANTS = [
  'cancelled', 'confirmed', 'erc20_approval', 'erc20_reset', 'fee_cap_breach', 'legacy_receipt', 'mint', 'native',
  'partial_allowances', 'pending', 'permit2_approval', 'proxy-event-amounts', 'reported_nonce_conflict', 'reviewed-proxy', 'superseded', 'token-review-changed',
];

test('the client covers exactly the eight routes of the runtime, and every request fixture passes it (DC-1)', () => {
  assert.deepEqual([...DEPOSIT_ROUTES].sort(), [...runtime.ROUTES].sort());
  for (const route of ROUTES) assert.ok(runtime.validateRequest(route, fixture('deposit-v1', `requests/${route}.json`)), route);
});

test('over http each route is one same-origin POST with the rc.4 header and the lent CSRF; create too, at client level', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init });
    const route = url.slice('/api/deposit/v1/'.length);
    return new Response(fixtureText('deposit-v1', `responses/${route}.json`), { status: 200, headers: { 'Content-Type': 'application/json', [HEADER]: '1.1.0-rc.4' } });
  };
  const session = createFixtureSessionPort();
  const client = createDepositClient({ transport: createHttpDepositTransport({ fetch, clock: fakeClock() }), runtime, session });
  assert.equal(client.transportKind, 'http');
  for (const route of ROUTES) {
    const out = await client[route](fixture('deposit-v1', `requests/${route}.json`), { epoch: 1 });
    assert.equal(out.ok, true, route);
  }
  assert.deepEqual(sent.map((entry) => entry.url), ROUTES.map((route) => `/api/deposit/v1/${route}`));
  for (const { init } of sent) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers[HEADER], '1.1.0-rc.4');
    assert.equal(init.headers['X-Domino-CSRF'], FIXTURE_CSRF);
    assert.ok(!('owner' in JSON.parse(init.body)));
  }
});

test('an invalid request, a wrong epoch or a gone session sends nothing', async () => {
  const transport = createFixtureTransport({ csrf: FIXTURE_CSRF });
  const client = createDepositClient({ transport, runtime, session: createFixtureSessionPort() });
  assert.equal((await client.get({ intentId: 'not-a-uuid' }, { epoch: 1 })).failure.kind, 'request_invalid');
  assert.equal((await client.create({ ...fixture('deposit-v1', 'requests/create.json'), owner: OWNER }, { epoch: 1 })).failure.kind, 'request_invalid');
  assert.equal((await client.list({ limit: 21 }, { epoch: 1 })).failure.kind, 'request_invalid');
  assert.equal((await client.get(fixture('deposit-v1', 'requests/get.json'), { epoch: 2 })).failure.kind, 'session_gone');
  const signedOut = fakePort({ snapshot: { kind: 'signed_out' } });
  assert.equal((await createDepositClient({ transport, runtime, session: signedOut }).get(fixture('deposit-v1', 'requests/get.json'), { epoch: 1 })).failure.kind, 'session_gone');
  assert.equal(transport.calls().length, 0);
});

test('every response and variant fixture is accepted for its route; wallet steps only on prepare (DC-2, T1, T2)', () => {
  for (const route of ROUTES) assert.equal(interpretDeposit(route, dep(200, fixture('deposit-v1', `responses/${route}.json`)), runtime, OWNER).ok, true, route);
  for (const name of VARIANTS) {
    const body = fixture('deposit-v1', `variants/${name}.json`);
    const route = body.allowances ? 'allowances' : 'prepare';
    assert.equal(interpretDeposit(route, dep(200, body), runtime, OWNER).ok, true, name);
    if (body.walletStep) assert.equal(interpretDeposit('get', dep(200, body), runtime, OWNER).failure.detail, 'response', `${name} as get`);
  }
});

test('the header must be exactly 1.1.0-rc.4: rc.2, rc.3 and rc.5 are refused (PIN-3, DEP-GEN-2)', () => {
  const body = fixture('deposit-v1', 'responses/get.json');
  for (const version of ['1.1.0-rc.2', '1.1.0-rc.3', '1.1.0-rc.5', '1.1.0', '1.1.0-rc.4 ']) {
    assert.deepEqual(interpretDeposit('get', reply(200, body, { contract: version }), runtime, OWNER).failure, { kind: 'contract', detail: 'version' }, version);
  }
  assert.deepEqual(interpretDeposit('get', reply(500, { error: 'upstream_unavailable' }), runtime, OWNER).failure, { kind: 'contract', detail: 'header_missing' });
  assert.deepEqual(interpretDeposit('get', reply(404, 'nope', { contentType: 'text/plain' }), runtime, OWNER).failure, { kind: 'not_deployed' });
  assert.deepEqual(interpretDeposit('get', reply(0, '', { opaqueRedirect: true }), runtime, OWNER).failure, { kind: 'contract', detail: 'redirect' });
});

test("the gate's real 401 and 503 are recognised first", async () => {
  const refused = await rawReplyOf(await gateAnswer('/api/deposit/v1/get'), HEADER, 256 * 1024);
  assert.deepEqual(interpretDeposit('get', { kind: 'reply', reply: refused }, runtime, OWNER).failure, { kind: 'gate_required' });
  const broken = await rawReplyOf(await gateAnswer('/api/deposit/v1/get', {}), HEADER, 256 * 1024);
  assert.deepEqual(interpretDeposit('get', { kind: 'reply', reply: broken }, runtime, OWNER).failure, { kind: 'gate_unavailable' });
});

test('all 49 errors.json pairs validate and come back as that code; the table covers exactly them (T1)', () => {
  const errors = fixture('deposit-v1', 'errors.json');
  assert.equal(errors.length, 49);
  assert.deepEqual(Object.keys(DEPOSIT_ERROR_UI).sort(), Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  for (const { status, body } of errors) {
    assert.ok(runtime.validateError(status, body), body.error);
    const out = interpretDeposit('prepare', dep(status, body), runtime, OWNER);
    assert.deepEqual([out.failure.kind, out.failure.code, out.failure.status], ['error', body.error, status]);
    if (status === 429) assert.equal(out.failure.retryAfterS, 60);
  }
});

test('wallet_not_allowed, an unknown code and a mismatched pair are invalid bodies, not errors (T3)', () => {
  for (const [status, body] of [
    [403, { error: 'wallet_not_allowed' }],
    [409, { error: 'deposit_everything_is_fine' }],
    [400, { error: 'deposit_owner_busy' }],
  ]) {
    assert.deepEqual(interpretDeposit('prepare', dep(status, body), runtime, OWNER).failure, { kind: 'contract', detail: 'error_body' }, JSON.stringify(body));
  }
});

test('the ERR-2 sentence is on every token, admission and state denial; owner capacity and history never retry (DC-8)', () => {
  for (const code of ['deposit_token_changed', 'deposit_token_restricted', 'deposit_admission_required', 'deposit_state_changed', 'deposit_token_check_unavailable']) {
    assert.ok(DEPOSIT_ERROR_UI[code].copy.includes(ERR2), code);
    assert.equal(DEPOSIT_ERROR_UI[code].stop, true, code);
  }
  for (const code of ['deposit_token_changed', 'deposit_token_restricted', 'deposit_admission_required']) assert.equal(DEPOSIT_ERROR_UI[code].latch, true, code);
  assert.equal(DEPOSIT_ERROR_UI.deposit_owner_capacity_busy.retry, 'none');
  assert.equal(DEPOSIT_ERROR_UI.deposit_owner_history_full.retry, 'none');
  for (const disposition of Object.values(DEPOSIT_ERROR_UI)) assert.doesNotMatch(disposition.copy, /try another pool|new deposit instead|approve\s*\(/i);
});

test('mutations the runtime refuses never reach the screen (T3)', () => {
  const confirmed = fixture('deposit-v1', 'variants/confirmed.json');
  const conflict = fixture('deposit-v1', 'variants/reported_nonce_conflict.json');
  const mint = fixture('deposit-v1', 'variants/mint.json');
  const allowances = fixture('deposit-v1', 'variants/partial_allowances.json');
  const receipt = (body) => body.operation.history[0].receipt;
  const cases = [
    ['an amount under an unqualified basis', 'get', confirmed, (b) => (receipt(b).position.amount0Basis = 'token_review_changed')],
    ['L1 fee that is not L1 gas x price', 'get', confirmed, (b) => (receipt(b).l1FeeRaw = '999')],
    ['a total fee', 'get', confirmed, (b) => (receipt(b).totalFeeRaw = '1')],
    ['a wrong limits list', 'get', confirmed, (b) => (receipt(b).transaction.selectedLimitsExceeded = ['gasLimit'])],
    ['a conflict at the step nonce', 'get', conflict, (b) => (b.operation.history[0].reportedEffectConflicts[0].nonceRaw = '5')],
    ['allowances in reverse order', 'allowances', allowances, (b) => b.allowances.observations.reverse()],
    ['a wallet step on get', 'get', mint, () => {}],
    ['a prepare step whose nonce differs from history', 'prepare', mint, (b) => (b.walletStep.transaction.nonceRaw = '6')],
    ['a numeric amount', 'get', confirmed, (b) => (receipt(b).gasUsedRaw = 100000)],
  ];
  for (const [label, route, base, mutate] of cases) {
    const body = clone(base);
    mutate(body);
    assert.deepEqual(interpretDeposit(route, dep(200, body), runtime, OWNER).failure, { kind: 'contract', detail: 'response' }, label);
  }
});

test('owner binding: another account passes the runtime and is still refused, whole, by the client (DC-7)', () => {
  for (const route of ['get', 'report', 'reconcile', 'cancel', 'allowances', 'create']) {
    const body = fixture('deposit-v1', `responses/${route}.json`);
    body.operation.owner = FOREIGN;
    assert.ok(runtime.validateResponse(route, body), `${route} with another owner passes the runtime`);
    assert.deepEqual(interpretDeposit(route, dep(200, body), runtime, OWNER).failure, { kind: 'contract', detail: 'owner' }, route);
  }
  // A prepared step names its sender, so there the runtime refuses the rewrite itself: refused either way.
  const prepare = fixture('deposit-v1', 'responses/prepare.json');
  prepare.operation.owner = FOREIGN;
  assert.equal(interpretDeposit('prepare', dep(200, prepare), runtime, OWNER).ok, false);
  const list = fixture('deposit-v1', 'responses/list.json');
  list.operations[0].owner = FOREIGN;
  assert.ok(runtime.validateResponse('list', list));
  assert.deepEqual(interpretDeposit('list', dep(200, list), runtime, OWNER).failure, { kind: 'contract', detail: 'owner' });
  // Owner case does not matter; the session owner is lowercase.
  const upper = fixture('deposit-v1', 'responses/get.json');
  assert.equal(interpretDeposit('get', dep(200, upper), runtime, OWNER.toUpperCase().replace('0X', '0x')).ok, true);
});

test('the fixture transport answers only what was scripted and logs every call, with whether it carried the lab CSRF', async () => {
  const transport = createFixtureTransport({ csrf: FIXTURE_CSRF });
  const client = createDepositClient({ transport, runtime, session: createFixtureSessionPort() });
  transport.script('get', scripted(200, fixtureText('deposit-v1', 'responses/get.json')));
  assert.equal((await client.get(fixture('deposit-v1', 'requests/get.json'), { epoch: 1 })).ok, true);
  const unscripted = await client.get(fixture('deposit-v1', 'requests/get.json'), { epoch: 1 });
  assert.deepEqual(unscripted.failure, { kind: 'network' });
  assert.deepEqual(transport.unscripted(), ['get']);
  assert.deepEqual(transport.calls().map((call) => [call.route, call.csrfMatched]), [['get', true], ['get', true]]);
  transport.script('reconcile', { status: 0, body: '', outcome: 'timeout' });
  assert.deepEqual((await client.reconcile(fixture('deposit-v1', 'requests/reconcile.json'), { epoch: 1 })).failure, { kind: 'timeout' });
});

test('the fixture transport keeps whether each call carried the CSRF it expects, never the CSRF itself (rugged97 on #14)', async () => {
  // A CSRF is only ever compared in memory; a request log is a log.
  const lent = 'q'.repeat(43);
  const transport = createFixtureTransport({ csrf: lent });
  const client = createDepositClient({ transport, runtime, session: fakePort({ csrf: lent }) });
  transport.script('get', scripted(200, fixtureText('deposit-v1', 'responses/get.json')));
  assert.equal((await client.get(fixture('deposit-v1', 'requests/get.json'), { epoch: 1 })).ok, true);
  assert.ok(!JSON.stringify(transport.calls()).includes(lent), 'no CSRF in the call log');
  assert.deepEqual(transport.calls().map((call) => [call.route, call.csrfMatched]), [['get', true]]);

  // Another CSRF is recorded as not matching, and is not kept either.
  const other = 'r'.repeat(43);
  const strict = createFixtureTransport({ csrf: lent });
  const elsewhere = createDepositClient({ transport: strict, runtime, session: fakePort({ csrf: other }) });
  strict.script('get', scripted(200, fixtureText('deposit-v1', 'responses/get.json')));
  await elsewhere.get(fixture('deposit-v1', 'requests/get.json'), { epoch: 1 });
  assert.ok(!JSON.stringify(strict.calls()).includes(other), 'no CSRF in the call log');
  assert.deepEqual(strict.calls().map((call) => [call.route, call.csrfMatched]), [['get', false]]);
});

// ---- the wallet handoff seam -------------------------------------------------

test('the wallet handoff is a disabled stub: unavailable, frozen, and send throws before doing anything (C-R3, DG-3)', () => {
  assert.equal(DISABLED_WALLET_HANDOFF.available, false);
  assert.ok(Object.isFrozen(DISABLED_WALLET_HANDOFF));
  const step = fixture('deposit-v1', 'variants/mint.json').walletStep;
  assert.throws(() => DISABLED_WALLET_HANDOFF.send(step, { chainId: 4663, from: OWNER }), WalletHandoffDisabledError);
  assert.throws(() => DISABLED_WALLET_HANDOFF.send(step, { chainId: 4663, from: OWNER }), /not available in this build\. Nothing was sent/);
  const source = readFileSync(resolve(import.meta.dirname, '../src/deposit/handoff.ts'), 'utf8');
  assert.deepEqual(source.match(/^import\s+(?!type\b).*$/gm) ?? [], [], 'handoff.ts imports nothing at runtime');
  assert.doesNotMatch(source, /ethereum|request\(|eth_|wallet_|wagmi|viem/, 'nothing in it can reach a wallet');
  for (const part of ["validateResponse('prepare')", 'validateWalletStep', 'WalletHandoff.send', 'EIP-1559', 'chain 4663', 'report', 'Check status']) {
    assert.ok(FUTURE_WALLET_STEP.includes(part), `the named future step mentions ${part}`);
  }
});

// ---- memory ---------------------------------------------------------------------------

test('memory holds only an operation id, and a blocked store never throws (DF-8, DEP-GEN-8)', () => {
  const memory = createMemory(inMemoryBackend());
  memory.remember('00000000-0000-4000-8000-000000000040');
  assert.equal(memory.lastOperationId(), '00000000-0000-4000-8000-000000000040');
  memory.remember('0xabababababababababababababababababababab');
  memory.remember(JSON.stringify({ walletStep: 1 }));
  assert.equal(memory.lastOperationId(), '00000000-0000-4000-8000-000000000040');
  memory.forget();
  assert.equal(memory.lastOperationId(), null);

  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  const local = createMemory(localStorageBackend(() => storage));
  local.remember('00000000-0000-4000-8000-000000000041');
  assert.deepEqual([...store.entries()], [[MEMORY_KEY, '00000000-0000-4000-8000-000000000041']]);
  store.set(MEMORY_KEY, 'tampered');
  assert.equal(local.lastOperationId(), null, 'anything but a UUID is ignored');
  const blocked = createMemory(localStorageBackend(() => { throw new DOMException('denied', 'SecurityError'); }));
  assert.doesNotThrow(() => blocked.remember('00000000-0000-4000-8000-000000000041'));
  assert.equal(blocked.lastOperationId(), null);
  assert.doesNotThrow(() => blocked.forget());
});

// ---- pre-sign gate ----------------------------------------------------------------------

test('pre-sign: the mint fixture passes checks 1 to 7 in a matching context, and check 8 always fails (DG-1, DG-2)', () => {
  const response = fixture('deposit-v1', 'variants/mint.json');
  const context = {
    response,
    runtime,
    sessionOwner: OWNER,
    wallet: { chainId: 4663, account: OWNER },
    monoNowMs: 5_000,
    walletStepDeadlineMono: 25_000,
    summaryAcknowledged: true,
    handoff: DISABLED_WALLET_HANDOFF,
  };
  const result = checkPreSign(context);
  assert.deepEqual(result.rows.filter((row) => !row.ok).map((row) => row.id), ['handoff']);
  assert.equal(result.ok, false, 'never ok in this build');
  const failing = (patch) => checkPreSign({ ...context, ...patch }).rows.filter((row) => !row.ok).map((row) => row.id);
  assert.deepEqual(failing({ wallet: { chainId: 1, account: OWNER } }), ['chain', 'handoff']);
  assert.deepEqual(failing({ wallet: { chainId: 4663, account: FOREIGN } }), ['account', 'handoff']);
  assert.deepEqual(failing({ sessionOwner: FOREIGN }), ['account', 'handoff']);
  assert.deepEqual(failing({ monoNowMs: 25_000 }), ['fresh', 'handoff']);
  assert.deepEqual(failing({ walletStepDeadlineMono: null }), ['fresh', 'handoff']);
  assert.deepEqual(failing({ summaryAcknowledged: false }), ['summary', 'handoff']);
  const noStep = { ...clone(response), walletStep: null };
  assert.ok(failing({ response: noStep }).includes('wallet_step'));
});

test('pre-sign: a v2 step with its token reviews reversed is refused by the package checks (T18)', () => {
  const response = fixture('deposit-v1', 'variants/reviewed-proxy.json');
  const base = { runtime, sessionOwner: OWNER, wallet: { chainId: 4663, account: OWNER }, monoNowMs: 0, walletStepDeadlineMono: 1, summaryAcknowledged: true, handoff: DISABLED_WALLET_HANDOFF };
  assert.deepEqual(checkPreSign({ ...base, response }).rows.filter((row) => !row.ok).map((row) => row.id), ['handoff']);
  const reversed = clone(response);
  reversed.walletStep.admission.tokenReviews.reverse();
  const rows = checkPreSign({ ...base, response: reversed }).rows;
  assert.equal(rows.find((row) => row.id === 'response').ok, false);
  assert.equal(rows.find((row) => row.id === 'wallet_step_valid').ok, false);
  assert.equal(runtime.validateWalletStep(reversed.operation.selection, reversed.operation.owner, reversed.walletStep), false);
});
