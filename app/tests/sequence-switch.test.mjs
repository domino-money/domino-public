/**
 * A sequence's Turn on and Pause (the owner, 2026-09-25: "vamos ligar tudo"), as lib/automate/switchGate.ts decides
 * them for components/positions/SequenceSwitch.tsx. Turn on is a promise that something will run, so it is offered
 * only on the automation service's own fresh word for this owner, this vault and this signed-in session: never on a
 * "not ready", an error (which the availability client answers as not ready, finance/automationAvailability.ts), the
 * wrong owner, the wrong vault, another session, an old answer, or with no session. Pause needs no service.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const { NOT_READY_RECHECK_MS, READY_KEEP_MS, READY_RENEW_LEAD_MS, READY_RENEW_MIN_MS, READY_RENEW_MS, readyFor, readyUntil, renewIn, switchOffer } = require('../.test-build/app/src/lib/automate/switchGate.js');
const { automationAvailable, automationReadyUntil } = require('../.test-build/app/src/finance/automationAvailability.js');
const { createReleaseWatch, readRelease } = require('../.test-build/app/src/finance/release.js');

const drainRelease = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function releaseWatchFixture(read) {
  let now = 0, shown = true, wake = () => {};
  const timers = new Set(), calls = [];
  const ports = { now: () => now, visible: () => shown,
    later(fn, ms) { const timer = { fn, at: now + ms }; timers.add(timer); return () => timers.delete(timer); },
    visibility(fn) { wake = fn; return () => { wake = () => {}; }; },
  };
  const watch = createReleaseWatch(signal => { calls.push(signal); return read(signal, calls.length); }, ports);
  return { watch, calls, timers,
    async advance(ms) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } await drainRelease(); },
    async visibility(value) { shown = value; wake(); await drainRelease(); },
  };
}

test('public release outage recovers without remount and subscribers share the read; every answer remains fail closed', async () => {
  const available = { kind: 'available', deployment: { public: true } };
  const f = releaseWatchFixture(async (_, n) => n === 1 ? { kind: 'unavailable', reason: 'network' } : available);
  const one = [], two = [];
  const stopOne = f.watch(value => one.push(value));
  const stopTwo = f.watch(value => two.push(value));
  await drainRelease();
  assert.equal(f.calls.length, 1);
  assert.equal(one.at(-1).kind, 'unavailable');
  await f.advance(1999); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  assert.equal(one.at(-1), available); assert.deepEqual(one, two);
  stopOne(); await f.advance(60_000); assert.equal(f.calls.length, 3, 'remaining view keeps one bounded refresh');
  stopTwo(); await f.advance(60_000); assert.equal(f.calls.length, 3); assert.equal(f.timers.size, 0);
});

test('release retries stop after three; hidden tabs do no work and returning may recover; definitive refusals do not poll', async () => {
  const f = releaseWatchFixture(async () => ({ kind: 'unavailable', reason: 'timeout' }));
  const stop = f.watch(() => {}); await drainRelease();
  for (const ms of [2000, 10_000, 30_000]) await f.advance(ms);
  assert.equal(f.calls.length, 4); await f.advance(600_000); assert.equal(f.calls.length, 4);
  await f.visibility(false); await f.advance(600_000); assert.equal(f.calls.length, 4);
  await f.visibility(true); assert.equal(f.calls.length, 5); stop();
  for (const reason of ['invalid_release', 'release_not_available', 'gate_required', 'status_429']) {
    const final = releaseWatchFixture(async () => ({ kind: 'unavailable', reason }));
    const leave = final.watch(() => {}); await drainRelease(); await final.advance(600_000);
    assert.equal(final.calls.length, 1, reason); leave();
  }
});

test('release unmount aborts the actual read and effect restart ignores its late result', async () => {
  const resolve = [], answers = [];
  const f = releaseWatchFixture(() => new Promise(done => resolve.push(done)));
  const stop = f.watch(value => answers.push(value));
  stop(); assert.equal(f.calls[0].aborted, true);
  const again = f.watch(value => answers.push(value));
  resolve[1]({ kind: 'unavailable', reason: 'release_not_available' }); await drainRelease();
  resolve[0]({ kind: 'available', deployment: {} }); await drainRelease();
  assert.deepEqual(answers, [{ kind: 'unavailable', reason: 'release_not_available' }]);
  again();
});

test('release GET forwards consumer cancellation to fetch, rather than just ignoring the reply', async () => {
  const owner = new AbortController(); let fetchSignal;
  const result = readRelease('/api/setup/v1/sequence-release', () => ({}), async (_, init) => {
    fetchSignal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, 10_000, owner.signal);
  owner.abort();
  assert.equal(fetchSignal.aborted, true);
  assert.equal((await result).kind, 'unavailable');
});

const OWNER = `0x${'aa'.repeat(20)}`;
const OTHER = `0x${'bb'.repeat(20)}`;
const VAULT = `0x${'56'.repeat(20)}`;
const NOW = 1_790_000_000_000;
const PAUSED = { paused: true, active: false, vault: VAULT };
const ACTIVE = { paused: false, active: true, vault: VAULT };
const STOPPED = { paused: false, active: false, vault: VAULT };
const SIGNED = { kind: 'signed_in', owner: OWNER, chainId: 4663, epoch: 7, connectorUid: 'one' };
// The service's own expiry, 10 seconds after its check, the most the execution contract allows.
const READY = { owner: OWNER, vault: VAULT, epoch: 7, at: NOW - 1000, until: NOW - 1000 + 10_000 };
const offer = (patch = {}) => switchOffer({ sequence: PAUSED, owner: OWNER, session: SIGNED, readiness: READY, now: NOW, liquid: true, ...patch });

test('a paused sequence offers Turn on only on the service’s fresh ready for this owner, vault and session', () => {
  assert.equal(offer(), 'turn-on');
  // Any other answer, or none, offers nothing new: the pill still says Paused.
  const never = {
    'no answer yet': { readiness: null },
    'not ready': { readiness: { ...READY, until: null } },
    'another owner’s answer': { readiness: { ...READY, owner: OTHER } },
    'another vault’s answer': { readiness: { ...READY, vault: `0x${'77'.repeat(20)}` } },
    'another session’s answer': { readiness: { ...READY, epoch: 6 } },
    'an answer gone stale': { now: READY.at + READY_KEEP_MS },
    'an answer past the service’s own expiry': { readiness: { ...READY, until: NOW - 1 } },
    'an answer expiring now': { readiness: { ...READY, until: NOW } },
    'an answer from the future': { now: READY.at - 1 },
    'signed in as someone else': { session: { ...SIGNED, owner: OTHER } },
    'the wallet is not the position’s owner': { owner: null },
    'an empty position': { liquid: false },
    'not one of Domino’s sequences': { sequence: null },
  };
  for (const [why, patch] of Object.entries(never)) assert.equal(offer(patch), null, why);
  assert.equal(offer({ now: READY.at + READY_KEEP_MS - 1 }), 'turn-on', 'fresh until it is kept no longer');
  assert.equal(offer({ readiness: { ...READY, until: NOW + 1 } }), 'turn-on', 'fresh until the service’s own expiry');
  // Casing never makes a match: the addresses are compared lowercase.
  assert.equal(readyFor(READY, OWNER.toUpperCase().replace('0X', '0x'), VAULT, 7, NOW), true);
});

test('with no session Turn on is never offered: connected and signed out, the way to sign in instead; any other state, nothing', () => {
  assert.equal(offer({ session: { kind: 'signed_out' } }), 'sign-in');
  assert.equal(offer({ session: { kind: 'signed_out' }, readiness: null }), 'sign-in');
  for (const kind of ['off', 'pending', 'no_wallet', 'wrong_network', 'wallet_account_differs', 'session_disabled', 'session_busy', 'account_unsupported', 'session_error', 'gate_required']) {
    assert.equal(offer({ session: { kind } }), null, kind);
  }
  // Signed out, but nothing to turn on: an empty position, or another wallet's.
  assert.equal(offer({ session: { kind: 'signed_out' }, liquid: false }), null);
  assert.equal(offer({ session: { kind: 'signed_out' }, owner: null }), null);
});

test('a running sequence offers Pause, with no service and no session; a stopped one offers nothing', () => {
  for (const session of [SIGNED, { kind: 'signed_out' }, { kind: 'session_disabled' }]) {
    assert.equal(offer({ sequence: ACTIVE, session, readiness: null }), 'pause');
    assert.equal(offer({ sequence: ACTIVE, session, readiness: null, liquid: false }), 'pause', 'an empty position can still be paused');
  }
  assert.equal(offer({ sequence: ACTIVE, owner: null }), null, 'never for another wallet’s position');
  assert.equal(offer({ sequence: STOPPED }), null, 'not paused and its permission lost: the docs, not a button');
});

// The service's word as the switch asks it: every failure is "not ready", so the gate above never sees a Turn on.
test('an error, a refusal, a stale or foreign reply, or no session answers not ready, and the switch offers nothing new', async () => {
  const body = { contractVersion: '1.0.0-rc.1', chainId: 4663, owner: OWNER, vault: VAULT, operational: true, checkedAtEpoch: 100, expiresAtEpoch: 110 };
  const port = (session = SIGNED) => ({ csrfAccess: true, getSnapshot: () => session, withCsrf: async (_epoch, fn) => fn('csrf'), reportDenial() {} });
  const reply = (value, status = 200) => async () => new Response(JSON.stringify(value), { status, headers: { 'X-Domino-Execution-Contract': '1.0.0-rc.1' } });
  const cases = {
    'the route is not there (the execution Worker disabled)': [port(), reply({ error: 'route_not_available' }, 404)],
    'the service is unavailable': [port(), reply({ error: 'upstream_unavailable' }, 503)],
    'the network failed': [port(), async () => { throw new TypeError('Failed to fetch'); }],
    'not operational': [port(), reply({ ...body, operational: false, expiresAtEpoch: 100 })],
    'another owner': [port(), reply({ ...body, owner: OTHER })],
    'stale': [port(), reply({ ...body, checkedAtEpoch: 90, expiresAtEpoch: 100 })],
    'signed out': [port({ kind: 'signed_out' }), reply(body)],
  };
  for (const [why, [p, fetcher]] of Object.entries(cases)) {
    const ready = await automationAvailable(OWNER, VAULT, p, fetcher, runtime, () => 100_000);
    assert.equal(ready, false, why);
    const readiness = { owner: OWNER, vault: VAULT, epoch: 7, at: NOW, until: await automationReadyUntil(OWNER, VAULT, p, fetcher, runtime, () => 100_000) };
    assert.equal(readiness.until, null, why);
    assert.equal(switchOffer({ sequence: PAUSED, owner: OWNER, session: p.getSnapshot(), readiness, now: NOW, liquid: true }), p.getSnapshot().kind === 'signed_out' ? 'sign-in' : null, why);
  }
  assert.equal(await automationAvailable(OWNER, VAULT, port(), reply(body), runtime, () => 100_000), true, 'the one ready answer');
  // It holds until the service's own expiry, as the page's clock reads it.
  assert.equal(await automationReadyUntil(OWNER, VAULT, port(), reply(body), runtime, () => 100_000), 110_000);
  assert.equal(await automationReadyUntil(OWNER, VAULT, port(), reply({ ...body, expiresAtEpoch: 101 }), runtime, () => 100_900), 101_000);
  assert.equal(await automationReadyUntil(OWNER, VAULT, port(), reply({ ...body, expiresAtEpoch: 100 }), runtime, () => 100_000), null, 'expired on arrival');
});

// The review of 2026-09-25: the execution contract lets a "ready" live at most 10 seconds after the service's check
// (api-contracts/execution-v1 README; runtime.mjs refuses expiresAtEpoch > checkedAtEpoch + 10). Turn on never stands on
// an answer past that: it is kept no longer than the service's own expiry, capped at the 9 seconds of the owner
// activation gate it replaces (#205), and asked again just before it lapses, so a ready service stays shown.
test('a ready answer is kept no longer than the service allows, and asked again just before it lapses', () => {
  assert.ok(READY_KEEP_MS <= 10_000, 'never longer than the contract’s 10 seconds');
  assert.equal(READY_KEEP_MS, 9_000);
  assert.ok(READY_RENEW_MS < READY_KEEP_MS, 'asked again before it lapses');
  assert.ok(READY_RENEW_MIN_MS >= 1_000 && READY_RENEW_LEAD_MS > 0);
  assert.ok(NOT_READY_RECHECK_MS >= 30_000, 'a service that is not ready is not asked more than twice a minute');
  const at = NOW;
  // The service's usual answer: 10 seconds. Kept 9, asked again at 8.
  const usual = { ...READY, at, until: at + 10_000 };
  assert.equal(readyUntil(usual), at + READY_KEEP_MS);
  assert.equal(renewIn(usual), READY_RENEW_MS);
  assert.equal(readyFor(usual, OWNER, VAULT, 7, at + READY_KEEP_MS - 1), true);
  assert.equal(readyFor(usual, OWNER, VAULT, 7, at + READY_KEEP_MS), false);
  // A shorter expiry, or a page clock behind the service's: kept only until the service's own, asked a second before.
  const short = { ...READY, at, until: at + 4_000 };
  assert.equal(readyUntil(short), at + 4_000);
  assert.equal(renewIn(short), 4_000 - READY_RENEW_LEAD_MS);
  assert.equal(readyFor(short, OWNER, VAULT, 7, at + 3_999), true);
  assert.equal(readyFor(short, OWNER, VAULT, 7, at + 4_000), false);
  // An expiry about to pass: never asked again sooner than the floor, and it lapses before then.
  const brief = { ...READY, at, until: at + 1_200 };
  assert.equal(renewIn(brief), READY_RENEW_MIN_MS);
  assert.equal(readyFor(brief, OWNER, VAULT, 7, at + 1_200), false);
  // A service's expiry past the contract's own limit still lapses at READY_KEEP_MS.
  assert.equal(readyUntil({ ...READY, at, until: at + 60_000 }), at + READY_KEEP_MS);
  // Not ready: nothing kept, asked again after NOT_READY_RECHECK_MS.
  const no = { ...READY, at, until: null };
  assert.equal(readyUntil(no), at);
  assert.equal(renewIn(no), NOT_READY_RECHECK_MS);
  // Over one renewal cycle Turn on never stands past what the service allowed: each renewal lands before the answer lapses.
  for (const until of [at + 10_000, at + 6_000, at + 3_000]) {
    const answer = { ...READY, at, until };
    assert.ok(at + renewIn(answer) < readyUntil(answer), `renewed before it lapses (${until - at} ms)`);
    assert.ok(readyUntil(answer) <= until && readyUntil(answer) - at <= 10_000);
  }
});
