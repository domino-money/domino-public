import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build, fakeClock, fakeSession, fixture, flush, OWNER, OTHER, runtime, sentFor } from './support/crosschain.mjs';

const require = createRequire(import.meta.url);
const { createAuthenticatedRequestCoordinator, authenticatedRequestPriority, authenticatedRetryDelay } = require('../../.test-build/app/src/finance/v2/requestCoordinator.js');
const { createCrosschainClient, quoteDeadlineMono } = build('client');
const { createHttpCrosschainTransport } = build('httpTransport');

function environment() {
  const clock = fakeClock();
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let tail = Promise.resolve();
  const lock = (_key, work) => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
  const make = () => createAuthenticatedRequestCoordinator({ clock: { now: clock.monoMs, setTimer: clock.setTimer }, storage, lock });
  return { clock, values, make };
}
const request = (priority = 'preview', extra = {}) => ({ owner: OWNER, priority, isCurrent: () => true, ...extra });
const send = (coordinator, log, label, options = request()) => coordinator.schedule(options, async () => { log.push(label); return label; });

test('only authenticated crosschain and position-plan paths share this budget; capabilities and public reads are independent', () => {
  assert.equal(authenticatedRequestPriority('/api/crosschain/v1/origins'), 'preview');
  assert.equal(authenticatedRequestPriority('/api/crosschain/v1/quote'), 'preview');
  assert.equal(authenticatedRequestPriority('/api/crosschain/v1/status'), 'tracking');
  assert.equal(authenticatedRequestPriority('/api/position-plan/v1/plan'), 'action');
  for (const path of ['/api/read/v6/chain-balances', '/api/read/v6/portfolio', '/api/session/v1/me', '/api/crosschain/v1/capabilities']) {
    assert.equal(authenticatedRequestPriority(path), null, path);
  }
});

test('origins plus quotes share eight preview admissions; status and explicit action can use the two reserved slots, never an eleventh', async () => {
  const env = environment(), coordinator = env.make(), log = [];
  for (let i = 0; i < 8; i++) await send(coordinator, log, i % 2 ? 'quote' : 'origins');
  const queued = send(coordinator, log, 'next quote');
  await flush();
  assert.equal(log.length, 8);
  await send(coordinator, log, 'status', request('tracking'));
  await send(coordinator, log, 'plan', request('action'));
  const eleventh = send(coordinator, log, 'later status', request('tracking'));
  await flush();
  assert.equal(log.length, 10);
  env.clock.advance(59_999); await flush();
  assert.equal(log.length, 10);
  env.clock.advance(1); await flush();
  assert.equal(log[10], 'later status', 'tracking ahead of the older queued quote');
  await Promise.all([queued, eleventh]);
  assert.equal(log.at(-1), 'next quote');
});

test('429 cooldown survives new amount requests and another tab, and expires without a manual retry', async () => {
  const env = environment(), first = env.make(), second = env.make(), log = [];
  await first.defer(OWNER, authenticatedRetryDelay('60', env.clock.monoMs()));
  const one = send(first, log, 'changed amount');
  const two = send(second, log, 'other tab', request('action'));
  await flush();
  env.clock.advance(59_999); await flush();
  assert.deepEqual(log, []);
  env.clock.advance(1); await flush();
  await Promise.all([one, two]);
  assert.equal(log.length, 2);
  assert.ok([...env.values.values()].every(value => !value.includes('csrf') && !value.includes('body')));
});

test('cancelled queued preparations use no slot and a session/account change aborts queued work', async () => {
  const env = environment(), coordinator = env.make(), log = [];
  await coordinator.defer(OWNER, 60_000);
  const controller = new AbortController();
  const cancelled = send(coordinator, log, 'old amount', request('preview', { signal: controller.signal }));
  let current = true;
  const stale = send(coordinator, log, 'old account', request('preview', { isCurrent: () => current }));
  await flush();
  controller.abort();
  current = false; coordinator.wake();
  assert.deepEqual(await cancelled, { kind: 'aborted' });
  assert.deepEqual(await stale, { kind: 'aborted' });
  await send(coordinator, log, 'new account', request('preview', { owner: OTHER }));
  assert.deepEqual(log, ['new account']);
  assert.deepEqual(JSON.parse(env.values.get('domino.request-budget.v1.' + OWNER)).asked, []);
});

test('simultaneous tabs make atomic reservations and cannot each spend the same ten account slots', async () => {
  const env = environment(), first = env.make(), second = env.make(), log = [];
  const requests = Array.from({ length: 12 }, (_, i) => send(i % 2 ? first : second, log, i, request('tracking')));
  await flush();
  assert.equal(log.length, 10);
  assert.equal(JSON.parse(env.values.get('domino.request-budget.v1.' + OWNER)).asked.length, 10);
  env.clock.advance(60_000); await flush();
  await Promise.all(requests);
  assert.equal(log.length, 12);
});

test('one tab starts at most two requests and prioritizes tracking/action ahead of queued speculation', async () => {
  const env = environment(), coordinator = env.make(), log = [], finish = [];
  const active = Array.from({ length: 2 }, (_, i) => coordinator.schedule(request(), () => new Promise(resolve => {
    log.push(`active ${i}`); finish.push(resolve);
  })));
  await flush();
  const preview = send(coordinator, log, 'preview');
  const action = send(coordinator, log, 'action', request('action'));
  const tracking = send(coordinator, log, 'tracking', request('tracking'));
  await flush();
  assert.equal(log.length, 2);
  finish[0](); await flush();
  assert.deepEqual(log.slice(2), ['tracking', 'action', 'preview']);
  finish[1]();
  await Promise.all([...active, preview, action, tracking]);
});

test('a rate-limited request delays already queued work, not just requests created after its reply', async () => {
  const env = environment(), coordinator = env.make(), log = [];
  await coordinator.defer(OWNER, 10_000);
  const queued = send(coordinator, log, 'quote');
  await flush();
  env.clock.advance(9_000); await flush();
  await coordinator.defer(OWNER, 60_000);
  env.clock.advance(1_000); await flush();
  assert.deepEqual(log, []);
  env.clock.advance(59_000); await flush();
  await queued;
  assert.deepEqual(log, ['quote']);
});

test('crosschain quote send time starts at HTTP admission, excluding a long budget queue from quote age', async () => {
  const env = environment(), coordinator = env.make();
  const response = fixture('responses/quote.json');
  await coordinator.defer(OWNER, 60_000);
  const start = env.clock.monoMs();
  const transport = createHttpCrosschainTransport({ post: async (_url, _init, options) => {
    const scheduled = await coordinator.schedule(request(), async () => {
      options.onStart?.();
      return { kind: 'reply', reply: {
        status: 200, opaqueRedirect: false, contentType: 'application/json', contractHeader: '1.1.0-rc.1',
        requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: JSON.stringify(response) },
      } };
    });
    return scheduled.value;
  } });
  const client = createCrosschainClient({ transport, runtime, session: fakeSession(), clock: env.clock });
  const pending = client.quote(sentFor('quote', response), { owner: OWNER });
  await flush();
  env.clock.advance(60_000); await flush();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.timing.sentMono, start + 60_000);
  assert.equal(quoteDeadlineMono(response.quote, result.timing) - result.timing.receivedMono,
    Math.min(response.quote.expiresAt - response.quote.requestedAt, response.quote.expiresAt - response.quote.retrievedAt) * 1000);
});

test('Retry-After is bounded and missing/invalid values use the conservative service window', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(authenticatedRetryDelay('12', now), 12_000);
  assert.equal(authenticatedRetryDelay('Sat, 10 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(authenticatedRetryDelay('999999999999999999999', now), 300_000);
  for (const value of [null, 'bad', '0', '-10']) assert.equal(authenticatedRetryDelay(value, now), 60_000);
});

test('a starved action settles as timeout after 120s without sending or consuming admission', async () => {
  const env = environment(), coordinator = env.make(), log = [];
  await coordinator.defer(OWNER, 300_000);
  const action = send(coordinator, log, 'plan', request('action'));
  await flush();
  env.clock.advance(119_999); await flush();
  assert.deepEqual(log, []);
  env.clock.advance(1); await flush();
  assert.deepEqual(await action, { kind: 'timeout' });
  assert.deepEqual(log, []);
  env.clock.advance(300_000); await flush();
  assert.deepEqual(log, [], 'expired queued work cannot send later');
  assert.deepEqual(JSON.parse(env.values.get('domino.request-budget.v1.' + OWNER)).asked, []);
});

test('a rejected Web Lock fails the request instead of leaving its promise pending or spinning', async () => {
  const clock = fakeClock();
  const coordinator = createAuthenticatedRequestCoordinator({
    clock: { now: clock.monoMs, setTimer: clock.setTimer },
    lock: async () => { throw new Error('document unavailable'); },
  });
  const log = [];
  await assert.rejects(send(coordinator, log, 'quote'), /document unavailable/);
  await flush();
  assert.deepEqual(log, []);
  assert.deepEqual(clock.pending(), [], 'no orphan timer retrying a failed lock');
});

test('a queued deadline settles even while a Web Lock is held, and its eventual callback cannot send', async () => {
  const clock = fakeClock();
  let unlock;
  const coordinator = createAuthenticatedRequestCoordinator({
    clock: { now: clock.monoMs, setTimer: clock.setTimer },
    lock: (_key, work) => new Promise(resolve => { unlock = () => resolve(work()); }),
  });
  const log = [], pending = send(coordinator, log, 'quote');
  await flush();
  clock.advance(120_000); await flush();
  assert.deepEqual(await pending, { kind: 'timeout' });
  unlock(); await flush();
  assert.deepEqual(log, []);
  assert.deepEqual(clock.pending(), []);
});
