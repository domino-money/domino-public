/**
 * Tracking a deposit (spec F7 §3.7, §8.2 S2): every call carries the state last shown as `previousState`; the
 * answer's `nextCheckSeconds` sets the next ask; a `held` answer never moves the screen back; terminal stops; a
 * deposit the provider cannot match stops with its hash; busy answers back off; an unexpected answer gets one more
 * attempt. Driven through the fixture transport and the real runtime on a clock the test moves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, clone, fixture, flush, lab, OWNER, runtime } from './support/crosschain.mjs';

const { reduceStatus, initialPoll, createStatusPoller, fallbackSeconds, FALLBACK_POLL_SECONDS, MAX_WAIT_SECONDS, UNEXPECTED_RETRIES } = build('polling');
const { reply } = build('fixtureTransport');
const { presentStatus, naming } = build('present');

const HASH = `0x${'d1'.repeat(32)}`;
const RELAY_ID = '0x17909043250328e5f8f2ae0821aaa72bdd1aa0b373c81bdf0b7996f4545b05af';
const relayRecord = (lastState = null) => ({ provider: 'relay', originChainId: 42161, destinationChainId: 4663, depositTxHash: HASH, requestId: RELAY_ID, lastState });
const acrossRecord = (lastState = null) => ({ provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: HASH, requestId: null, lastState });

/** A status answer derived from a package fixture, re-validated by the runtime so a derivation can never drift from the contract. */
function derived(name, change) {
  const body = clone(fixture(name));
  change(body.status);
  assert.ok(runtime.validateResponse('status', body), `derived from ${name} must stay valid`);
  return body;
}
const PENDING_FEE = { amountRaw: null, chainId: null, evidence: null, reason: 'deposit_not_filled', status: 'pending', token: null };
const relayPending = () =>
  derived('variants/status.relay-awaiting.json', (s) => {
    Object.assign(s, { observedState: 'pending', state: 'pending', transition: 'advanced', providerStatus: 'pending', nextCheckSeconds: 5 });
    s.request.previousState = 'awaiting_deposit';
  });
const acrossHeldPending = () =>
  derived('responses/status.json', (s) => {
    Object.assign(s, {
      observedState: 'awaiting_deposit',
      state: 'pending',
      transition: 'held',
      terminal: false,
      nextCheckSeconds: 10,
      providerStatus: null,
      fillTxHash: null,
      fee: PENDING_FEE,
    });
    s.request.previousState = 'pending';
  });

function poller(record) {
  const env = lab();
  const updates = [];
  const poll = createStatusPoller({ client: env.client, runtime, clock: env.clock, owner: OWNER, record, onUpdate: (state) => updates.push(state) });
  return { ...env, poll, updates, sent: () => env.transport.calls('status').map((call) => call.body) };
}

test('the fallback table is the package’s pollSeconds; nextCheckSeconds governs whenever there is an answer', async () => {
  const { CONSTANTS } = await import(new URL('../../../api-contracts/crosschain-v1/schema-data.mjs', import.meta.url).href);
  assert.deepEqual(JSON.parse(JSON.stringify(FALLBACK_POLL_SECONDS)), CONSTANTS.pollSeconds);
  assert.equal(fallbackSeconds('relay', null), 5);
  assert.equal(fallbackSeconds('across', 'refund_pending'), 300);
  assert.equal(fallbackSeconds('relay', 'refund_failed'), 900);
  assert.equal(fallbackSeconds('relay', 'refund_pending'), 5, 'a state the provider never reports falls back to its first interval');
  assert.equal(MAX_WAIT_SECONDS, 300);
  assert.equal(UNEXPECTED_RETRIES, 1);
});

test('Relay: null → awaiting (5 s) → pending (5 s) → filled, each call carrying the state shown, then nothing more', async () => {
  const t = poller(relayRecord());
  t.transport.script('status', reply(200, fixture('variants/status.relay-awaiting.json')), reply(200, relayPending()), reply(200, fixture('variants/status.relay-filled.json')));
  t.poll.start();
  await flush();
  assert.equal(t.updates.at(-1).record.lastState, 'awaiting_deposit');
  assert.deepEqual(t.clock.pending(), [5_000]);
  t.clock.advance(4_999);
  await flush();
  assert.equal(t.sent().length, 1, 'not before nextCheckSeconds');
  t.clock.advance(1);
  await flush();
  assert.equal(t.updates.at(-1).record.lastState, 'pending');
  t.clock.advance(5_000);
  await flush();
  const last = t.updates.at(-1);
  assert.equal(last.record.lastState, 'filled');
  assert.equal(last.stopped, 'terminal');
  assert.equal(last.fillTxHash, `0x${'f1'.repeat(32)}`);
  assert.deepEqual(t.sent().map((body) => body.previousState), [null, 'awaiting_deposit', 'pending']);
  assert.ok(t.sent().every((body) => body.provider === 'relay' && body.requestId === RELAY_ID && body.depositTxHash === HASH));
  assert.deepEqual(t.clock.pending(), [], 'terminal stops the polling');
  t.clock.advance(3_600_000);
  await flush();
  assert.equal(t.sent().length, 3);
  assert.deepEqual(t.transport.unscripted(), []);
  // The screen at each step, with the spec's words.
  const name = naming(fixture('responses/origins.json').origins);
  const view = presentStatus({ report: last.report, shown: last.record.lastState, fillTxHash: last.fillTxHash, provider: 'relay', originChainId: 42161, destinationChainId: 4663, name });
  assert.equal(view.text, 'Arrived in your wallet on Robinhood Chain.');
  assert.deepEqual(view.link, { kind: 'fill', chainId: 4663, hash: `0x${'f1'.repeat(32)}` });
  assert.equal(view.next, 'Create a position on Robinhood Chain');
  assert.deepEqual(view.feeDetail, { status: 'measured', words: 'measured', amount: '0.35 USDC' });
});

test('Across resumed from the journal at pending: the base fixture fills it and the polling stops', async () => {
  const t = poller(acrossRecord('pending'));
  t.transport.script('status', reply(200, fixture('responses/status.json')));
  t.poll.start();
  await flush();
  assert.deepEqual(t.sent(), [fixture('requests/status.json')]);
  assert.equal(t.updates.at(-1).stopped, 'terminal');
  assert.equal(t.updates.at(-1).record.lastState, 'filled');
  assert.deepEqual(t.clock.pending(), []);
});

test('a held answer never moves the screen back: mid-flight it stays pending, after the fill it stays filled', async () => {
  const mid = poller(acrossRecord('pending'));
  mid.transport.script('status', reply(200, acrossHeldPending()));
  mid.poll.start();
  await flush();
  const state = mid.updates.at(-1);
  assert.equal(state.report.transition, 'held');
  assert.equal(state.report.observedState, 'awaiting_deposit');
  assert.equal(state.record.lastState, 'pending', 'the screen does not go back to awaiting');
  assert.deepEqual(mid.clock.pending(), [10_000]);

  const after = poller(acrossRecord('filled'));
  after.transport.script('status', reply(200, fixture('variants/status.across-held.json')));
  after.poll.start();
  await flush();
  const held = after.updates.at(-1);
  assert.equal(held.record.lastState, 'filled');
  assert.equal(held.stopped, 'terminal');
  assert.deepEqual(after.sent().map((b) => b.previousState), ['filled'], 'a terminal record is asked once, then never again');
  // The reducer applies the runtime's advance once more: even an answer that tried to go back cannot.
  const forged = { ok: true, route: 'status', data: { status: { ...fixture('variants/status.across-held.json').status, state: 'awaiting_deposit', terminal: false, nextCheckSeconds: 10 } } };
  const step = reduceStatus(initialPoll(acrossRecord('filled')), forged, runtime);
  assert.equal(step.state.record.lastState, 'filled');
  assert.deepEqual(runtime.advance('filled', 'pending'), ['filled', 'held']);
});

test('a kept fill hash survives a later held answer that has none', () => {
  const filled = { ok: true, route: 'status', data: fixture('responses/status.json') };
  const first = reduceStatus(initialPoll(acrossRecord('pending')), filled, runtime).state;
  const again = reduceStatus({ ...first, stopped: null }, { ok: true, route: 'status', data: fixture('variants/status.across-held.json') }, runtime).state;
  assert.equal(again.report.fillTxHash, null);
  assert.equal(again.fillTxHash, `0x${'f1'.repeat(32)}`);
});

test('Across not filled in time: refund pending, asked again after 300 s, with the spec’s words and no fee said', async () => {
  const t = poller(acrossRecord('pending'));
  t.transport.script('status', reply(200, fixture('variants/status.across-refund-pending.json')));
  t.poll.start();
  await flush();
  const state = t.updates.at(-1);
  assert.equal(state.record.lastState, 'refund_pending');
  assert.equal(state.stopped, null);
  assert.deepEqual(t.clock.pending(), [300_000]);
  const view = presentStatus({ report: state.report, shown: 'refund_pending', provider: 'across', originChainId: 42161, destinationChainId: 4663, originToken: 'USDC', name: naming(fixture('responses/origins.json').origins) });
  // Changed on purpose 2026-10-06 (the owner: one name for one network): the app's own name, Arbitrum One.
  assert.equal(view.text, 'Not filled in time. Across will refund USDC to your wallet on Arbitrum One, usually 2.5 to 3 hours after your deposit.');
  assert.equal(view.feeDetail, null, 'the fee is never shown before filled');
  assert.equal(view.terminal, false);
});

test('crosschain_deposit_not_found stops the polling and keeps the hash to show', async () => {
  const t = poller(relayRecord('awaiting_deposit'));
  t.transport.script('status', reply(404, fixture('errors.json').crosschain_deposit_not_found.body));
  t.poll.start();
  await flush();
  const state = t.updates.at(-1);
  assert.equal(state.stopped, 'not_found');
  assert.equal(state.notice.copy, "We couldn't match this deposit to your wallet. Check the transaction in the explorer.");
  assert.equal(state.notice.code, 'crosschain_deposit_not_found');
  assert.equal(state.record.depositTxHash, HASH);
  assert.equal(state.record.lastState, 'awaiting_deposit', 'nothing shown moves');
  assert.deepEqual(t.clock.pending(), []);
});

test('busy answers back off: Retry-After, then twice that; an answer resets it; waits never pass five minutes', async () => {
  const t = poller(relayRecord());
  const busy = fixture('errors.json').provider_rate_limited.body;
  t.transport.script('status', reply(429, busy, { retryAfter: '7' }), reply(429, busy, { retryAfter: '7' }), reply(200, fixture('variants/status.relay-awaiting.json')));
  t.poll.start();
  await flush();
  assert.deepEqual(t.clock.pending(), [7_000]);
  assert.equal(t.updates.at(-1).notice.copy, 'Too many requests. Try again in a moment.');
  t.clock.advance(7_000);
  await flush();
  assert.deepEqual(t.clock.pending(), [14_000]);
  t.clock.advance(14_000);
  await flush();
  assert.equal(t.updates.at(-1).failures, 0);
  assert.equal(t.updates.at(-1).notice, null);
  assert.deepEqual(t.clock.pending(), [5_000]);
  assert.deepEqual(t.sent().map((b) => b.previousState), [null, null, null], 'nothing was shown, so nothing moved');

  // 503s and network failures grow from the fallback interval, capped.
  let state = initialPoll(acrossRecord('refund_pending'));
  const unavailable = { ok: false, route: 'status', failure: { kind: 'error', code: 'upstream_unavailable', status: 503, retryAfterS: 60 } };
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const step = reduceStatus(state, unavailable, runtime);
    state = step.state;
    waits.push(step.next.ms);
  }
  assert.deepEqual(waits, [300_000, 300_000, 300_000, 300_000]);
  state = initialPoll(relayRecord('pending'));
  const net = [];
  for (let i = 0; i < 8; i += 1) {
    const step = reduceStatus(state, { ok: false, route: 'status', failure: { kind: 'network' } }, runtime);
    state = step.state;
    net.push(step.next.ms);
  }
  assert.deepEqual(net, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(state.stopped, null, 'a deposit in flight is never given up on for a busy service');
});

test('an unexpected answer gets one more attempt, then the polling stops; the same for one this page refuses', async () => {
  const t = poller(relayRecord('pending'));
  const mismatch = fixture('errors.json').upstream_contract_mismatch.body;
  t.transport.script('status', reply(502, mismatch), reply(502, mismatch));
  t.poll.start();
  await flush();
  assert.deepEqual(t.clock.pending(), [5_000]);
  t.clock.advance(5_000);
  await flush();
  assert.equal(t.updates.at(-1).stopped, 'unexpected');
  assert.equal(t.updates.at(-1).notice.copy, 'We got an unexpected answer. Try again.');
  assert.deepEqual(t.clock.pending(), []);

  const v = poller(relayRecord('pending'));
  v.transport.script('status', reply(200, relayPending(), { contract: '1.0.0-rc.2' }), reply(200, fixture('variants/status.relay-filled.json'), { contract: null, status: 500 }));
  v.poll.start();
  await flush();
  v.clock.advance(5_000);
  await flush();
  assert.equal(v.updates.at(-1).stopped, 'unexpected');
  assert.equal(v.updates.at(-1).record.lastState, 'pending', 'nothing from a refused answer is shown');
});

test('a session refusal reports the denial and stops; the route missing turns the feature off', async () => {
  const t = poller(relayRecord('pending'));
  t.transport.script('status', reply(401, fixture('errors.json').session_required.body));
  t.poll.start();
  await flush();
  assert.equal(t.updates.at(-1).stopped, 'session');
  assert.deepEqual(t.session.denials, ['session_required']);
  const off = poller(relayRecord('pending'));
  off.transport.script('status', reply(404, '{"error":"not_found"}', { contract: null }));
  off.poll.start();
  await flush();
  assert.equal(off.updates.at(-1).stopped, 'feature_off');
  assert.equal(off.updates.at(-1).notice.copy, "Deposits from another network aren't available right now.");
});

test('stop() cancels the timer and drops a call in flight', async () => {
  const t = poller(relayRecord());
  t.transport.script('status', reply(200, fixture('variants/status.relay-awaiting.json')));
  t.poll.start();
  t.poll.start();
  t.poll.stop();
  await flush();
  assert.equal(t.updates.length, 0, 'the answer to a stopped poll is ignored');
  assert.equal(t.sent().length, 1, 'start twice asks once');
  assert.deepEqual(t.clock.pending(), []);
  assert.equal(t.poll.current().stopped, 'aborted');
});
