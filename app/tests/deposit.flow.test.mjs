/**
 * The deposit flow (#40/#44) driven through every lab scenario over the
 * fixture transport: the complete list of automatic calls (boot, and one get
 * after a conflict), recovery after a reload or a fresh login, no automatic
 * prepare, create or mint after any denial, the latch, owner binding at boot
 * and on open, a wallet step handed through unchanged, the handoff window on
 * the monotonic clock, and Prepare structurally off without a wallet handoff.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, depositRuntime as runtime, depositSource, fakePort, fixtureText, flush } from './support/consumer-fakes.mjs';
import { FIXTURES } from './support/session-fixtures.mjs';

const { createDepositFlow, blockingOperation } = build('deposit/flow');
const { createDepositClient } = build('deposit/client');
const { createFixtureTransport, reply } = build('deposit/fixtureTransport');
const { createMemory, inMemoryBackend } = build('deposit/memory');
const { DISABLED_WALLET_HANDOFF } = build('deposit/handoff');
const { createFixtureSessionPort, FIXTURE_CSRF, FIXTURE_OWNER } = build('deposit/fixtures/fixtureSession');
const { createFixtureClock } = build('deposit/fixtures/fixtureClock');
const { scenarios } = build('deposit/fixtures/scenarios');
const { listBody, OPERATION_ID, withoutStep } = build('deposit/fixtures/derive');
const { presentOperation } = build('deposit/present');
const { checkPreSign } = build('deposit/presign');
const { ERR2, DEPOSIT_ERROR_UI } = build('deposit/errors');
const { createSessionController } = build('session/controller');
const { createSessionPort } = build('session/port');
const { LATCH_COPY, PREPARE_OFF_WITHOUT_HANDOFF } = build('deposit/copy');

const ALL = scenarios(depositSource);
const SCENARIOS = Object.fromEntries(ALL.map((scenario) => [scenario.id, scenario]));
const WALL_2027 = Date.parse('2027-01-15T00:05:00Z');

async function settle() {
  for (let i = 0; i < 25; i += 1) await flush();
}

function lab(id, { session = createFixtureSessionPort(), wallMs = WALL_2027 } = {}) {
  const scenario = SCENARIOS[id];
  assert.ok(scenario, id);
  const fixture = createFixtureTransport({ csrf: FIXTURE_CSRF });
  scenario.script(fixture);
  const transport = scenario.transportKind === 'http' ? { kind: 'http', send: (...args) => fixture.send(...args) } : fixture;
  const memory = createMemory(inMemoryBackend());
  if (scenario.remembered) memory.remember(scenario.remembered);
  const clock = createFixtureClock({ wallMs });
  const client = createDepositClient({ transport, runtime, session });
  const flow = createDepositFlow({ client, session, memory, clock, handoff: DISABLED_WALLET_HANDOFF });
  const stop = flow.start();
  const h = {
    stop,
    scenario,
    fixture,
    flow,
    memory,
    session,
    clock,
    routes: () => fixture.calls().map((call) => call.route),
    count: (route) => fixture.calls(route).length,
    state: () => flow.getState(),
    async act(action, extra = {}) {
      flow.dispatch({ t: 'user', action, ...extra });
      await settle();
    },
    view(extra = {}) {
      const { current, latched } = flow.getState();
      return presentOperation(current.op, current.walletStep, {
        monoNowMs: clock.monoMs(),
        walletStepDeadlineMono: current.walletStepDeadlineMono,
        issueWalletStepAllowed: flow.issueWalletStepAllowed,
        latched: Boolean(latched[current.op.id]),
        busy: false,
        ...extra,
      });
    },
  };
  return h;
}

test('every lab scenario boots with exactly the calls it scripted, and none it did not', async () => {
  assert.ok(ALL.length >= 45, `${ALL.length} scenarios`);
  for (const scenario of ALL) {
    const h = lab(scenario.id);
    await settle();
    assert.equal(h.state().phase, 'ready', scenario.id);
    assert.deepEqual(h.fixture.unscripted(), [], `${scenario.id} sent something unscripted`);
    assert.equal(h.count('prepare'), 0, `${scenario.id} prepared on its own`);
    assert.equal(h.count('create'), 0);
  }
});

test('boot reconciles only outstanding operations on the first page, once each, with their own version (DF-1, REC-2, T22)', async () => {
  const h = lab('boot-reconcile');
  await settle();
  assert.deepEqual(h.routes(), ['list', 'reconcile']);
  assert.deepEqual(h.fixture.calls('reconcile')[0].body, { intentId: '00000000-0000-4000-8000-000000000051', version: 2 });
  assert.equal(h.state().items.length, 4);
  assert.equal(h.state().current, null, 'nothing is opened without a remembered id');
});

test('a reload with a remembered outstanding operation: list, get, then one reconcile with the version get returned', async () => {
  const h = lab('variant:pending');
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get', 'reconcile']);
  assert.deepEqual(h.fixture.calls('reconcile')[0].body, { intentId: OPERATION_ID, version: 2 });
  assert.equal(h.view().kind, 'pending');
  const closed = lab('variant:confirmed');
  await settle();
  assert.deepEqual(closed.routes(), ['list', 'get'], 'a closed operation is never reconciled on load');
});

test('a confirmed approval back in draft does not prepare the next step on its own (DF-2, T14, SM-4)', async () => {
  const h = lab('derived:draft_after_approval');
  await settle();
  h.clock.advance(3_600_000);
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get']);
  const prepare = h.view().actions.find((action) => action.id === 'prepare');
  assert.deepEqual([prepare.label, prepare.enabled], ['Prepare next step', true], 'the user may ask for it');
});

test('an admission denial latches Prepare off: one prepare, no retry, no create, no new mint (rugged97, ADM:56, T13)', async () => {
  const h = lab('admission-denied');
  await settle();
  await h.act('prepare');
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.state().latched[OPERATION_ID], 'deposit_admission_required');
  assert.ok(h.state().notice.text.includes(ERR2));
  await h.act('prepare');
  await h.act('reopen');
  h.clock.advance(3_600_000);
  await settle();
  assert.equal(h.count('prepare'), 1, 'the denial is never turned into another attempt');
  assert.equal(h.count('create'), 0);
  const prepare = h.view().actions.find((action) => action.id === 'prepare');
  assert.deepEqual([prepare.enabled, prepare.reason], [false, LATCH_COPY]);
});

test('token changed on re-delivery: stopped, latched, nothing to sign; the reservation stays held (REC-3)', async () => {
  const h = lab('token-changed');
  await settle();
  await h.act('reopen');
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.state().latched[OPERATION_ID], 'deposit_token_changed');
  assert.equal(h.state().current.walletStep, null);
  assert.match(h.state().notice.text, /don't sign anything/);
  assert.equal(h.view().kind, 'step_reserved');
  assert.equal(h.view().actions.find((action) => action.id === 'reopen').enabled, false);
});

test('an expired handoff on re-delivery says the nonce is still held; session_required reaches the session port once', async () => {
  const expired = lab('artifact-expired');
  await settle();
  await expired.act('reopen');
  assert.match(expired.state().notice.text, /reservation for nonce 5 is still held/);
  const session = createFixtureSessionPort();
  const ended = lab('session-required', { session });
  await settle();
  await ended.act('prepare');
  assert.deepEqual(session.denials(), [{ code: 'session_required', epoch: 1 }]);
  assert.equal(ended.count('prepare'), 1);
});

/** The pre-sign gate's freshness row for what the flow holds now. */
const freshRow = (h) =>
  checkPreSign({
    response: h.state().current.prepareResponse,
    runtime,
    sessionOwner: FIXTURE_OWNER,
    wallet: { chainId: 4663, account: FIXTURE_OWNER },
    monoNowMs: h.clock.monoMs(),
    walletStepDeadlineMono: h.state().current.walletStepDeadlineMono,
    summaryAcknowledged: true,
    handoff: DISABLED_WALLET_HANDOFF,
  }).rows.find((row) => row.id === 'fresh').ok;

test('the wallet step reaches the state exactly as the package ships it, and goes stale on the monotonic clock (DF-7, T15)', async () => {
  const h = lab('variant:mint');
  await settle();
  assert.equal(h.view().kind, 'draft_new', 'booted as it stood before the step was issued');
  const sent = h.clock.monoMs();
  await h.act('prepare');
  const raw = JSON.parse(fixtureText('deposit-v1', 'variants/mint.json'));
  assert.deepEqual(h.state().current.walletStep, raw.walletStep);
  assert.deepEqual(h.state().current.prepareResponse, raw);
  assert.equal(h.state().current.walletStepDeadlineMono, sent + 30_000 - 5_000);
  assert.equal(h.view().kind, 'step_ready');
  assert.equal(h.memory.lastOperationId(), OPERATION_ID, 'only the id is remembered');
  let heard = 0;
  h.flow.subscribe(() => (heard += 1));
  h.clock.advance(25_000);
  assert.ok(heard >= 1, 'the flow re-renders when the handoff goes stale; nothing is sent');
  assert.equal(h.view().kind, 'handoff_expired');
  assert.equal(h.count('prepare'), 1);
});

test('a late re-delivery keeps the deadline set at issue: 30 s mint, prepare at t=0, close/open/re-open at t=20, stale by t=31 (rugged97, P2 on #72)', async () => {
  const mintText = fixtureText('deposit-v1', 'variants/mint.json');
  const h = lab('variant:mint');
  await settle();
  await h.act('prepare');
  assert.equal(h.clock.monoMs(), 0);
  assert.equal(h.state().current.walletStepDeadlineMono, 25_000, 'a fresh issuance: 30 s from the send, less the margin');
  await h.act('close');
  h.clock.advance(20_000);
  // The service answers the second prepare with the persisted step: same
  // version, same artifact, same expiration.
  h.fixture.script('get', reply(200, withoutStep(JSON.parse(mintText))));
  h.fixture.script('prepare', reply(200, mintText));
  await h.act('open', { id: OPERATION_ID });
  await h.act('reopen');
  assert.equal(h.count('prepare'), 2);
  assert.equal(h.state().current.walletStepDeadlineMono, 25_000, 'the known deadline, never 20 s plus the original lifetime');
  assert.equal(h.view().kind, 'step_ready');
  h.clock.advance(11_000);
  assert.equal(h.clock.monoMs(), 31_000, "past the service's own expiry");
  assert.equal(h.view().kind, 'handoff_expired');
  assert.equal(freshRow(h), false, 'the pre-sign freshness check fails');
  assert.deepEqual(h.fixture.unscripted(), []);
});

test('after a reload a re-delivered step is never fresh: its remaining window cannot be established here (rugged97, P2 on #72)', async () => {
  const h = lab('redelivery-after-reload');
  await settle();
  assert.equal(h.view().kind, 'step_reserved');
  await h.act('reopen');
  assert.equal(h.count('prepare'), 1);
  assert.deepEqual(h.state().current.walletStep, JSON.parse(fixtureText('deposit-v1', 'variants/mint.json')).walletStep, 'the same step, unchanged');
  assert.equal(h.state().current.walletStepDeadlineMono, null, 'no deadline is invented for a step this page did not issue');
  assert.equal(h.view().kind, 'handoff_unconfirmed');
  assert.equal(h.view().step, null, 'nothing is offered for review');
  assert.equal(freshRow(h), false);
  h.clock.advance(3_600_000);
  await settle();
  assert.equal(h.view().kind, 'handoff_unconfirmed');
  assert.equal(h.count('prepare'), 1, 'and nothing is asked again on its own');
});

test('Check allowances answering with a newer operation drops the prepared step: version 2 / nonce 5 approval, then version 5 with a Permit2 step at nonce 6 (rugged97, P2 on #72)', async () => {
  const h = lab('allowances-newer-operation');
  await settle();
  await h.act('prepare');
  assert.equal(h.view().kind, 'step_ready');
  assert.deepEqual([h.state().current.op.version, h.state().current.walletStep.transaction.nonceRaw], [2, '5']);
  const prepared = h.state().current.prepareResponse;
  await h.act('allowances');
  const { current } = h.state();
  assert.deepEqual([current.op.version, current.op.history.at(-1).kind, current.op.history.at(-1).nonceRaw], [5, 'permit2_approval', '6']);
  assert.deepEqual([current.walletStep, current.prepareResponse, current.prepareSentMono, current.walletStepDeadlineMono], [null, null, null, null]);
  assert.ok(current.allowances, 'the allowance report is still shown');
  assert.equal(h.view().kind, 'step_reserved', 'the step the server holds now, re-opened only by hand');
  assert.equal(freshRow(h), false);
  const gate = checkPreSign({ response: current.prepareResponse, runtime, sessionOwner: FIXTURE_OWNER, wallet: { chainId: 4663, account: FIXTURE_OWNER }, monoNowMs: h.clock.monoMs(), walletStepDeadlineMono: current.walletStepDeadlineMono, summaryAcknowledged: true, handoff: DISABLED_WALLET_HANDOFF });
  assert.deepEqual(gate.rows.filter((row) => !row.ok).map((row) => row.id).slice(0, 2), ['response', 'wallet_step'], 'nothing left to check against');
  // The pairing the old state kept, the displayed operation with the held step, fails the shared prepare validator.
  const combined = (() => {
    try {
      return runtime.validateResponse('prepare', { ...prepared, operation: current.op });
    } catch {
      return false;
    }
  })();
  assert.equal(Boolean(combined), false);
  assert.equal(h.count('prepare'), 1);
  assert.deepEqual(h.fixture.unscripted(), []);
});

test('Check allowances answering with the same version keeps the prepared step and its deadline', async () => {
  const h = lab('variant:mint');
  await settle();
  await h.act('prepare');
  const deadline = h.state().current.walletStepDeadlineMono;
  await h.act('allowances');
  assert.equal(h.view().kind, 'step_ready');
  assert.equal(h.state().current.walletStepDeadlineMono, deadline);
  assert.ok(h.state().current.allowances);
  assert.equal(freshRow(h), true);
});

test('a version conflict reads the operation once and never replays the cancel (DF-5, REC-4, T16)', async () => {
  const h = lab('version-conflict');
  await settle();
  await h.act('cancel');
  assert.deepEqual(h.routes(), ['list', 'get', 'cancel', 'get']);
  assert.equal(h.state().current.op.state, 'cancelled');
  assert.match(h.state().notice.text, /changed in another tab/);
});

test('owner busy points at the blocking operation and offers nothing else (T17)', async () => {
  const h = lab('owner-busy');
  await settle();
  await h.act('prepare');
  assert.equal(h.state().blockerId, '00000000-0000-4000-8000-000000000050');
  assert.equal(blockingOperation(h.state().items, OPERATION_ID)?.id, '00000000-0000-4000-8000-000000000050', 'the same rule a create refusal uses');
  assert.equal(blockingOperation(h.state().items, '00000000-0000-4000-8000-000000000050'), null, 'an operation never blocks itself');
  assert.equal(h.count('prepare'), 1);
  await h.act('open', { id: h.state().blockerId });
  assert.equal(h.state().current.op.id, '00000000-0000-4000-8000-000000000050');
});

test('a failed call the page made on its own is marked automatic, a user action is not; a switched-off service is never described as a deployment', async () => {
  const booted = async (script) => {
    const session = createFixtureSessionPort();
    const fixture = createFixtureTransport({ csrf: FIXTURE_CSRF });
    script(fixture);
    const flow = createDepositFlow({ client: createDepositClient({ transport: fixture, runtime, session }), session, memory: createMemory(inMemoryBackend()), clock: createFixtureClock({ wallMs: WALL_2027 }), handoff: DISABLED_WALLET_HANDOFF });
    flow.start();
    await settle();
    return { flow, fixture };
  };
  const scripts = {
    'route_not_available': (fixture) => fixture.script('list', reply(404, { error: 'route_not_available' })),
    'no Worker route': (fixture) => fixture.script('list', reply(404, 'not found', { contract: null, contentType: 'text/plain' })),
    'a boot reconcile': (fixture) => {
      fixture.script('list', reply(200, listBody([withoutStep(JSON.parse(fixtureText('deposit-v1', 'variants/mint.json'))).operation])));
      fixture.script('reconcile', reply(runtime.ERROR_STATUS_BY_CODE.deposit_reconciliation_unavailable, { error: 'deposit_reconciliation_unavailable' }));
    },
  };
  for (const [label, script] of Object.entries(scripts)) {
    const { flow, fixture } = await booted(script);
    const { phase, notice } = flow.getState();
    assert.deepEqual([phase, notice.automatic], ['ready', true], label);
    assert.doesNotMatch(notice.text, /enabled|deployment|beta/i, label);
    assert.equal(fixture.calls('prepare').length + fixture.calls('create').length, 0, label);
  }
  assert.equal((await booted(scripts.route_not_available)).flow.getState().items.length, 0, 'the list stays empty, nothing else');
  const foreign = lab('foreign-list');
  await settle();
  assert.equal(foreign.state().notice.automatic, true, 'a boot list about another owner');
  const acted = lab('admission-denied');
  await settle();
  assert.equal(acted.state().notice, null);
  await acted.act('prepare');
  assert.equal(acted.state().notice.automatic, false, 'a refused prepare is said in words');
  const conflict = lab('version-conflict');
  await settle();
  await conflict.act('cancel');
  assert.equal(conflict.state().notice.automatic, false, 'the get after a user conflict belongs to the action');
});

test('owner binding at boot: a foreign remembered operation is forgotten silently; opened by hand it is refused (DC-7, DF-13)', async () => {
  const h = lab('foreign-get');
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get']);
  assert.equal(h.memory.lastOperationId(), null);
  assert.equal(h.state().notice, null, 'no archive or owner copy at boot');
  assert.equal(h.state().current, null);
  await h.act('open', { id: OPERATION_ID });
  assert.match(h.state().notice.text, /about another account, so nothing from it is shown or remembered/);
  assert.equal(h.state().current, null);
  assert.equal(h.memory.lastOperationId(), null);
});

test('a first list page naming another owner is refused whole: nothing listed, nothing reconciled', async () => {
  const h = lab('foreign-list');
  await settle();
  assert.deepEqual(h.routes(), ['list']);
  assert.deepEqual(h.state().items, []);
  assert.match(h.state().notice.text, /another account/);
});

test('not found: at boot a silent clear; opened by hand, the allowance warning names what this page has seen (ALW-7, DF-13)', async () => {
  const session = createFixtureSessionPort();
  const fixture = createFixtureTransport({ csrf: FIXTURE_CSRF });
  fixture.script('list', reply(200, listBody([])));
  fixture.script('get', reply(404, { error: 'deposit_not_found' }));
  const memory = createMemory(inMemoryBackend());
  memory.remember(OPERATION_ID);
  const flow = createDepositFlow({ client: createDepositClient({ transport: fixture, runtime, session }), session, memory, clock: createFixtureClock({ wallMs: WALL_2027 }), handoff: DISABLED_WALLET_HANDOFF });
  flow.start();
  await settle();
  assert.equal(memory.lastOperationId(), null);
  assert.equal(flow.getState().notice, null);
  fixture.script('get', reply(404, { error: 'deposit_not_found' }));
  flow.dispatch({ t: 'user', action: 'open', id: OPERATION_ID });
  await settle();
  assert.match(flow.getState().notice.text, /allowances may still exist\. Check them in your wallet\./);

  const known = lab('variant:confirmed');
  await settle();
  await known.act('allowances');
  assert.equal(known.state().current.allowances.observations.length, 2);
  assert.ok(known.state().knownPairs.some((pair) => pair.currency === '0x1111111111111111111111111111111111111111'));
  known.fixture.script('reconcile', reply(404, { error: 'deposit_not_found' }));
  await known.act('check_status');
  assert.match(known.state().notice.text, /an allowance may still exist: 0x1111111111111111111111111111111111111111 to 0x000000000022d473030f116ddee9f6b43ac78ba3/);
  assert.equal(known.state().current, null);
});

test('without a wallet handoff, a live transport kind cannot issue a wallet step at all (DF-12, R#7)', async () => {
  const h = lab('http-activation');
  await settle();
  assert.equal(h.flow.issueWalletStepAllowed, false);
  await h.act('reopen');
  await h.act('prepare');
  assert.equal(h.count('prepare'), 0, 'nothing reserves a nonce the app could not complete');
  const reopen = h.view().actions.find((action) => action.id === 'reopen');
  assert.deepEqual([reopen.enabled, reopen.reason], [false, PREPARE_OFF_WITHOUT_HANDOFF]);
});

test('a reported hash is checked and lowercased, and is only a hint', async () => {
  const h = lab('report-hash');
  await settle();
  await h.act('report', { hash: '0x1234' });
  assert.equal(h.count('report'), 0);
  await h.act('report', { hash: `0x${'AB'.repeat(32)}` });
  assert.deepEqual(h.fixture.calls('report')[0].body, { intentId: OPERATION_ID, version: 2, transactionHash: `0x${'ab'.repeat(32)}` });
  assert.equal(h.view().kind, 'pending');
});

test('no background loop: an hour later nothing more was sent (DEP-NEVER-10)', async () => {
  const h = lab('variant:pending');
  await settle();
  const before = h.routes().length;
  h.clock.advance(3_600_000);
  await settle();
  assert.equal(h.routes().length, before);
});

test('a session change clears everything shown and remembered; a fresh admitted login recovers the reserved step by user action only (REC-1, REC-2)', async () => {
  const port = fakePort();
  const h = lab('redelivery-after-reload', { session: port });
  await settle();
  assert.equal(h.view().kind, 'step_reserved');
  port.set({ kind: 'signed_out' });
  await settle();
  assert.deepEqual([h.state().phase, h.state().current, h.state().items], ['ineligible', null, []]);
  assert.equal(h.memory.lastOperationId(), null);

  // The same owner signs in again: a new epoch. The lab re-remembers the id,
  // as the live consumer would still hold it from before the switch.
  h.memory.remember(OPERATION_ID);
  SCENARIOS['redelivery-after-reload'].script(h.fixture);
  port.set({ kind: 'signed_in', owner: '0xabababababababababababababababababababab', chainId: 4663, epoch: 2, connectorUid: 'uid-a' });
  await settle();
  assert.deepEqual(h.routes().slice(3), ['list', 'get', 'reconcile']);
  assert.equal(h.view().kind, 'step_reserved', 'the reservation is still held after the new login');
  assert.equal(h.count('prepare'), 0);
  await h.act('reopen');
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.view().kind, 'handoff_unconfirmed', 'the same step is re-delivered only when the user asks, and never as fresh: this page did not issue it');
});

// ---- session denials at boot (rugged97, P2 on #72) --------------------------

const DENIALS = ['session_required', 'csrf_invalid', 'account_unsupported'];
const denied = (code) => reply(runtime.ERROR_STATUS_BY_CODE[code], { error: code });
const DRAFT = () => JSON.parse(fixtureText('deposit-v1', 'responses/get.json'));
const RESERVED = () => withoutStep(JSON.parse(fixtureText('deposit-v1', 'variants/mint.json')));

/** A flow over `port` with a remembered operation, booted, its transport scripted by `script`. */
function booted(port, script, { csrf = 'c'.repeat(43) } = {}) {
  const fixture = createFixtureTransport({ csrf });
  script(fixture);
  const memory = createMemory(inMemoryBackend());
  memory.remember(OPERATION_ID);
  const flow = createDepositFlow({ client: createDepositClient({ transport: fixture, runtime, session: port }), session: port, memory, clock: createFixtureClock({ wallMs: WALL_2027 }), handoff: DISABLED_WALLET_HANDOFF });
  flow.start();
  return { fixture, flow, memory, routes: () => fixture.calls().map((call) => call.route) };
}

const BOUNDARIES = {
  'the first list': {
    script: (fixture, code) => fixture.script('list', denied(code)),
    routes: ['list'],
  },
  'the remembered get': {
    script(fixture, code) {
      fixture.script('list', reply(200, listBody([RESERVED().operation])));
      fixture.script('get', denied(code));
      fixture.script('reconcile', reply(200, RESERVED()));
    },
    routes: ['list', 'get'],
  },
  'the one get after a conflict': {
    script(fixture, code) {
      fixture.script('list', reply(200, listBody([DRAFT().operation])));
      fixture.script('get', reply(200, DRAFT()), denied(code));
      fixture.script('cancel', reply(409, { error: 'deposit_version_conflict' }));
    },
    action: 'cancel',
    routes: ['list', 'get', 'cancel', 'get'],
  },
};

test('a session denial at the first list, the remembered get or the get after a conflict reaches the session port, as from a user action (rugged97, P2 on #72)', async () => {
  for (const [where, boundary] of Object.entries(BOUNDARIES)) {
    for (const code of DENIALS) {
      const port = fakePort();
      const h = booted(port, (fixture) => boundary.script(fixture, code));
      await settle();
      if (boundary.action) {
        h.flow.dispatch({ t: 'user', action: boundary.action });
        await settle();
      }
      assert.deepEqual(port.denials, [{ code, epoch: 1 }], `${where}: ${code} is told to the port once`);
      assert.deepEqual(h.routes(), boundary.routes, `${where}: ${code} stops there`);
      assert.equal(h.flow.getState().notice.text, DEPOSIT_ERROR_UI[code].copy, `${where}: ${code} says so`);
      assert.equal(h.memory.lastOperationId(), OPERATION_ID, `${where}: ${code} is not a silent forget`);
      assert.equal(h.fixture.calls('prepare').length + h.fixture.calls('create').length, 0);
    }
  }
});

const REAL_CSRF = 'k'.repeat(43);

/** B2's real controller behind the real port, signed in as the fixtures' owner. Session API calls stay pending and are recorded. */
async function realSession() {
  const calls = [];
  const api = Object.fromEntries(['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'].map((route) => [route, () => new Promise((resolve) => calls.push({ route, resolve }))]));
  const controller = createSessionController({
    api,
    sign: async () => ({ ok: false, reason: 'user_rejected' }),
    clearPrivate() {},
    storePrivate() {},
    broadcast() {},
    broadcastRenewal() {},
    isVisible: () => true,
    now: () => 0,
    setTimer: () => () => {},
    origin: 'https://app.example.invalid',
    checksum: (address) => address,
  });
  const port = createSessionPort(controller);
  controller.dispatch({ type: 'identity', identity: { kind: 'connected', connectorUid: 'uid-a', connectorName: 'Test Wallet A', address: FIXTURE_OWNER, chainId: 4663 } });
  calls.find((call) => call.route === 'me').resolve({ ok: true, route: 'me', body: { ...FIXTURES.responses.me, owner: { address: FIXTURE_OWNER, chainId: 4663 }, csrfToken: REAL_CSRF }, serverTime: null });
  await flush();
  assert.equal(port.getSnapshot().kind, 'signed_in');
  return { port, sessionCalls: (route) => calls.filter((call) => call.route === route).length, otherCalls: () => calls.filter((call) => call.route !== 'me').map((call) => call.route) };
}

test("with B2's real controller, a boot list refused as session_required re-reads me once, and the boot goes no further (rugged97, P2 on #72)", async () => {
  const s = await realSession();
  const h = booted(s.port, (fixture) => fixture.script('list', denied('session_required')), { csrf: REAL_CSRF });
  await settle();
  assert.equal(s.sessionCalls('me'), 2, 'the denial re-reads me once');
  assert.deepEqual(s.otherCalls(), [], 'no logout, no challenge, no signature');
  assert.deepEqual(h.routes(), ['list'], 'the boot goes no further');
  // B2 keeps the signed-in view while it re-reads me (machine.ts: a recheck
  // is not a sign-in), so the page stays on the notice until me answers.
  const state = h.flow.getState();
  assert.deepEqual([state.phase, state.items, state.current], ['ready', [], null]);
  assert.equal(state.notice.text, DEPOSIT_ERROR_UI.session_required.copy);
});

test("with B2's real controller, a remembered get refused as account_unsupported signs the tab out and locks the owner; nothing later in the boot undoes it (rugged97, P2 on #72)", async () => {
  const s = await realSession();
  const h = booted(
    s.port,
    (fixture) => {
      fixture.script('list', reply(200, listBody([RESERVED().operation])));
      fixture.script('get', denied('account_unsupported'));
      fixture.script('reconcile', reply(200, RESERVED()));
    },
    { csrf: REAL_CSRF },
  );
  await settle();
  assert.equal(s.sessionCalls('logout'), 1, 'signed out');
  assert.equal(s.port.getSnapshot().kind, 'account_unsupported', 'the owner is locked for this page');
  assert.deepEqual(h.routes(), ['list', 'get'], 'no reconcile after the denial');
  const state = h.flow.getState();
  assert.deepEqual([state.phase, state.block, state.items, state.current], ['ineligible', 'account_unsupported', [], null]);
  assert.equal(state.notice.text, DEPOSIT_ERROR_UI.account_unsupported.copy);
});

test('pagination loads the next page only when asked (T20)', async () => {
  const h = lab('list-more');
  await settle();
  assert.deepEqual([h.state().items.length, h.state().hasMore], [2, true]);
  await h.act('load_more');
  assert.deepEqual(h.fixture.calls('list')[1].body, { limit: 20, before: '00000000-0000-4000-8000-000000000062' });
  assert.deepEqual([h.state().items.length, h.state().hasMore], [3, false]);
});

test('what the lab shows does not depend on the device clock (DB-14)', async () => {
  const render = async (wallMs) => {
    const out = [];
    for (const scenario of ALL.filter((entry) => entry.remembered)) {
      const h = lab(scenario.id, { wallMs });
      await settle();
      if (h.state().current) out.push(JSON.stringify(h.view()));
    }
    return out;
  };
  assert.deepEqual(await render(Date.parse('2026-09-11T12:00:00Z')), await render(Date.parse('2028-06-01T00:00:00Z')));
});

function deferredFlow() {
  const calls = [];
  const client = { transportKind: 'fixture', ...Object.fromEntries(['list', 'get', 'reconcile', 'prepare', 'create', 'cancel', 'report', 'allowances'].map((route) => [route, (body, options) => new Promise((resolve) => calls.push({ route, body, signal: options.signal, resolve: (data) => resolve({ ok: true, route, data }) }))])) };
  const memory = createMemory(inMemoryBackend());
  memory.remember(OPERATION_ID);
  const flow = createDepositFlow({ client, session: createFixtureSessionPort(), memory, clock: createFixtureClock({ wallMs: WALL_2027 }), handoff: DISABLED_WALLET_HANDOFF });
  return { calls, flow, routes: () => calls.map((call) => call.route) };
}

test('leaving Setup aborts its read, drops a late answer and remount recovers only list/get', async () => {
  const h = deferredFlow();
  const oldStop = h.flow.start();
  assert.deepEqual(h.routes(), ['list']);
  oldStop();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].resolve(listBody([RESERVED().operation]));
  await settle();
  assert.deepEqual(h.routes(), ['list'], 'the abandoned boot must not advance to get/reconcile');
  const nextStop = h.flow.start();
  assert.deepEqual(h.routes(), ['list', 'list']);
  oldStop();
  assert.equal(h.calls[1].signal.aborted, false, 'old cleanup does not stop the new subscription');
  h.calls[1].resolve(listBody([RESERVED().operation]));
  await settle();
  h.calls[2].resolve(RESERVED());
  await settle();
  assert.equal(h.flow.getState().phase, 'ready');
  assert.equal(h.flow.getState().busy, null);
  assert.deepEqual(h.routes(), ['list', 'list', 'get'], 'remount never repeats an automatic mutation');
  nextStop();
});

test('an interrupted user prepare is never repeated or adopted after remount', async () => {
  const h = deferredFlow();
  const stop = h.flow.start();
  h.calls[0].resolve(listBody([DRAFT().operation]));
  await settle();
  h.calls[1].resolve(DRAFT());
  await settle();
  h.flow.dispatch({ t: 'user', action: 'prepare' });
  assert.deepEqual(h.routes(), ['list', 'get', 'prepare']);
  stop();
  assert.equal(h.calls[2].signal.aborted, true);
  h.calls[2].resolve(JSON.parse(fixtureText('deposit-v1', 'variants/mint.json')));
  await settle();
  assert.equal(h.flow.getState().current.walletStep, null, 'an abandoned mutation answer cannot install a wallet handoff');
  h.flow.dispatch({ t: 'user', action: 'prepare' });
  assert.equal(h.calls.length, 3, 'an unmounted flow sends nothing');
  const again = h.flow.start();
  h.calls[3].resolve(listBody([RESERVED().operation]));
  await settle();
  h.calls[4].resolve(RESERVED());
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get', 'prepare', 'list', 'get']);
  assert.equal(h.flow.getState().current.walletStep, null);
  assert.equal(h.flow.getState().current.walletStepDeadlineMono, null, 'the server reservation is not a freshly issued step');
  assert.equal(h.flow.getState().busy, null);
  again();
});

test('a completed boot reconciles once; overlapping subscribers share it and a later mount reads only', async () => {
  const h = deferredFlow();
  const a = h.flow.start();
  const b = h.flow.start();
  a();
  assert.equal(h.calls[0].signal.aborted, false, 'the remaining subscriber still owns the boot');
  h.calls[0].resolve(listBody([RESERVED().operation]));
  await settle();
  h.calls[1].resolve(RESERVED());
  await settle();
  h.calls[2].resolve(RESERVED());
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get', 'reconcile']);
  b();
  const c = h.flow.start();
  h.calls[3].resolve(listBody([RESERVED().operation]));
  await settle();
  h.calls[4].resolve(RESERVED());
  await settle();
  assert.deepEqual(h.routes(), ['list', 'get', 'reconcile', 'list', 'get']);
  c();
});

test('remount preserves the original handoff deadline and denial latch without a fresh prepare', async () => {
  const h = lab('variant:mint');
  await settle();
  await h.act('prepare');
  const prepared = h.state().current;
  const deadline = prepared.walletStepDeadlineMono;
  assert.ok(deadline > h.clock.monoMs());
  let notifications = 0;
  h.flow.subscribe(() => notifications++);
  h.stop();
  const afterStop = notifications;
  h.clock.advance(deadline - h.clock.monoMs() + 1);
  assert.equal(notifications, afterStop, 'the deadline timer is cancelled while the flow is unmounted');
  h.fixture.script('list', reply(200, listBody([prepared.op])));
  h.fixture.script('get', reply(200, { ...DRAFT(), operation: prepared.op, walletStep: null }));
  const again = h.flow.start();
  await settle();
  assert.equal(h.state().current.walletStepDeadlineMono, deadline);
  assert.equal(h.view().kind, 'handoff_expired');
  assert.deepEqual(h.routes(), ['list', 'get', 'prepare', 'list', 'get']);
  assert.deepEqual(h.fixture.unscripted(), []);
  again();

  const denied = lab('admission-denied');
  await settle();
  await denied.act('prepare');
  const current = denied.state().current;
  denied.stop();
  denied.fixture.script('list', reply(200, listBody([current.op])));
  denied.fixture.script('get', reply(200, { ...DRAFT(), operation: current.op, walletStep: null }));
  const last = denied.flow.start();
  await settle();
  await denied.act('prepare');
  assert.equal(denied.state().latched[OPERATION_ID], 'deposit_admission_required');
  assert.equal(denied.count('prepare'), 1);
  assert.equal(denied.count('create'), 0);
  assert.equal(denied.count('reconcile'), 0);
  last();
});
