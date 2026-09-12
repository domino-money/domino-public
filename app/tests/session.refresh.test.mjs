/**
 * POST /api/session/v1/refresh: the request this client sends to renew a
 * session's 30-minute idle deadline (session-v1 README, backend/session_store.py
 * finish_private; an authenticated preview renews it too, finish_preview, and
 * GET me never does). It needs the session CSRF, answers with the same CSRF and
 * absolute expiry and a fresh account check, and rotates nothing, so every
 * tab of the browser keeps working with the CSRF it already holds.
 *
 * The machine's part (what each answer means) is walked as a pure function;
 * the controller's part (when to ask) runs with a fake clock, fake timers and
 * a visibility switch. The browser tests prove the same end to end.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { FIXTURES, runtime, siweMessage } from './support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const { reduce, initialMachine } = require('../.test-build/app/src/session/machine.js');
const { createSessionController, REFRESH_AFTER_MS, REFRESH_RETRY_MS, SESSION_IDLE_MS } = require('../.test-build/app/src/session/controller.js');

const ORIGIN = 'https://app.example.invalid';
const env = { origin: ORIGIN, checksum: getAddress };
const ADDR_A = FIXTURES.requests.challenge.address;
const ADDR_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const PREAUTH = 'p'.repeat(43);
const CSRF_A = 'a'.repeat(43);
const CSRF_B = 'b'.repeat(43);
const NOW = Date.parse('2026-09-10T12:00:00Z');
const MINUTE = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const wallet = (address, chainId = 4663) => ({ kind: 'connected', connectorUid: 'uid-a', connectorName: 'Test Wallet', address, chainId });
const ok = (route, body) => ({ ok: true, route, body, serverTime: null });
const code = (route, error, retryAfterS = null) => ({
  ok: false,
  route,
  failure: { kind: 'session_error', status: runtime.ERROR_STATUS_BY_CODE[error], code: error, retryAfterS },
  serverTime: null,
});
const broken = (route, kind, extra = {}) => ({ ok: false, route, failure: { kind, ...extra }, serverTime: null });
/** A session body in the refresh fixture's shape (identical to me's). */
const session = (address, csrf = CSRF_A, blockNumber = '123') => ({
  ...FIXTURES.responses.refresh,
  owner: { address: address.toLowerCase(), chainId: 4663 },
  csrfToken: csrf,
  validation: { ...FIXTURES.responses.refresh.validation, blockNumber },
});

test('the refresh fixtures are what this file answers with', () => {
  assert.deepEqual(FIXTURES.requests.refresh, {});
  assert.equal(runtime.validateRequest('refresh', {}), true);
  assert.equal(runtime.validateResponse('refresh', session(ADDR_A)), true);
  assert.equal(runtime.validateResponse('refresh', FIXTURES.responses.refresh), true);
});

// ---------------------------------------------------------------------------
// The machine: what a refresh answer means
// ---------------------------------------------------------------------------

function run(machine, ...events) {
  const effects = [];
  for (const event of events) {
    const step = reduce(machine, typeof event === 'function' ? event(machine) : event, env);
    machine = step.machine;
    effects.push(...step.effects);
  }
  return { machine, effects };
}
const result = (outcome) => (m) => ({ type: 'result', epoch: m.epoch, outcome });
const calls = (effects) => effects.filter((e) => e.type === 'call').map((e) => e.request);
const types = (effects) => effects.map((e) => e.type);

/** Connected as A, restored through me: signed in with CSRF_A. */
const signedIn = () => run(initialMachine, { type: 'identity', identity: wallet(ADDR_A) }, result(ok('me', session(ADDR_A))));
/** Signed in, with a refresh in flight. */
const refreshing = () => {
  const start = signedIn();
  const step = run(start.machine, { type: 'refresh' });
  return { ...step, before: start.machine };
};

test('machine: a refresh is sent only from a resting signed-in view, with the session CSRF', () => {
  const { machine, effects } = refreshing();
  assert.deepEqual(calls(effects), [{ route: 'refresh', csrf: CSRF_A }]);
  assert.equal(machine.view.status, 'signed_in', 'the view does not change while it runs');

  // Signed out, signing in, busy, another session, wrong network: nothing.
  const signedOut = run(initialMachine, { type: 'identity', identity: wallet(ADDR_A) }, result(code('me', 'session_required')));
  assert.deepEqual(run(signedOut.machine, { type: 'refresh' }).effects, []);
  const signingIn = run(signedOut.machine, { type: 'sign_in' });
  assert.deepEqual(run(signingIn.machine, { type: 'refresh' }).effects, []);
  assert.deepEqual(run(machine, { type: 'refresh' }).effects, [], 'never two at once');
  const other = run(initialMachine, { type: 'identity', identity: wallet(ADDR_B) }, result(ok('me', session(ADDR_A))));
  assert.equal(other.machine.view.status, 'other_session');
  assert.deepEqual(run(other.machine, { type: 'refresh' }).effects, [], 'never for a session this tab does not show');
  const checking = run(signedIn().machine, { type: 'recheck', cause: 'visible' });
  assert.deepEqual(run(checking.machine, { type: 'refresh' }).effects, []);
});

test('machine: a refresh that works keeps the epoch and scope, renews, and stores the fresh account check', () => {
  const { machine, before } = refreshing();
  const done = run(machine, result(ok('refresh', session(ADDR_A, CSRF_A, '456'))));
  assert.equal(done.machine.epoch, before.epoch, 'same session, same private scope');
  assert.deepEqual(done.machine.view, { status: 'signed_in', owner: ADDR_A.toLowerCase(), expiresAt: FIXTURES.responses.refresh.expiresAt });
  assert.deepEqual(types(done.effects), ['private_identity', 'schedule_expiry', 'renewed']);
  assert.equal(done.effects[0].identity.validation.blockNumber, '456');
  assert.equal(done.effects[1].fresh, true, 'the idle deadline is known again');
  assert.equal(done.machine.session.csrf, CSRF_A);
});

test('machine: refresh session_required signs out, clears private data and tells other tabs', () => {
  const { machine } = refreshing();
  const done = run(machine, result(code('refresh', 'session_required')));
  assert.deepEqual(done.machine.view, { status: 'signed_out', reason: 'session_ended' });
  assert.equal(done.machine.session, null);
  assert.deepEqual(types(done.effects), ['clear_private', 'cancel_expiry', 'broadcast']);
});

test('machine: a CSRF refusal re-reads me once and asks for no further refresh', () => {
  const { machine } = refreshing();
  const done = run(machine, result(code('refresh', 'csrf_invalid')));
  assert.deepEqual(done.effects[0], { type: 'refresh_failed', final: true, retryAfterS: null });
  assert.deepEqual(calls(done.effects), [{ route: 'me' }]);
  assert.equal(done.machine.view.status, 'signed_in', 'nothing changes on screen while me runs');
  // me shows the same session: signed in, nothing else sent.
  const same = run(done.machine, result(ok('me', session(ADDR_A))));
  assert.equal(same.machine.view.status, 'signed_in');
  assert.deepEqual(calls(same.effects), []);
  // me shows a new session for the same owner: its own epoch, old data dropped.
  const renewed = run(done.machine, result(ok('me', session(ADDR_A, CSRF_B))));
  assert.equal(renewed.machine.epoch, done.machine.epoch + 1);
  assert.ok(types(renewed.effects).includes('clear_private'));
  // me shows no session: signed out.
  const gone = run(done.machine, result(code('me', 'session_required')));
  assert.equal(gone.machine.view.status, 'signed_out');
});

test('machine: an outage keeps the session and its data, shows a notice, and lets the controller retry', () => {
  const outages = [
    code('refresh', 'session_store_unavailable'),
    code('refresh', 'account_check_unavailable'),
    code('refresh', 'upstream_unavailable'),
    code('refresh', 'upstream_timeout'),
    code('refresh', 'request_timeout'),
    code('refresh', 'session_rate_limited', 60),
    code('refresh', 'session_capacity_busy'),
    broken('refresh', 'network_error'),
    broken('refresh', 'timeout'),
    broken('refresh', 'gate_unavailable'),
    broken('refresh', 'not_routed', { status: 502 }),
  ];
  for (const outcome of outages) {
    const { machine } = refreshing();
    const done = run(machine, result(outcome));
    const label = JSON.stringify(outcome.failure);
    assert.equal(done.machine.view.status, 'signed_in', label);
    assert.equal(done.machine.view.notice, 'refresh_unavailable', label);
    assert.equal(done.machine.session.csrf, CSRF_A, label);
    assert.equal(done.machine.epoch, machine.epoch, label);
    assert.deepEqual(done.effects, [{ type: 'refresh_failed', final: false, retryAfterS: outcome.failure.retryAfterS ?? null }], label);
  }
});

test('machine: the notice stays through me and clears when a renewal works, here or in another tab', () => {
  const { machine } = refreshing();
  const failed = run(machine, result(code('refresh', 'session_store_unavailable')));
  const checked = run(failed.machine, { type: 'recheck', cause: 'expiry' }, result(ok('me', session(ADDR_A))));
  assert.equal(checked.machine.view.notice, 'refresh_unavailable', 'me says the session lives, not that it was renewed');
  const retried = run(checked.machine, { type: 'refresh' }, result(ok('refresh', session(ADDR_A))));
  assert.equal(retried.machine.view.notice, undefined);
  const elsewhere = run(failed.machine, { type: 'renewed_elsewhere' });
  assert.equal(elsewhere.machine.view.notice, undefined);
  assert.deepEqual(elsewhere.effects, []);
});

test('machine: a contract-code account found at refresh is revoked, locked and cleared', () => {
  const { machine } = refreshing();
  const done = run(machine, result(code('refresh', 'account_unsupported')));
  assert.equal(done.machine.view.failure, 'account_unsupported');
  assert.equal(done.machine.session, null);
  assert.deepEqual(done.machine.locked, [ADDR_A.toLowerCase()]);
  assert.deepEqual(types(done.effects), ['clear_private', 'cancel_expiry', 'broadcast']);
});

test('machine: any other refresh failure stops the way a me check does, with private data cleared', () => {
  for (const outcome of [
    { ok: false, route: 'refresh', failure: { kind: 'gate_required' }, serverTime: null },
    broken('refresh', 'contract_mismatch', { detail: 'body' }),
    broken('refresh', 'runtime_error'),
    code('refresh', 'route_not_available'),
    code('refresh', 'invalid_request'),
  ]) {
    const { machine } = refreshing();
    const done = run(machine, result(outcome));
    assert.equal(done.machine.view.status, 'blocked', JSON.stringify(outcome.failure));
    assert.deepEqual(types(done.effects), ['clear_private', 'cancel_expiry', 'refresh_failed']);
    assert.equal(done.effects[2].final, true);
  }
});

test('machine: no refresh outcome ever asks the wallet to sign', () => {
  const outcomes = [ok('refresh', session(ADDR_A)), ok('refresh', session(ADDR_A, CSRF_B)), ok('refresh', session(ADDR_B))];
  for (const error of Object.keys(runtime.ERROR_STATUS_BY_CODE)) outcomes.push(code('refresh', error));
  for (const kind of ['network_error', 'timeout', 'aborted', 'gate_required', 'gate_unavailable', 'runtime_error']) outcomes.push(broken('refresh', kind));
  for (const outcome of outcomes) {
    const { machine } = refreshing();
    let step = run(machine, result(outcome));
    // Whatever me then says.
    for (const next of [ok('me', session(ADDR_A)), code('me', 'session_required'), code('me', 'session_store_unavailable')]) {
      const after = step.machine.flow.kind === 'me' ? run(step.machine, result(next)) : { effects: [] };
      const all = [...step.effects, ...after.effects];
      assert.equal(all.filter((e) => e.type === 'sign').length, 0, JSON.stringify(outcome));
      assert.ok(!calls(all).some((c) => ['bootstrap', 'challenge', 'verify'].includes(c.route)), JSON.stringify(outcome));
    }
  }
});

test('machine: a Sign out click during a refresh wins; the late answer changes nothing', () => {
  const { machine } = refreshing();
  const out = run(machine, { type: 'sign_out' });
  assert.equal(types(out.effects)[0], 'abort_inflight');
  assert.deepEqual(calls(out.effects), [{ route: 'logout', csrf: CSRF_A }]);
  const late = run(out.machine, (m) => ({ type: 'result', epoch: machine.epoch, outcome: ok('refresh', session(ADDR_A)) }));
  assert.deepEqual(late.effects, []);
  assert.equal(late.machine.view.status, 'signing_out');
});

test('machine: an account switch during a refresh abandons it and signs the old session out', () => {
  const { machine } = refreshing();
  const switched = run(machine, { type: 'identity', identity: wallet(ADDR_B) });
  assert.ok(types(switched.effects).includes('abort_inflight'));
  assert.ok(types(switched.effects).includes('clear_private'));
  assert.deepEqual(calls(switched.effects), [{ route: 'logout', csrf: CSRF_A }]);
  const late = run(switched.machine, () => ({ type: 'result', epoch: machine.epoch, outcome: ok('refresh', session(ADDR_A)) }));
  assert.deepEqual(late.effects, [], "A's late renewal is stale by epoch");
});

// ---------------------------------------------------------------------------
// The controller: when to ask
// ---------------------------------------------------------------------------

function harness({ onRenewal, onBroadcast } = {}) {
  const log = { calls: [], signs: [], clears: 0, stored: [], broadcasts: 0, renewals: 0, timers: [] };
  const clock = { now: NOW, visible: true };
  const held = (route) => (...args) =>
    new Promise((resolve) => log.calls.push({ route, args, signal: args.at(-1), resolve, answered: false }));
  const api = Object.fromEntries(['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'].map((route) => [route, held(route)]));
  const controller = createSessionController({
    api,
    sign: (request) => new Promise((resolve) => log.signs.push({ ...request, resolve })),
    clearPrivate: () => {
      log.clears += 1;
    },
    storePrivate: (scope, identity) => log.stored.push({ scope, identity }),
    broadcast: () => {
      log.broadcasts += 1;
      onBroadcast?.();
    },
    broadcastRenewal: () => {
      log.renewals += 1;
      onRenewal?.();
    },
    isVisible: () => clock.visible,
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, at: clock.now + ms, cancelled: false, fired: false };
      log.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    origin: ORIGIN,
    checksum: getAddress,
  });
  const pending = (route) => log.calls.filter((call) => call.route === route && !call.answered).at(-1);
  const count = (route) => log.calls.filter((call) => call.route === route).length;
  async function answer(route, outcome) {
    const call = pending(route);
    assert.ok(call, `no ${route} request is waiting`);
    call.answered = true;
    call.resolve(outcome);
    await flush();
    return call;
  }
  /** Moves the clock and fires, in order, every live timer that is due, as the browser would. */
  async function advance(ms) {
    const until = clock.now + ms;
    for (;;) {
      const due = log.timers.filter((t) => !t.cancelled && !t.fired && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        clock.now = Math.max(clock.now, until);
        return;
      }
      clock.now = Math.max(clock.now, due.at);
      due.fired = true;
      due.callback();
      await flush();
      // A request the timer started is answered by the test, not here; the
      // clock stays at the moment it was sent.
      if (log.calls.some((call) => !call.answered)) return;
    }
  }
  const view = () => controller.getSnapshot().view;
  return { controller, log, clock, answer, pending, count, advance, view };
}

async function signIn(h, address = ADDR_A, csrf = CSRF_A) {
  h.controller.dispatch({ type: 'identity', identity: wallet(address) });
  await h.answer('me', code('me', 'session_required'));
  h.controller.dispatch({ type: 'sign_in' });
  await h.answer('bootstrap', ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }));
  const message = siweMessage({ origin: ORIGIN, address, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: '2026-09-10T12:05:00Z' });
  await h.answer('challenge', ok('challenge', { challengeId: 'b'.repeat(32), expiresAt: '2026-09-10T12:05:00Z', message }));
  h.log.signs.at(-1).resolve({ ok: true, signature: FIXTURES.requests.verify.signature });
  await flush();
  await h.answer('verify', ok('verify', session(address, csrf)));
}

/** Runs time forward, answering every me check with the live session, until a refresh is asked for. */
async function untilRefresh(h, ms, body = session(ADDR_A)) {
  const until = h.clock.now + ms;
  while (h.clock.now < until && !h.pending('refresh')) {
    await h.advance(until - h.clock.now);
    if (h.pending('me')) await h.answer('me', ok('me', body));
  }
  return h.pending('refresh');
}

test('controller: an active, visible tab renews before each idle deadline and stays signed in past 30 minutes', async () => {
  const h = harness();
  h.controller.activity(); // before verify: sign-in itself is not activity since renewal
  await signIn(h);
  const epoch = h.controller.getSnapshot().epoch;
  const clears = h.log.clears;
  assert.equal(await untilRefresh(h, SESSION_IDLE_MS - MINUTE), undefined, 'no refresh without activity since the renewal');

  // The same session again, with activity this time.
  const g = harness();
  await signIn(g);
  const signedAt = g.clock.now;
  const scope = g.controller.getSnapshot().epoch;
  for (let round = 1; round <= 4; round += 1) {
    g.clock.now += 1000;
    g.controller.activity();
    const renewedAt = g.clock.now - 1000;
    const call = await untilRefresh(g, REFRESH_AFTER_MS);
    assert.ok(call, `round ${round}: a refresh was asked for`);
    assert.equal(call.args[0], CSRF_A, 'with the session CSRF');
    assert.ok(g.clock.now - renewedAt >= REFRESH_AFTER_MS && g.clock.now - renewedAt < SESSION_IDLE_MS, 'before the idle deadline');
    await g.answer('refresh', ok('refresh', session(ADDR_A)));
    assert.equal(g.view().status, 'signed_in');
    assert.equal(g.log.renewals, round, 'other tabs are told of each renewal');
  }
  assert.ok(g.clock.now - signedAt > 2 * SESSION_IDLE_MS, 'well past one idle period');
  assert.equal(g.controller.getSnapshot().epoch, scope, 'the same scope throughout');
  assert.equal(g.log.signs.length, 1);
  assert.equal(h.controller.getSnapshot().epoch, epoch);
  assert.equal(h.log.clears, clears);
});

test('controller: without activity since the last renewal, nothing is refreshed and the session idles out', async () => {
  const h = harness();
  await signIn(h);
  assert.equal(await untilRefresh(h, SESSION_IDLE_MS - MINUTE), undefined);
  await h.advance(2 * MINUTE);
  await h.answer('me', code('me', 'session_required'));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'session_ended' });
  assert.equal(h.count('refresh'), 0);
});

test('controller: a restored session, whose last renewal is unknown, is renewed at the first activity', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', ok('me', session(ADDR_A)));
  assert.equal(h.count('refresh'), 0, 'loading the page is not activity');
  h.clock.now += 1000;
  h.controller.activity();
  assert.ok(h.pending('refresh'), 'renewed at once: the idle deadline could be close');
  await h.answer('refresh', ok('refresh', session(ADDR_A)));
  h.controller.activity();
  assert.equal(h.count('refresh'), 1, 'and then not again until it is due');
});

test('controller: no refresh while signed out, or while hidden; it runs when the tab is visible again', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', code('me', 'session_required'));
  h.controller.activity();
  h.controller.wake();
  await h.advance(SESSION_IDLE_MS);
  assert.equal(h.count('refresh'), 0, 'nothing to renew while signed out');
  assert.ok(h.log.timers.every((t) => t.fired || t.cancelled || t.ms !== 0));

  const g = harness();
  await signIn(g);
  g.clock.now += 1000;
  g.controller.activity();
  g.clock.visible = false;
  assert.equal(await untilRefresh(g, REFRESH_AFTER_MS + MINUTE), undefined, 'a hidden tab never refreshes');
  g.clock.visible = true;
  g.controller.wake();
  assert.ok(g.pending('refresh'), 'coming back into view runs the refresh that waited');
});

test('controller: refresh session_required signs out, clears private data and asks for no signature', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  const clears = h.log.clears;
  const broadcasts = h.log.broadcasts;
  await h.answer('refresh', code('refresh', 'session_required'));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'session_ended' });
  assert.equal(h.log.clears, clears + 1);
  assert.equal(h.log.broadcasts, broadcasts + 1, 'the other tabs look for themselves');
  assert.equal(h.log.signs.length, 1);
  h.controller.activity();
  assert.equal(h.count('refresh'), 1);
});

test('controller: a refresh 503 keeps the session and retries after 30 s, 60 s and 120 s, then stops', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  const clears = h.log.clears;
  const waits = [];
  for (let attempt = 0; attempt <= REFRESH_RETRY_MS.length; attempt += 1) {
    const sentAt = h.clock.now;
    await h.answer('refresh', code('refresh', 'session_store_unavailable'));
    assert.equal(h.view().status, 'signed_in', 'a 503 is not a sign-out');
    assert.equal(h.view().notice, 'refresh_unavailable');
    const next = await untilRefresh(h, 3 * MINUTE);
    if (attempt < REFRESH_RETRY_MS.length) {
      assert.ok(next, `retry ${attempt + 1}`);
      waits.push(h.clock.now - sentAt);
    } else {
      assert.equal(next, undefined, 'no more than the bounded retries');
    }
  }
  assert.deepEqual(waits, REFRESH_RETRY_MS);
  assert.equal(h.log.clears, clears, 'private data stays through the outage');
  h.controller.activity();
  h.controller.wake();
  assert.equal(h.count('refresh'), 1 + REFRESH_RETRY_MS.length);
});

test('controller: retries used up in an outage stop only that renewal window; a renewal elsewhere starts a new one', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  // The outage outlasts every retry: 1 refresh and 3 retries, then this tab waits.
  for (let attempt = 0; attempt <= REFRESH_RETRY_MS.length; attempt += 1) {
    await h.answer('refresh', code('refresh', 'session_store_unavailable'));
    await untilRefresh(h, 3 * MINUTE);
  }
  assert.equal(h.count('refresh'), 1 + REFRESH_RETRY_MS.length);
  assert.equal(h.pending('refresh'), undefined);

  // The service is back and another tab renewed the session: a new window.
  h.controller.renewedElsewhere();
  assert.equal(h.view().status, 'signed_in');
  assert.equal(h.view().notice, undefined);
  const renewedAt = h.clock.now;
  // The user keeps working in this tab only.
  let due;
  for (let minute = 0; minute < 25 && !due; minute += 1) {
    h.clock.now += 1000;
    h.controller.activity();
    due = await untilRefresh(h, MINUTE - 1000);
  }
  assert.ok(due, 'this tab renews the session again before it idles out');
  assert.ok(h.clock.now - renewedAt >= REFRESH_AFTER_MS, 'not before the new window is due');
  assert.ok(h.clock.now - renewedAt < SESSION_IDLE_MS, 'before the idle deadline');
  assert.equal(due.args[0], CSRF_A);
  // With its full set of retries again.
  const sentAt = h.clock.now;
  await h.answer('refresh', code('refresh', 'upstream_timeout'));
  assert.ok(await untilRefresh(h, MINUTE));
  assert.equal(h.clock.now - sentAt, REFRESH_RETRY_MS[0]);
  await h.answer('refresh', ok('refresh', session(ADDR_A)));
  assert.equal(h.view().status, 'signed_in');
  assert.equal(h.view().notice, undefined);
  assert.equal(h.log.signs.length, 1, 'never a signature');
});

test('controller: retries used up in an outage start over after this tab’s own renewal', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  for (let attempt = 0; attempt < REFRESH_RETRY_MS.length; attempt += 1) {
    await h.answer('refresh', code('refresh', 'session_store_unavailable'));
    assert.ok(await untilRefresh(h, 3 * MINUTE), `retry ${attempt + 1}`);
  }
  // The last retry works.
  await h.answer('refresh', ok('refresh', session(ADDR_A)));
  assert.equal(h.view().notice, undefined);
  // The next window has its own retries, even though the last one used all of them.
  h.clock.now += 1000;
  h.controller.activity();
  assert.ok(await untilRefresh(h, REFRESH_AFTER_MS));
  for (let attempt = 0; attempt < REFRESH_RETRY_MS.length; attempt += 1) {
    await h.answer('refresh', code('refresh', 'upstream_timeout'));
    assert.ok(await untilRefresh(h, 3 * MINUTE), `retry ${attempt + 1} in the next window`);
  }
  await h.answer('refresh', code('refresh', 'upstream_timeout'));
  assert.equal(await untilRefresh(h, 3 * MINUTE), undefined, 'still bounded within the window');
  assert.equal(h.count('refresh'), 2 * (1 + REFRESH_RETRY_MS.length));
});

test('controller: a Retry-After longer than the backoff is honoured, and a later success resets it', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  const sentAt = h.clock.now;
  await h.answer('refresh', code('refresh', 'session_rate_limited', 90));
  assert.ok(await untilRefresh(h, 2 * MINUTE));
  assert.equal(h.clock.now - sentAt, 90_000);
  await h.answer('refresh', ok('refresh', session(ADDR_A)));
  assert.equal(h.view().notice, undefined);
  // A new renewal window, with the full set of retries again.
  h.clock.now += 1000;
  h.controller.activity();
  assert.ok(await untilRefresh(h, REFRESH_AFTER_MS));
  await h.answer('refresh', code('refresh', 'upstream_timeout'));
  const again = h.clock.now;
  assert.ok(await untilRefresh(h, MINUTE));
  assert.equal(h.clock.now - again, REFRESH_RETRY_MS[0]);
});

test('controller: a CSRF refusal reads me once and never loops', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  await untilRefresh(h, REFRESH_AFTER_MS);
  const reads = h.count('me');
  await h.answer('refresh', code('refresh', 'csrf_invalid'));
  assert.ok(h.pending('me'), 'me is re-read');
  await h.answer('me', ok('me', session(ADDR_A)));
  assert.equal(h.view().status, 'signed_in');
  for (let i = 0; i < 3; i += 1) {
    h.clock.now += MINUTE;
    h.controller.activity();
    h.controller.wake();
  }
  assert.equal(h.count('refresh'), 1, 'no second refresh for this session');
  assert.equal(h.count('me'), reads + 1, 'exactly one me after the refusal');
  // A renewal in another tab does not lift it: the refusal is about this
  // session, not about one renewal window.
  h.controller.renewedElsewhere();
  for (let i = 0; i < 25; i += 1) {
    h.clock.now += 1000;
    h.controller.activity();
    await untilRefresh(h, MINUTE - 1000);
  }
  assert.equal(h.count('refresh'), 1, 'still no second refresh for this session');
  assert.equal(h.log.signs.length, 1, 'never a signature');
});

test('controller: a new server session for the same owner, found by a background me, gets its own scope and refreshes afresh', async () => {
  const h = harness();
  await signIn(h);
  const before = h.controller.getSnapshot().epoch;
  const clears = h.log.clears;
  h.controller.dispatch({ type: 'recheck', cause: 'remote' });
  await h.answer('me', ok('me', session(ADDR_A, CSRF_B)));
  assert.equal(h.controller.getSnapshot().epoch, before + 1, 'a new epoch, so a new private scope');
  assert.equal(h.log.clears, clears + 1, 'the old session’s private data is dropped first');
  assert.deepEqual(h.log.stored.at(-1).scope.epoch, before + 1);
  // Its renewal history is its own: unknown, so the first activity renews it, with its own CSRF.
  h.clock.now += 1000;
  h.controller.activity();
  assert.equal(h.pending('refresh').args[0], CSRF_B);
});

test('controller: two tabs share renewals, so they do not both refresh, and neither touches the other’s CSRF', async () => {
  let first;
  let second;
  first = harness({ onRenewal: () => second.controller.renewedElsewhere() });
  second = harness({ onRenewal: () => first.controller.renewedElsewhere() });
  await signIn(first);
  second.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await second.answer('me', ok('me', session(ADDR_A)));

  // The restored tab renews at its first activity, and the first tab hears of it.
  first.clock.now = second.clock.now = NOW + MINUTE;
  second.controller.activity();
  await second.answer('refresh', ok('refresh', session(ADDR_A)));
  assert.equal(first.count('refresh'), 0);
  assert.equal(first.count('me'), 1, 'a renewal notice sends nothing');

  // Both in use. The first tab would have been due 20 minutes after its
  // sign-in; the renewal moved that for both.
  first.clock.now = second.clock.now = NOW + 2 * MINUTE;
  first.controller.activity();
  second.controller.activity();
  await untilRefresh(first, REFRESH_AFTER_MS - 2 * MINUTE + 30_000);
  assert.equal(first.count('refresh'), 0, 'not at its old deadline');
  second.clock.now = first.clock.now;
  const due = await untilRefresh(first, MINUTE);
  assert.ok(due, 'the first tab renews at the shared deadline');
  second.clock.now = first.clock.now;
  await first.answer('refresh', ok('refresh', session(ADDR_A)));
  // The second tab's timer is now for the new deadline, not this one.
  const stale = await untilRefresh(second, 5_000);
  assert.equal(stale, undefined, 'one refresh per renewal window, not one per tab');
  assert.equal(second.count('refresh'), 1);

  for (const tab of [first, second]) {
    assert.equal(tab.view().status, 'signed_in');
    assert.ok(tab.log.calls.filter((c) => c.route === 'refresh').every((c) => c.args[0] === CSRF_A));
  }
  // Both still sign out with the one CSRF.
  first.controller.dispatch({ type: 'sign_out' });
  assert.equal(first.pending('logout').args[0], CSRF_A);
});

test('controller: a Sign out click during a refresh aborts it and logs out', async () => {
  const h = harness();
  await signIn(h);
  h.clock.now += 1000;
  h.controller.activity();
  const call = await untilRefresh(h, REFRESH_AFTER_MS);
  h.controller.dispatch({ type: 'sign_out' });
  assert.equal(call.signal.aborted, true);
  assert.equal(h.pending('logout').args[0], CSRF_A);
  await h.answer('logout', ok('logout', FIXTURES.responses.logout));
  await h.answer('refresh', ok('refresh', session(ADDR_A)));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'logged_out' });
  assert.equal(h.log.renewals, 0, 'the abandoned refresh renewed nothing here');
});
