/**
 * The controller that runs the session machine, with every port faked: API
 * calls are held until the test answers them, the wallet signs on demand, and
 * timers only fire when told to. This is where abort signals, late results,
 * the expiry timer and cross-tab messages are proven.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { FIXTURES, siweMessage } from './support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const { createSessionController, SESSION_CHECK_MS, SESSION_IDLE_MS } = require('../.test-build/app/src/session/controller.js');
const { OutgoingContractError } = require('../.test-build/app/src/session/api.js');

const ORIGIN = 'https://app.example.invalid';
const ADDR_A = FIXTURES.requests.challenge.address;
const ADDR_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const PREAUTH = 'p'.repeat(43);
const CSRF_A = 'a'.repeat(43);
const NOW = Date.parse('2026-09-10T12:00:00Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));

const wallet = (address, chainId = 4663) => ({ kind: 'connected', connectorUid: 'uid-a', connectorName: 'Test Wallet', address, chainId });
const ok = (route, body, serverTime = null) => ({ ok: true, route, body, serverTime });
const required = (route) => ({ ok: false, route, failure: { kind: 'session_error', status: 401, code: 'session_required', retryAfterS: null }, serverTime: null });
const code = (route, error, status) => ({ ok: false, route, failure: { kind: 'session_error', status, code: error, retryAfterS: null }, serverTime: null });
const session = (address, csrf = CSRF_A, expiresAt = '2026-09-11T00:00:00Z') => ({
  ...FIXTURES.responses.me,
  owner: { address: address.toLowerCase(), chainId: 4663 },
  csrfToken: csrf,
  expiresAt,
});
const challenge = (address) => ({
  challengeId: 'b'.repeat(32),
  expiresAt: '2026-09-10T12:05:00Z',
  message: siweMessage({ origin: ORIGIN, address, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: '2026-09-10T12:05:00Z' }),
});

function harness({ now = NOW, onBroadcast, onRenewal, ...overrides } = {}) {
  const log = { calls: [], signs: [], clears: 0, stored: [], broadcasts: 0, renewals: 0, timers: [] };
  const clock = { now, visible: true };
  const held = (route) => (...args) =>
    new Promise((resolve) => log.calls.push({ route, args, signal: args.at(-1), resolve, answered: false }));
  const api = {
    ...Object.fromEntries(['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'].map((route) => [route, held(route)])),
    ...overrides,
  };
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
      const timer = { callback, ms, cancelled: false };
      log.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    origin: ORIGIN,
    checksum: getAddress,
  });
  const pending = (route) => log.calls.filter((call) => call.route === route && !call.answered).at(-1);
  async function answer(route, outcome) {
    const call = pending(route);
    assert.ok(call, `no ${route} request is waiting`);
    call.answered = true;
    call.resolve(outcome);
    await flush();
    return call;
  }
  const view = () => controller.getSnapshot().view;
  return { controller, log, clock, answer, pending, view };
}

async function signIn(h, address = ADDR_A, csrf = CSRF_A) {
  h.controller.dispatch({ type: 'identity', identity: wallet(address) });
  await h.answer('me', required('me'));
  h.controller.dispatch({ type: 'sign_in' });
  await h.answer('bootstrap', ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }));
  await h.answer('challenge', ok('challenge', challenge(address)));
  h.log.signs.at(-1).resolve({ ok: true, signature: FIXTURES.requests.verify.signature });
  await flush();
  await h.answer('verify', ok('verify', session(address, csrf)));
}

test("an in-flight me for A is aborted by a switch to B, and its late answer changes nothing", async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  const forA = h.pending('me');
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_B) });
  assert.equal(forA.signal.aborted, true);
  const before = h.controller.getSnapshot();
  forA.answered = true;
  forA.resolve(ok('me', session(ADDR_A)));
  await flush();
  // B's own check is still the one waiting, and nothing of A's was stored.
  assert.equal(h.controller.getSnapshot().view.status, before.view.status);
  assert.deepEqual(h.log.stored, []);
  assert.equal(h.controller.getSnapshot().identity.address, ADDR_B);
});

test('signing in stores the identity under a scope that includes the session epoch', async () => {
  const h = harness();
  await signIn(h);
  assert.equal(h.view().status, 'signed_in');
  assert.equal(h.log.stored.length, 1);
  const [{ scope, identity }] = h.log.stored;
  assert.deepEqual(scope, { connectorUid: 'uid-a', address: ADDR_A, chainId: 4663, epoch: h.controller.getSnapshot().epoch });
  assert.equal(identity.owner, ADDR_A.toLowerCase());
  assert.equal(h.log.broadcasts, 1);
});

test('a switch clears private data, aborts, and logs the old session out with its own CSRF', async () => {
  const h = harness();
  await signIn(h);
  const clears = h.log.clears;
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_B) });
  assert.equal(h.log.clears, clears + 1);
  const logout = h.pending('logout');
  assert.deepEqual(logout.args.slice(0, 1), [CSRF_A]);
  await h.answer('logout', ok('logout', FIXTURES.responses.logout));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'identity_changed' });
  assert.equal(h.log.signs.length, 1, 'the only signature is the one the user asked for');
});

test('a signature that arrives after cancelling is never verified', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', required('me'));
  h.controller.dispatch({ type: 'sign_in' });
  await h.answer('bootstrap', ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }));
  await h.answer('challenge', ok('challenge', challenge(ADDR_A)));
  h.controller.dispatch({ type: 'cancel' });
  h.log.signs.at(-1).resolve({ ok: true, signature: FIXTURES.requests.verify.signature });
  await flush();
  assert.equal(h.log.calls.filter((call) => call.route === 'verify').length, 0);
  assert.deepEqual(h.pending('logout').args.slice(0, 1), [PREAUTH]);
});

test('the expiry timer is placed by the server clock and re-reads me when it fires', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  // The server's clock is five minutes behind this machine's: 11:55 there, and
  // the session expires at 11:58 server time, inside the regular check.
  await h.answer('me', ok('me', session(ADDR_A, CSRF_A, '2026-09-10T11:58:00Z'), NOW - 5 * 60_000));
  const timer = h.log.timers.at(-1);
  assert.equal(timer.ms, 3 * 60_000 + 1000);
  timer.callback();
  assert.ok(h.pending('me'));
  await h.answer('me', required('me'));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'session_ended' });
});

test('an expiry that already looks past is never scheduled, so a fast local clock cannot loop', async () => {
  const h = harness({ now: Date.parse('2026-09-11T06:00:00Z') });
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', ok('me', session(ADDR_A, CSRF_A, '2026-09-11T00:00:00Z')));
  assert.equal(h.view().status, 'signed_in');
  // Only the regular check is placed, never an immediate one.
  assert.deepEqual(h.log.timers.map((timer) => timer.ms), [SESSION_CHECK_MS]);
  h.log.timers.at(-1).callback();
  await h.answer('me', ok('me', session(ADDR_A, CSRF_A, '2026-09-11T00:00:00Z')));
  assert.deepEqual(h.log.timers.map((timer) => timer.ms), [SESSION_CHECK_MS, SESSION_CHECK_MS]);
  assert.equal(h.log.calls.filter((call) => call.route === 'me').length, 2);
});

test('a fresh sign-in is checked again when its idle deadline passes, not only at the absolute expiry', async () => {
  const h = harness();
  await signIn(h);
  assert.equal(h.log.timers.at(-1).ms, SESSION_CHECK_MS, 'the regular check comes first');
  // Regular checks while the session lives keep the idle deadline in view.
  for (let round = 0; round < 5; round += 1) {
    h.clock.now += SESSION_CHECK_MS;
    h.log.timers.at(-1).callback();
    await h.answer('me', ok('me', session(ADDR_A)));
  }
  h.clock.now += 60_000;
  h.log.timers.at(-1).callback();
  await h.answer('me', ok('me', session(ADDR_A)));
  // 26 minutes after verify: the idle deadline is 4 minutes away.
  assert.equal(h.log.timers.at(-1).ms, SESSION_IDLE_MS - 26 * 60_000 + 1000);
  h.clock.now += 4 * 60_000 + 1000;
  h.log.timers.at(-1).callback();
  await h.answer('me', required('me'));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'session_ended' });
});

test('a restored session, whose idle deadline is unknown, is read again every few minutes while shown', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', ok('me', session(ADDR_A)));
  assert.equal(h.view().status, 'signed_in');
  assert.equal(h.log.timers.at(-1).ms, SESSION_CHECK_MS);
  assert.ok(SESSION_CHECK_MS <= 10 * 60_000);
  h.log.timers.at(-1).callback();
  await h.answer('me', required('me'));
  assert.deepEqual(h.view(), { status: 'signed_out', reason: 'session_ended' });
  assert.ok(h.log.clears >= 1);
});

test('signing out cancels the expiry timer', async () => {
  const h = harness();
  await signIn(h);
  const timer = h.log.timers.at(-1);
  h.controller.dispatch({ type: 'sign_out' });
  assert.equal(timer.cancelled, true);
});

test("one tab's sign-in makes the other read me, and the other never echoes it back", async () => {
  let second;
  const first = harness({ onBroadcast: () => second.controller.dispatch({ type: 'recheck', cause: 'remote' }) });
  second = harness({ onBroadcast: () => assert.fail('the second tab must not re-broadcast') });
  second.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await second.answer('me', required('me'));
  await signIn(first);
  await second.answer('me', ok('me', session(ADDR_A)));
  assert.equal(second.view().status, 'signed_in');
  assert.equal(second.log.signs.length, 0, 'the second tab signed nothing');
});

test('a signature the contract refuses to send ends the attempt instead of throwing', async () => {
  const h = harness({
    // The real port rejects; this one throws synchronously, the harsher case.
    verify: () => {
      throw new OutgoingContractError('verify');
    },
  });
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', required('me'));
  h.controller.dispatch({ type: 'sign_in' });
  await h.answer('bootstrap', ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }));
  await h.answer('challenge', ok('challenge', challenge(ADDR_A)));
  // A wallet that returns a 64-byte signature.
  h.log.signs.at(-1).resolve({ ok: true, signature: `0x${'ab'.repeat(64)}` });
  await flush();
  assert.deepEqual(h.pending('logout').args.slice(0, 1), [PREAUTH], 'the preauth context is closed');
  await h.answer('logout', ok('logout', FIXTURES.responses.logout));
  assert.equal(h.view().failure, 'client_error');
});

test('a revocation cleanup is not cancelled by a later switch', async () => {
  const h = harness();
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await h.answer('me', required('me'));
  h.controller.dispatch({ type: 'sign_in' });
  await h.answer('bootstrap', ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: PREAUTH }));
  await h.answer('challenge', ok('challenge', challenge(ADDR_A)));
  h.log.signs.at(-1).resolve({ ok: true, signature: FIXTURES.requests.verify.signature });
  await flush();
  const verify = h.pending('verify');
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_B) });
  // The verify answer lands after the switch: stale, so it is revoked quietly.
  verify.answered = true;
  verify.resolve(ok('verify', session(ADDR_A, CSRF_A)));
  await flush();
  const cleanup = h.log.calls.filter((call) => call.route === 'logout' && call.args[0] === CSRF_A).at(-1);
  assert.ok(cleanup, 'the orphan session is logged out');
  h.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  assert.equal(cleanup.signal.aborted, false);
});

test('the published snapshot never holds a credential', async () => {
  const h = harness();
  await signIn(h);
  const text = JSON.stringify(h.controller.getSnapshot());
  for (const secret of [PREAUTH, CSRF_A, FIXTURES.requests.verify.signature]) assert.ok(!text.includes(secret));
});

test('503 at me keeps the user informed and signed-in data off screen', async () => {
  const h = harness();
  await signIn(h);
  h.controller.dispatch({ type: 'recheck', cause: 'visible' });
  const clears = h.log.clears;
  await h.answer('me', code('me', 'session_store_unavailable', 503));
  assert.equal(h.view().failure, 'store_unavailable');
  assert.equal(h.log.clears, clears + 1);
});

test("a sign-out broadcast that arrives during the other tab's own me is not lost", async () => {
  let second;
  const first = harness({ onBroadcast: () => second.controller.dispatch({ type: 'recheck', cause: 'remote' }) });
  second = harness();
  await signIn(first);
  second.controller.dispatch({ type: 'identity', identity: wallet(ADDR_A) });
  await second.answer('me', ok('me', session(ADDR_A)));
  assert.equal(second.view().status, 'signed_in');

  // The second tab comes back into view and reads me.
  second.controller.dispatch({ type: 'recheck', cause: 'visible' });
  const inFlight = second.pending('me');
  assert.ok(inFlight);
  const clears = second.log.clears;
  // The first tab signs out meanwhile, and tells the second.
  first.controller.dispatch({ type: 'sign_out' });
  await first.answer('logout', ok('logout', FIXTURES.responses.logout));
  assert.deepEqual(first.view(), { status: 'signed_out', reason: 'logged_out' });
  // The second tab's me was served before the sign-out committed.
  await second.answer('me', ok('me', session(ADDR_A)));
  const again = second.pending('me');
  assert.ok(again, 'the broadcast that arrived mid-flight still makes the second tab read me');
  await second.answer('me', required('me'));
  assert.deepEqual(second.view(), { status: 'signed_out', reason: 'session_ended' });
  assert.equal(second.log.clears, clears + 1, 'its private data is cleared');
  assert.equal(second.log.calls.filter((call) => call.route === 'me').length, 3);
  assert.equal(second.log.signs.length, 0);
});
