/**
 * The session port the previews use (session/port.ts), over fake controllers
 * and over B2's real controller: every B2 view and blocked failure maps to one
 * state, the CSRF is lent only to the signed-in epoch, and a denial re-reads
 * `me` or signs out, never asking for a signature.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, fakeClock, fixture, flush } from './support/consumer-fakes.mjs';
import { FIXTURES } from './support/session-fixtures.mjs';

const { createSessionPort, toSessionSnapshot, sessionKey, SESSION_GONE } = build('session/port');
const { NO_SESSION, createSessionController } = build('session/controller');

const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** A connected wallet, as B2 reports it: `connectorUid` is the wagmi connector instance it came through. */
const connected = (address = A, chainId = 4663) => ({ kind: 'connected', connectorUid: 'uid-a', connectorName: 'Test Wallet A', address, chainId });
const snap = (view, identity = connected(), epoch = 3) => ({ view, identity, epoch, busy: false });
const SIGNED_IN = { status: 'signed_in', owner: A.toLowerCase(), expiresAt: '2026-09-11T00:00:00Z' };
const NONE = new Set();

function fakeController(initial, { lend = true } = {}) {
  let current = initial;
  const listeners = new Set();
  const controller = {
    dispatched: [],
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(event) {
      controller.dispatched.push(event);
    },
    set(next) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
  if (lend) controller.withSessionCsrf = (epoch, fn) => (current.epoch === epoch && current.view.status === 'signed_in' ? fn('csrf-token') : Promise.resolve(NO_SESSION));
  return controller;
}

test('every B2 view status maps to exactly one port state', () => {
  const cases = [
    [{ status: 'starting' }, 'pending'],
    [{ status: 'checking' }, 'pending'],
    [{ status: 'signing_in', step: 'challenge' }, 'pending'],
    [{ status: 'signing_out' }, 'pending'],
    [{ status: 'no_wallet' }, 'no_wallet'],
    [{ status: 'wrong_network', chainId: 1 }, 'wrong_network'],
    [{ status: 'signed_out', reason: 'session_ended' }, 'signed_out'],
    [{ status: 'other_session', owner: B.toLowerCase() }, 'wallet_account_differs'],
    [SIGNED_IN, 'signed_in'],
  ];
  for (const [view, kind] of cases) assert.equal(toSessionSnapshot(snap(view), NONE).kind, kind, view.status);
});

test('every blocked failure has its own meaning; an outage is never shown as signed out (T-30)', () => {
  const expected = {
    gate_required: 'gate_required',
    gate_unavailable: 'gate_unavailable',
    service_disabled: 'session_disabled',
    store_unavailable: 'session_busy',
    account_check_unavailable: 'session_busy',
    service_unavailable: 'session_busy',
    rate_limited: 'session_busy',
    network_error: 'session_busy',
    timeout: 'session_busy',
    signout_unconfirmed: 'session_busy',
    account_unsupported: 'account_unsupported',
    contract_mismatch: 'session_error',
    untrusted_challenge: 'session_error',
    client_error: 'session_error',
    browser_unsupported: 'browser_unsupported',
  };
  for (const [failure, kind] of Object.entries(expected)) {
    const out = toSessionSnapshot(snap({ status: 'blocked', failure, retry: 'check', retryAfterS: 30 }), NONE);
    assert.equal(out.kind, kind, failure);
    if (kind === 'session_busy') assert.equal(out.retryAfterS, 30);
  }
});

test('a signed-in view counts only for the connected account, on 4663, not locked', () => {
  assert.deepEqual(toSessionSnapshot(snap(SIGNED_IN), NONE), { kind: 'signed_in', owner: A.toLowerCase(), chainId: 4663, epoch: 3, connectorUid: 'uid-a' });
  assert.equal(toSessionSnapshot(snap(SIGNED_IN, connected(B)), NONE).kind, 'wallet_account_differs');
  assert.deepEqual(toSessionSnapshot(snap(SIGNED_IN, connected(A, 1)), NONE), { kind: 'wrong_network', chainId: 1 });
  assert.equal(toSessionSnapshot(snap(SIGNED_IN, { kind: 'unknown' }), NONE).kind, 'pending');
  assert.equal(toSessionSnapshot(snap(SIGNED_IN), new Set([A.toLowerCase()])).kind, 'account_unsupported');
  assert.equal(toSessionSnapshot(snap({ status: 'signed_out', reason: 'none' }), new Set([A.toLowerCase()])).kind, 'account_unsupported');
});

test('the session key changes with the epoch, the connector instance and the owner, and is null unless signed in', () => {
  const key = sessionKey(toSessionSnapshot(snap(SIGNED_IN, connected(), 3), NONE));
  assert.equal(key, `3|uid-a|${A.toLowerCase()}`);
  assert.notEqual(sessionKey(toSessionSnapshot(snap(SIGNED_IN, connected(), 4), NONE)), key);
  const forB = { ...SIGNED_IN, owner: B.toLowerCase() };
  assert.notEqual(sessionKey(toSessionSnapshot(snap(forB, connected(B), 3), NONE)), key);
  assert.equal(sessionKey({ kind: 'signed_out' }), null);
});

test('without CSRF access the port lends nothing and says so', async () => {
  const port = createSessionPort(fakeController(snap(SIGNED_IN), { lend: false }));
  assert.equal(port.csrfAccess, false);
  let called = false;
  assert.equal(await port.withCsrf(3, async () => (called = true)), SESSION_GONE);
  assert.equal(called, false);
});

test('the snapshot keeps its identity while nothing changes, as useSyncExternalStore needs', () => {
  const controller = fakeController(snap(SIGNED_IN));
  const port = createSessionPort(controller);
  const first = port.getSnapshot();
  assert.equal(port.getSnapshot(), first);
  controller.set({ ...snap(SIGNED_IN), busy: true });
  assert.equal(port.getSnapshot(), first, 'a change that does not change the port state keeps the object');
  controller.set(snap(SIGNED_IN, connected(), 4));
  assert.notEqual(port.getSnapshot(), first);
});

test('session_required and csrf_invalid re-read me; a stale epoch is ignored; nothing asks for a signature', () => {
  const controller = fakeController(snap(SIGNED_IN));
  const port = createSessionPort(controller);
  port.reportDenial('session_required', 3);
  port.reportDenial('csrf_invalid', 3);
  port.reportDenial('session_required', 2);
  assert.deepEqual(controller.dispatched, [
    { type: 'recheck', cause: 'remote' },
    { type: 'recheck', cause: 'remote' },
  ]);
  assert.ok(!controller.dispatched.some((event) => event.type === 'sign_in'));
});

test('account_unsupported locks the owner for this page and signs the tab out', () => {
  const controller = fakeController(snap(SIGNED_IN));
  const port = createSessionPort(controller);
  let heard = 0;
  port.subscribe(() => (heard += 1));
  port.reportDenial('account_unsupported', 3);
  assert.deepEqual(controller.dispatched, [{ type: 'sign_out' }]);
  assert.equal(port.getSnapshot().kind, 'account_unsupported');
  assert.ok(heard >= 1);
  // Still locked once B2 lands on signed out for that account.
  controller.set(snap({ status: 'signed_out', reason: 'logged_out' }));
  assert.equal(port.getSnapshot().kind, 'account_unsupported');
  // Another account is not affected.
  controller.set(snap({ status: 'signed_out', reason: 'logged_out' }, connected(B)));
  assert.equal(port.getSnapshot().kind, 'signed_out');
});

test("bound to B2's real controller, the port lends its CSRF to the signed-in epoch only", async () => {
  const calls = [];
  const api = Object.fromEntries(
    ['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'].map((route) => [route, () => new Promise((resolve) => calls.push({ route, resolve }))]),
  );
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
  assert.equal(port.csrfAccess, true);
  controller.dispatch({ type: 'identity', identity: connected() });
  assert.equal(port.getSnapshot().kind, 'pending');
  const csrf = 'k'.repeat(43);
  calls.find((call) => call.route === 'me').resolve({
    ok: true,
    route: 'me',
    body: { ...FIXTURES.responses.me, owner: { address: A.toLowerCase(), chainId: 4663 }, csrfToken: csrf },
    serverTime: null,
  });
  await flush();
  const signedIn = port.getSnapshot();
  assert.equal(signedIn.kind, 'signed_in');
  assert.equal(await port.withCsrf(signedIn.epoch, async (lent) => lent), csrf);
  assert.equal(await port.withCsrf(signedIn.epoch + 1, async () => 'stale'), SESSION_GONE);
  port.reportDenial('session_required', signedIn.epoch);
  assert.equal(calls.filter((call) => call.route === 'me').length, 2, 'a denial re-reads me once');
  assert.equal(calls.filter((call) => call.route !== 'me').length, 0, 'and sends nothing else');
});

// ---- two providers announcing one rdns (rugged97's #70 P2, on #72) ----------

const { createPreviewController } = build('onboarding/controller');
const { createPreviewBudget } = build('onboarding/budget');
const { buildSwapRequest } = build('onboarding/inputs');
const { consumerTestCatalog } = build('onboarding/catalog');
const SWAP_FORM = {
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountRaw: '1000',
  slippageBps: '50',
  maxPriceImpactBps: '100',
};
const SWAP = fixture('onboarding-v1', 'responses/swap-preview.json').preview;

test("bound to B2's real controller, a second provider with the same rdns ends the previews' session: the preview is dropped and the CSRF is not lent again", async () => {
  // An EIP-6963 provider announces its own rdns, so two can share one; wagmi
  // makes a connector, with its own uid, for each. These two identities differ
  // in that instance only: the same rdns, account and chain.
  const RDNS = 'test.wallet.shared';
  const viaA = { ...connected(), connectorId: RDNS, connectorUid: 'uid-a' };
  const viaB = { ...connected(), connectorId: RDNS, connectorUid: 'uid-b' };
  const calls = [];
  const api = Object.fromEntries(
    ['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'].map((route) => [route, (...args) => new Promise((resolve) => calls.push({ route, args, resolve }))]),
  );
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
  controller.dispatch({ type: 'identity', identity: viaA });
  const csrf = 'k'.repeat(43);
  calls.find((call) => call.route === 'me').resolve({
    ok: true,
    route: 'me',
    body: { ...FIXTURES.responses.me, owner: { address: A.toLowerCase(), chainId: 4663 }, csrfToken: csrf },
    serverTime: null,
  });
  await flush();
  const signedIn = port.getSnapshot();
  assert.equal(signedIn.kind, 'signed_in');

  // A preview under the session signed in through A.
  const clock = fakeClock();
  const client = { calls: [], preview: (route, request, options) => new Promise((resolve) => client.calls.push({ route, request, options, resolve })) };
  const previews = createPreviewController('swap-preview', { client, port, clock, budget: createPreviewBudget({ clock }) });
  previews.start();
  previews.setForm(buildSwapRequest(SWAP_FORM, consumerTestCatalog));
  previews.request();
  await flush();
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.csrf, csrf, "the preview went out with A's session CSRF");
  client.calls[0].resolve({ ok: true, preview: SWAP, requestId: null });
  await flush();
  assert.equal(previews.getView().state.status, 'current');

  // B takes over the connection: the same account and chain, another provider.
  controller.dispatch({ type: 'identity', identity: viaB });
  assert.notEqual(port.getSnapshot().kind, 'signed_in', "A's session is not a session for B");
  assert.equal(sessionKey(port.getSnapshot()), null);
  assert.notEqual(previews.getView().state.status, 'current', 'the preview is dropped at once');
  assert.equal(previews.getView().canRequest, false);
  let lent = false;
  assert.equal(await port.withCsrf(signedIn.epoch, async () => (lent = true)), SESSION_GONE, "A's CSRF is not lent again");
  assert.equal(lent, false);
  const logouts = calls.filter((call) => call.route === 'logout');
  assert.equal(logouts.length, 1, "A's session is signed out");
  assert.equal(logouts[0].args[0], csrf, 'with its own CSRF');
  assert.equal(client.calls.length, 1, 'and nothing more is sent');
  previews.dispose();
});

// ---- the previews' scope names the connector instance, like B2's private scope ----

test("the session key names the connector instance too: another provider alone changes it, as it changes B2's private scope", () => {
  const viaA = toSessionSnapshot(snap(SIGNED_IN, connected(), 3), NONE);
  const viaB = toSessionSnapshot(snap(SIGNED_IN, { ...connected(), connectorUid: 'uid-b' }, 3), NONE);
  assert.equal(viaA.kind, 'signed_in');
  assert.equal(viaB.kind, 'signed_in');
  assert.notEqual(sessionKey(viaB), sessionKey(viaA), 'the same owner, chain and epoch through another connector instance');
});

test('a preview fetched through one connector instance is dropped when only the instance changes, even under a controller that kept its epoch', async () => {
  const controller = fakeController(snap(SIGNED_IN));
  const port = createSessionPort(controller);
  const clock = fakeClock();
  const client = { calls: [], preview: (route, request, options) => new Promise((resolve) => client.calls.push({ route, request, options, resolve })) };
  const previews = createPreviewController('swap-preview', { client, port, clock, budget: createPreviewBudget({ clock }) });
  previews.start();
  previews.setForm(buildSwapRequest(SWAP_FORM, consumerTestCatalog));
  previews.request();
  await flush();
  client.calls[0].resolve({ ok: true, preview: SWAP, requestId: null });
  await flush();
  assert.equal(previews.getView().state.status, 'current');
  controller.set(snap(SIGNED_IN, { ...connected(), connectorUid: 'uid-b' }));
  assert.notEqual(previews.getView().state.status, 'current', "what came through A's instance is not shown for B's");
  assert.equal(client.calls.length, 1);
  previews.dispose();
});
