/**
 * The preview controller (#38): requests only on the user's action; any change
 * of inputs, account, network or session drops the preview and aborts what is
 * in flight; a hard stop at expiry on the monotonic clock, whatever the device
 * clock says; expired-on-arrival; no automatic retry; the budget and the
 * server's cooldown. The client, the session port and the clock are fakes the
 * test drives.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_SESSION, build, clone, fakeClock, fakePort, fixture, flush } from './support/consumer-fakes.mjs';

const { createPreviewController } = build('onboarding/controller');
const { createPreviewBudget } = build('onboarding/budget');
const { buildSwapRequest, buildPositionRequest } = build('onboarding/inputs');
const { consumerTestCatalog } = build('onboarding/catalog');

const SWAP_OWNER = '0x4444444444444444444444444444444444444444';
const SWAP_FORM = {
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountRaw: '1000',
  slippageBps: '50',
  maxPriceImpactBps: '100',
};
const SWAP = fixture('onboarding-v1', 'responses/swap-preview.json').preview;
const POSITION = fixture('onboarding-v1', 'responses/position-preview.json').preview;
const swapForm = (patch = {}) => buildSwapRequest({ ...SWAP_FORM, ...patch }, consumerTestCatalog);

function fakeClient() {
  const calls = [];
  return {
    calls,
    preview(route, request, options) {
      return new Promise((resolve) => calls.push({ route, request, options, resolve }));
    },
  };
}

function harness({ route = 'swap-preview', port = fakePort({ owner: SWAP_OWNER }), clock = fakeClock(), channel = null, limit, form } = {}) {
  const client = fakeClient();
  const budget = createPreviewBudget({ clock, channel, ...(limit ? { limit } : {}) });
  const controller = createPreviewController(route, { client, port, clock, budget });
  controller.start();
  controller.setForm(form ?? swapForm());
  const view = () => controller.getView();
  const state = () => view().state;
  async function answer(result) {
    const call = client.calls.at(-1);
    call.resolve(result);
    await flush();
    return call;
  }
  return { client, port, clock, budget, controller, view, state, answer };
}

const ok = (preview = SWAP) => ({ ok: true, preview, requestId: null });
const failed = (failure) => ({ ok: false, failure, requestId: 'req' });

test('nothing is requested until the user asks; one request, then the preview is current', async () => {
  const h = harness();
  assert.equal(h.state().status, 'ready');
  assert.equal(h.view().canRequest, true);
  assert.equal(h.client.calls.length, 0);
  h.controller.request();
  await flush();
  assert.equal(h.state().status, 'loading');
  assert.equal(h.client.calls.length, 1);
  assert.equal(h.client.calls[0].options.csrf, 'c'.repeat(43), 'the CSRF lent for this request');
  assert.equal(h.client.calls[0].options.sessionOwner, SWAP_OWNER);
  await h.answer(ok());
  assert.equal(h.state().status, 'current');
  assert.equal(h.state().secondsLeft, 30);
  assert.deepEqual(h.port.lends, [1]);
});

test('a preview is current until 29 s and expired at 30 s after it was sent; nothing re-requests it (T-16, T-18)', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  await h.answer(ok());
  h.clock.advance(29_000);
  assert.equal(h.state().status, 'current');
  assert.equal(h.state().secondsLeft, 1);
  h.clock.advance(1_000);
  assert.equal(h.state().status, 'expired');
  assert.ok(!('preview' in h.state()), 'its figures are gone');
  h.clock.advance(3_600_000);
  assert.equal(h.client.calls.length, 1, 'expiry never sends');
  assert.equal(h.view().canRequest, true, 'Refresh preview is a manual action');
});

test('the deadline is the smaller of the two server-measured durations, and the device clock changes nothing (E-5, OP-6)', async () => {
  for (const [roundTrip, expected] of [
    [8_000, 28_000],
    [12_000, 30_000],
  ]) {
    const h = harness();
    const start = h.clock.monoMs();
    h.controller.request();
    await flush();
    h.clock.advance(roundTrip);
    // A device clock an hour off makes no difference: only durations are used.
    h.clock.setWall(Date.parse('2031-01-01T00:00:00Z'));
    const preview = { ...clone(SWAP), requestedAt: 1000, retrievedAt: 1010, expiresAt: 1030 };
    await h.answer(ok(preview));
    assert.equal(h.state().deadlineMono - start, expected, `round trip ${roundTrip}`);
    h.clock.advance(expected - roundTrip - 1);
    assert.equal(h.state().status, 'current');
    h.clock.advance(1);
    assert.equal(h.state().status, 'expired');
  }
});

test('preparedDeadline never keeps a position preview alive (T-17)', async () => {
  const form = buildPositionRequest(
    {
      poolId: '0x25431634fd7de72516ccb751020a1a9188376a983ccc5f6c1152ca04a6acffad',
      independent: '0',
      amountRaw: '100',
      tickLower: '-120',
      tickUpper: '180',
      slippageBps: '50',
      budget0Raw: '110',
      budget1Raw: '220',
      nativeBalanceRaw: '1000',
      nativeGasReserveRaw: '300',
    },
    consumerTestCatalog,
  );
  const h = harness({ route: 'position-preview', port: fakePort(), form });
  h.controller.request();
  await flush();
  await h.answer(ok(POSITION));
  assert.equal(POSITION.preparedDeadline - POSITION.requestedAt, 1200);
  h.clock.advance(30_000);
  assert.equal(h.state().status, 'expired');
});

test('a preview that arrives already past its deadline is never shown; a second in a row adds the hint (OP-11)', async () => {
  const h = harness({ limit: 3 });
  h.controller.request();
  await flush();
  h.clock.advance(31_000);
  await h.answer(ok());
  assert.equal(h.state().status, 'failed');
  assert.deepEqual(h.state().failure, { kind: 'expired_on_arrival', retry: 'manual', repeated: false });
  assert.equal(h.view().canRequest, true);
  h.controller.request();
  await flush();
  assert.equal(h.client.calls.length, 2, 'Refresh spends exactly one request');
  h.clock.advance(31_000);
  await h.answer(ok());
  assert.equal(h.state().failure.repeated, true);
  h.controller.request();
  await flush();
  await h.answer(ok());
  assert.equal(h.state().status, 'current', 'a good one resets the run');
  assert.equal(h.client.calls.length, 3);
});

test('any input change aborts the request in flight and drops the preview; a late answer changes nothing (INV-1, T-20, T-21)', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  const first = h.client.calls[0];
  h.controller.setForm(swapForm({ amountRaw: '1001' }));
  assert.equal(first.options.signal.aborted, true);
  assert.equal(h.state().status, 'ready');
  first.resolve(ok());
  await flush();
  assert.equal(h.state().status, 'ready', 'the late answer is ignored');

  h.controller.request();
  await flush();
  await h.answer(ok({ ...clone(SWAP), request: { ...SWAP.request, amountRaw: '1001' } }));
  assert.equal(h.state().status, 'current');
  h.controller.setForm(swapForm({ slippageBps: '60' }));
  assert.equal(h.state().status, 'ready', 'a current preview is dropped too');
  h.controller.setForm(swapForm({ slippageBps: 'x' }));
  assert.equal(h.state().status, 'editing');
  assert.equal(h.view().canRequest, false);
  h.controller.setForm(swapForm({ slippageBps: 'x' }));
  assert.equal(h.client.calls.length, 2);
});

test('an account, network or session change drops the preview and aborts; an eligible session with a bad form is editing (INV-3/4/5, OP-12)', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  await h.answer(ok());
  assert.equal(h.state().status, 'current');

  // A new server session (another CSRF) for the same owner is a new epoch.
  h.port.set({ kind: 'signed_in', owner: SWAP_OWNER, chainId: 4663, epoch: 2, connectorUid: 'uid-a' });
  assert.equal(h.state().status, 'ready');

  h.controller.request();
  await flush();
  const inFlight = h.client.calls.at(-1);
  h.port.set({ kind: 'wrong_network', chainId: 1 });
  assert.equal(inFlight.options.signal.aborted, true);
  assert.deepEqual([h.state().status, h.state().block], ['ineligible', 'wrong_network']);
  inFlight.resolve(ok());
  await flush();
  assert.equal(h.state().status, 'ineligible', 'nothing from the old session lands');

  for (const kind of ['signed_out', 'wallet_account_differs', 'no_wallet', 'session_busy']) {
    h.port.set({ kind, retryAfterS: null });
    assert.deepEqual([h.state().status, h.state().block], ['ineligible', kind]);
  }
  h.controller.setForm(swapForm({ amountRaw: '' }));
  h.port.set({ kind: 'signed_in', owner: SWAP_OWNER, chainId: 4663, epoch: 3, connectorUid: 'uid-a' });
  assert.equal(h.state().status, 'editing');
  assert.equal(h.state().issues[0].field, 'amountRaw');
});

test('a failure replaces the preview; a session denial is reported with its epoch, never retried (INV-8, T-28)', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  await h.answer(ok());
  h.clock.advance(5_000);
  h.controller.request();
  await flush();
  assert.equal(h.client.calls.length, 1, 'a current preview is not re-requested; Refresh comes after expiry');
  h.clock.advance(25_000);
  h.controller.request();
  await flush();
  assert.equal(h.state().status, 'loading', 'the expired preview stays gone while a new one is asked for');
  await h.answer(failed({ kind: 'signed_out', retry: 'none', code: 'session_required', status: 401, denial: 'session_required' }));
  assert.equal(h.state().status, 'failed');
  assert.deepEqual(h.port.denials, [{ code: 'session_required', epoch: 1 }]);
  assert.equal(h.view().canRequest, false);
  h.clock.advance(600_000);
  assert.equal(h.client.calls.length, 2);
});

test('a 429 disables the action for Retry-After with no automatic retry, then allows it again (T-27)', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  await h.answer(failed({ kind: 'rate_limited', retry: 'after', code: 'session_rate_limited', status: 429, retryAfterS: 60 }));
  assert.equal(h.view().canRequest, false);
  assert.equal(h.view().budget.reason, 'cooldown');
  h.clock.advance(59_000);
  assert.equal(h.view().canRequest, false);
  h.clock.advance(1_100);
  assert.equal(h.view().canRequest, true);
  assert.equal(h.client.calls.length, 1, 'nothing was sent on its own');
});

test('eight sends per rolling minute, then the action waits (R-9, T-34)', async () => {
  const h = harness();
  for (let i = 0; i < 8; i += 1) {
    h.controller.setForm(swapForm({ amountRaw: String(1000 + i) }));
    h.controller.request();
    await flush();
    await h.answer(failed({ kind: 'timed_out', retry: 'manual' }));
  }
  assert.equal(h.client.calls.length, 8);
  assert.equal(h.view().canRequest, false);
  assert.equal(h.view().budget.reason, 'budget');
  h.controller.request();
  await flush();
  assert.equal(h.client.calls.length, 8);
  h.clock.advance(60_001);
  assert.equal(h.view().canRequest, true);
});

test('a cooldown reaches every open tab; a tab opened later starts with a full budget (OP-13)', () => {
  const clock = fakeClock();
  const listeners = [];
  const bus = () => ({
    post: (message) => listeners.filter((entry) => entry.self !== bus).forEach((entry) => entry.listener(message)),
    listen(listener) {
      const entry = { listener };
      listeners.push(entry);
      return () => listeners.splice(listeners.indexOf(entry), 1);
    },
  });
  const tabA = createPreviewBudget({ clock, channel: bus() });
  const tabB = createPreviewBudget({ clock, channel: bus() });
  tabA.connect();
  tabB.connect();
  tabA.cooldown(60);
  assert.equal(tabB.check().reason, 'cooldown');
  // Messages that are not the budget's own shape are ignored.
  for (const entry of listeners) entry.listener({ t: 'cooldown', ms: 10_000_000 });
  for (const entry of listeners) entry.listener({ t: 'spent', extra: true });
  clock.advance(60_001);
  assert.equal(tabB.check().ok, true);
  const later = createPreviewBudget({ clock, channel: null });
  assert.equal(later.check().ok, true);
});

test('a session that cannot lend its CSRF is ineligible and sends nothing', async () => {
  const h = harness({ port: fakePort({ owner: SWAP_OWNER, csrfAccess: false }) });
  assert.deepEqual([h.state().status, h.state().block], ['ineligible', 'session_access_unavailable']);
  h.controller.request();
  await flush();
  assert.equal(h.client.calls.length, 0);
  const off = harness({ port: fakePort({ snapshot: { kind: 'off' } }) });
  assert.equal(off.state().block, 'session_off');
});

test('a session gone between the click and the send lands on signed out, with nothing sent', async () => {
  const port = fakePort({ owner: SWAP_OWNER });
  port.withCsrf = () => Promise.resolve(NO_SESSION);
  const h = harness({ port });
  h.controller.request();
  await flush();
  assert.equal(h.client.calls.length, 0);
  assert.deepEqual([h.state().status, h.state().block], ['ineligible', 'signed_out']);
});

test('disposing aborts what is in flight', async () => {
  const h = harness();
  h.controller.request();
  await flush();
  h.controller.dispose();
  assert.equal(h.client.calls[0].options.signal.aborted, true);
});
