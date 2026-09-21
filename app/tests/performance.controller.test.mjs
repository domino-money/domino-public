import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { concatHex, decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, parseAbiParameters, zeroAddress } from 'viem';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';
// The deployment pin is enforced by a build that says it is deployable, and
// the refusal below is what such a build does. `.test-build` is not one, so
// this file stands in for it — before the requires, because pin.ts reads the
// flag once when the module loads.
globalThis.__DOMINO_DEPLOYABLE__ = true;
const require = createRequire(import.meta.url);
const { createPerformanceController, formatMetricUsd, formatMetricPercent, exactDecimal, enrollmentFailureText, performanceReasonText,
  PERFORMANCE_STATUS_TEXT, ENROLLMENT_STATUS_TEXT, ENROLLMENT_REASON_TEXT, COLLECTION_TEXT, SEQUENCE_LIST_TRIES, PERFORMANCE_RETRY_MS, trackableSequence } = require('../.test-build/app/src/finance/performance.js');
// Compiled into the test build through performance.ts's import of its types.
const { createSequenceClient, sequenceAbi, sequenceIdentity, cloneRuntime, SEQUENCE_LIST_LIMIT, SEQUENCE_MEMBER_STEPS, sequenceIdParameters, poolKeyParameters } = require('../.test-build/app/src/finance/sequence.js');
const { setupAbi, tokenAbi, operationIdParameters } = require('../.test-build/app/src/finance/setup.js');
const { sequenceDeploymentFrom } = require('../.test-build/app/src/finance/sequence.js');
const { deploymentFrom } = require('../.test-build/app/src/finance/setup.js');
const { SEQUENCE_FACTORY, SETUP_CONTRACT, POSITION_MANAGER } = require('../.test-build/app/src/finance/pin.js');
const fixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/performance-v2/fixtures/${path}.json`, import.meta.url)));
const epochs = fixture('responses/epochs'), cards = fixture('responses/cards');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } });
function harness(handler, { sequences, visible: shown = true } = {}) {
  let now = 0, visible = shown, identity = { kind: 'signed_in', owner: epochs.owner, chainId: 4663, epoch: 1, connectorUid: 'one' };
  const timers = new Map(), listeners = new Set(), calls = []; let serial = 0;
  const clock = { monoMs: () => now, wallMs: () => now, setTimer(fn, ms) { const id = serial++; timers.set(id, { fn, at: now + ms }); return () => timers.delete(id); } };
  const session = { csrfAccess: true, getSnapshot: () => identity, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    withCsrf: async (_epoch, fn) => fn('never-persist-this'), reportDenial() {} };
  const controller = createPerformanceController({ session, runtime, clock, visible: () => visible, sequences,
    fetch: async (url, init) => { calls.push({ url, init }); if (handler) return handler(url, init);
      return new Response(JSON.stringify(url.endsWith('/epochs') ? epochs : cards), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } }); } });
  const stop = controller.start();
  return { controller, calls, stop, async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); },
    identity(value) { identity = value; for (const fn of listeners) fn(); },
    visibility(value) { visible = value; controller.visibilityChanged(); } };
}
test('private cards preserve decimal strings, bind epochs and refresh within 60s with no overlap', async () => {
  const h = harness(); await flush();
  assert.equal(h.controller.getSnapshot().state, 'ready');
  assert.equal(h.controller.getSnapshot().cards[0].metrics.netFeeIncomeUsd, cards.cards[0].metrics.netFeeIncomeUsd);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { epochIds: epochs.enrollments.map(e => e.epochId) });
  assert.equal(h.calls[0].init.headers['X-Domino-CSRF'], 'never-persist-this');
  assert.equal(h.calls[0].init.credentials, 'same-origin');
  await h.controller.refresh(); await h.advance(59999); assert.equal(h.calls.length, 2);
  await h.advance(1); assert.equal(h.calls.length, 4); h.stop();
});
test('switching accounts clears private state immediately and drops the late former-owner reply', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; })); await flush();
  h.identity({ kind: 'signed_out' });
  resolve(new Response(JSON.stringify(epochs), { headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } })); await flush();
  assert.equal(h.controller.getSnapshot().state, 'signed_out'); assert.deepEqual(h.controller.getSnapshot().cards, []); assert.equal(h.calls.length, 1); h.stop();
});
test('foreign owner response never triggers cards or appears in the UI', async () => {
  const h = harness(() => new Response(JSON.stringify({ ...epochs, owner: '0x' + 'aa'.repeat(20) }), { headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } }));
  await flush(); assert.equal(h.controller.getSnapshot().reason, 'owner_mismatch'); assert.equal(h.calls.length, 1); assert.deepEqual(h.controller.getSnapshot().cards, []); h.stop();
});
test('hidden tabs stop work, clear old numbers, and perform one bounded refresh on return', async () => {
  const h = harness(); await flush(); h.visibility(false); assert.deepEqual(h.controller.getSnapshot().cards, []);
  await h.advance(600000); assert.equal(h.calls.length, 2); h.visibility(true); await flush(); assert.equal(h.calls.length, 4); h.stop();
});
test('20s deadline aborts a stalled network and preserves a 60s retry budget', async () => {
  const h = harness((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  await h.advance(20000); assert.equal(h.controller.getSnapshot().state, 'unavailable'); assert.equal(h.calls.length, 1);
  await h.advance(59999); assert.equal(h.calls.length, 1); await h.advance(1); assert.equal(h.calls.length, 2); h.stop();
});
test('incomplete financial coverage keeps APR null in the producer fixture', () => {
  const value = fixture('variants/unqualified-prices');
  assert.ok(runtime.validateResponse('cards', value));
  assert.equal(value.cards[0].metrics.grossFeeAprPercent, null); assert.equal(value.cards[0].metrics.netFeeAprPercent, null);
});
// Changed on purpose (review:wallet, receipts polling, same bound for history): a switched-off route used to be asked again every 60 s for as
// long as the tab stayed visible. It cannot change without a deploy, so it is not asked again on a timer; coming back to the tab asks once more.
test('a switched-off service stays quiet: no cards, its code kept for the title, not asked again on a timer, and found when the tab is shown again', async () => {
  let off = true;
  const h = harness(url => off ? reply({ error: 'route_not_available' }, 404) : reply(url.endsWith('/epochs') ? epochs : cards));
  await flush();
  assert.deepEqual([h.controller.getSnapshot().state, h.controller.getSnapshot().reason, h.controller.getSnapshot().cards, h.calls.length], ['unavailable', 'route_not_available', [], 1]);
  off = false;
  for (let t = 0; t < 600_000; t += 1_000) await h.advance(1_000);
  assert.equal(h.calls.length, 1, 'nothing is asked again on its own');
  h.visibility(false); h.visibility(true); await flush();
  assert.deepEqual([h.controller.getSnapshot().state, h.controller.getSnapshot().reason, h.calls.length], ['ready', null, 3], 'switched on meanwhile: coming back to the tab finds it');
  h.stop();
});

test('over an hour, failed history is asked again at most three times, 60, 120 then 240 s later, and a failure asking again cannot fix only once; the tab shown again or a good answer starts over', async () => {
  const at = async (h, until) => { const times = []; for (let t = 0, seen = h.calls.length; t < until; t += 1_000) { await h.advance(1_000); if (h.calls.length > seen) { seen = h.calls.length; times.push(t + 1_000); } } return times; };
  assert.equal(PERFORMANCE_RETRY_MS, 60_000);
  for (const [label, handler, reason] of [
    ['switched off', () => reply({ error: 'route_not_available' }, 404), 'route_not_available'],
    ['no Worker route', () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'feature_unavailable'],
    ['another contract', () => new Response(JSON.stringify(epochs), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': '0.0.0-other' } }), 'contract_mismatch'],
    ['another owner', () => reply({ ...epochs, owner: '0x' + 'aa'.repeat(20) }), 'owner_mismatch'],
    ['not the contract', () => reply({ ...epochs, executionAvailable: true }), 'invalid_response'],
  ]) {
    const h = harness(handler); await flush();
    assert.equal(h.controller.getSnapshot().reason, reason, label);
    assert.deepEqual(await at(h, 3_600_000), [], `${label}: one POST in an hour of a visible tab`);
    h.visibility(false); h.visibility(true); await flush();
    assert.equal(h.calls.length, 2, `${label}: the owner came back, so it is asked once more`);
    assert.deepEqual(await at(h, 3_600_000), [], `${label}: and not again on its own`);
    h.stop();
  }
  assert.ok(runtime.validateError(503, { error: 'performance_store_unavailable' }));
  let failing = true;
  const h = harness(url => failing ? reply({ error: 'performance_store_unavailable' }, 503) : reply(url.endsWith('/epochs') ? epochs : cards)); await flush();
  assert.deepEqual(await at(h, 3_600_000), [60_000, 180_000, 420_000], 'three asks, further apart each time, then none');
  assert.deepEqual([h.calls.length, h.controller.getSnapshot().state, h.controller.getSnapshot().reason], [4, 'unavailable', 'performance_store_unavailable']);
  h.visibility(false); h.visibility(true); await flush();
  assert.equal(h.calls.length, 5, 'shown again: asked at once');
  assert.deepEqual(await at(h, 300_000), [60_000, 180_000], 'and counted afresh');
  failing = false;
  assert.deepEqual(await at(h, 120_000), [120_000], 'switched on meanwhile: the next ask finds it');
  assert.equal(h.controller.getSnapshot().state, 'ready');
  failing = true;
  assert.deepEqual(await at(h, 3_600_000), [60_000, 120_000, 240_000, 480_000], 'the good answer started the count over: its next refresh fails, then three asks, then none');
  h.stop();
});
test('a refused enrollment keeps the cards shown and gives its reason; a sent one is read back 30 s later', async () => {
  let refuse = true;
  const h = harness(url => url.endsWith('/enroll') ? (refuse ? reply({ error: 'performance_subject_not_admitted' }, 403) : reply(fixture('responses/enroll'))) : reply(url.endsWith('/epochs') ? epochs : cards));
  await flush();
  const body = fixture('requests/enroll');
  await h.controller.enroll(body);
  const refused = h.controller.getSnapshot();
  // The outcome names the vault it belongs to, so the screen says it beside that sequence (G16).
  assert.deepEqual([refused.state, refused.cards.length, refused.enrollment], ['ready', 1, { vault: body.vault, ok: false, reason: 'performance_subject_not_admitted' }]);
  refuse = false;
  await h.controller.enroll(body);
  assert.deepEqual(h.controller.getSnapshot().enrollment, { vault: body.vault, ok: true });
  const sent = h.calls.length;
  await h.advance(29_999); assert.equal(h.calls.length, sent);
  await h.advance(1); assert.equal(h.calls.length, sent + 2, 'epochs and cards, 30 s after the enrollment');
  h.stop();
});
test('Next positions waits for the refresh floor, pages forward, and after the last page comes back to the first', async () => {
  const afterId = '0x' + '56'.repeat(32);
  const first = { ...epochs, nextAfter: afterId };
  const second = { ...epochs, nextAfter: null, enrollments: [{ ...epochs.enrollments[0], enrollmentId: '0x' + '78'.repeat(32), epochId: null, status: 'queued', reason: 'awaiting_baseline' }] };
  assert.ok(runtime.validateResponse('epochs', first)); assert.ok(runtime.validateResponse('epochs', second));
  const h = harness((url, init) => url.endsWith('/cards') ? reply(cards) : reply(JSON.parse(init.body).after === afterId ? second : first));
  await flush();
  assert.equal(h.controller.getSnapshot().more, true);
  h.controller.nextPage();
  assert.deepEqual([h.controller.getSnapshot().paging, h.calls.length], [true, 2], 'inside the floor the page waits for the scheduled read');
  await h.advance(60_000);
  assert.deepEqual(JSON.parse(h.calls[2].init.body), { after: afterId });
  assert.deepEqual([h.controller.getSnapshot().paging, h.controller.getSnapshot().more, h.controller.getSnapshot().enrollments[0].status, h.calls.length], [false, true, 'queued', 3]);
  h.controller.nextPage();
  await h.advance(60_000);
  assert.deepEqual(JSON.parse(h.calls[3].init.body), {}, 'after the last page, the first again');
  assert.deepEqual([h.controller.getSnapshot().cards.length, h.controller.getSnapshot().more], [1, true]);
  h.stop();
});
test('started again after a stop, the controller reads again and is never left busy (development double mount)', async () => {
  let stall = true;
  const h = harness((url, init) => {
    if (stall) { stall = false; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))); }
    return reply(url.endsWith('/epochs') ? epochs : cards);
  });
  await flush();
  h.stop(); assert.equal(h.controller.getSnapshot().busy, false);
  const again = h.controller.start(); await flush();
  assert.deepEqual([h.controller.getSnapshot().state, h.controller.getSnapshot().cards.length], ['ready', 1]); again();
});
test('money and rates come from the decimal strings: grouped, two places, a leading minus, a tiny amount never shown as zero', () => {
  assert.equal(formatMetricUsd('9.000000000000000000'), '$9.00');
  assert.equal(formatMetricUsd('50'), '$50.00');
  assert.equal(formatMetricUsd('1234.567890123456789012'), '$1,234.57');
  assert.equal(formatMetricUsd('-1.5'), '-$1.50');
  assert.equal(formatMetricUsd('-1234567.005'), '-$1,234,567.00', 'half to even');
  assert.equal(formatMetricUsd('0.000400000000000000'), '$0.000400');
  assert.equal(formatMetricUsd('0.000000000000000001'), '<$0.000001');
  assert.equal(formatMetricUsd('-0.000000000000000001'), '>-$0.000001');
  assert.equal(formatMetricUsd('-0.000'), '$0.00');
  for (const bad of ['1e3', '', '$1', '1,000', ' 1', '.5']) assert.equal(formatMetricUsd(bad), null, bad);
  assert.equal(formatMetricPercent('328.500000000000000000'), '328.50%');
  assert.equal(formatMetricPercent('-12.345'), '-12.34%');
  assert.equal(formatMetricPercent('12345.678'), '12,345.68%');
  assert.equal(formatMetricPercent('0.001'), '<0.01%');
  assert.equal(formatMetricPercent('-0.001'), '>-0.01%');
  assert.equal(formatMetricPercent('0'), '0.00%');
  assert.equal(formatMetricPercent('abc'), null);
  assert.deepEqual(['9.000000000000000000', '-1.50', '50'].map(exactDecimal), ['9', '-1.5', '50']);
});
test('statuses, reasons and refusals read as words; none is a code or a not-yet', () => {
  assert.deepEqual(Object.keys(PERFORMANCE_STATUS_TEXT).sort(), ['available', 'measuring', 'partial', 'stale', 'unavailable']);
  assert.deepEqual(Object.keys(ENROLLMENT_STATUS_TEXT).sort(), ['blocked', 'queued', 'stale', 'tracking']);
  assert.deepEqual(Object.keys(ENROLLMENT_REASON_TEXT).sort(), ['awaiting_baseline', 'baseline_reorged', 'collection_failed', 'forward_collection']);
  assert.deepEqual(Object.keys(COLLECTION_TEXT).sort(), ['baseline_reorged', 'canonical_replay_required', 'forward_observations_only', 'latest_read_failed', 'snapshot_stale']);
  const words = [...Object.values(PERFORMANCE_STATUS_TEXT), ...Object.values(ENROLLMENT_STATUS_TEXT), ...Object.values(ENROLLMENT_REASON_TEXT), ...Object.values(COLLECTION_TEXT),
    ...['performance_subject_not_admitted', 'performance_enrollment_limit', 'invalid_request', 'csrf_invalid', 'route_not_available',
      'unqualified_sequence', 'sequence_members_incomplete', 'sequence_members_unbounded', 'wallet_timeout', 'wallet_read_failed', 'connect_robinhood_wallet', 'no_deployment'].map(enrollmentFailureText),
    ...['snapshot_stale', 'capital_coverage_incomplete', 'full_l2_cost_unqualified'].map(performanceReasonText)];
  for (const text of words) assert.doesNotMatch(text, /_|not connected|not enabled|in this release|coming soon|yet\b/i, text);
  assert.equal(performanceReasonText('some_new_reason'), 'some new reason.', 'an unknown code is spelled out, never dropped');
});

test('the owner screens say which of their own buttons reads again: never a bare "Read again", and each named button is on its screen', () => {
  const ts = require('typescript');
  const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  // finance/words.ts has no imports and is not part of the node test build: transpiled here, as the screens bundle it.
  const words = { exports: {} };
  new Function('exports', 'module', ts.transpileModule(source('finance/words.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(words.exports, words);
  const { financeErrorText } = words.exports;
  for (const [again, screen] of [['Read my operations', 'screens/AdvancedSetup.tsx'], ['Read my sequences', 'screens/Sequence.tsx']]) {
    assert.match(source(screen), new RegExp(`>${again}</Button>`), `${screen} has a ${again} button`);
    assert.match(source(screen), new RegExp(`financeErrorText\\(errorCode\\(error\\), *'[^']*', *'${again}'\\)`), `${screen} names ${again} for its sentences`);
    assert.equal(financeErrorText('wallet_identity_changed', 'fallback', again), `Your wallet account or network changed. Press ${again} again.`);
    assert.equal(financeErrorText('chain_changed', 'fallback', again), `The chain moved on while reading. Press ${again} again.`);
    assert.equal(financeErrorText('some_unknown_code', 'fallback', again), 'fallback');
  }
  assert.equal(financeErrorText('setup_release_expired', 'fallback', 'Read my operations'), 'The deployment profile expired. Press Read my operations again.');
  assert.equal(financeErrorText('sequence_release_expired', 'fallback', 'Read my sequences'), 'The deployment profile expired. Press Read my sequences again.');
  const every = [...source('finance/words.ts').matchAll(/^\s+[a-z0-9_]+: (?:'([^']*)'|\(again\) => `([^`]*)`),$/gm)].map((match) => match[1] ?? match[2]);
  assert.ok(every.length > 60, `${every.length} sentences`);
  for (const text of every) assert.doesNotMatch(text, /Read again|read again\./i, text);
});

// ---- G16: Start tracking from the sequences the owner's wallet lists ------------------------------------------

const enrollRequest = fixture('requests/enroll');
/** A fake of the screen's sequence reads: what the wallet lists and each vault's positions, with every call recorded. */
function fakeReads({ rows = [{ vault: enrollRequest.vault, rootTokenId: enrollRequest.tokenIds[0] }], older = false, members = () => enrollRequest.tokenIds, list } = {}) {
  const calls = [];
  return { calls, list: async owner => { calls.push(['list', owner]); return list ? list(calls.length) : { rows, older }; },
    members: async (owner, vault) => { calls.push(['members', owner, vault]); return members(vault); } };
}
const enrollAnswer = () => reply({ ...fixture('responses/enroll'), owner: epochs.owner });
const performanceRoute = (url) => url.endsWith('/enroll') ? enrollAnswer() : reply(url.endsWith('/epochs') ? epochs : cards);

test('signed in, the listed sequences come from the wallet reads once, and Start tracking sends enroll with the session and the positions read from the vault', async () => {
  const reads = fakeReads();
  const h = harness(performanceRoute, { sequences: reads });
  await flush();
  assert.deepEqual(h.controller.getSnapshot().sequences, { state: 'ready', rows: [{ vault: enrollRequest.vault, rootTokenId: '1' }], older: false, reason: null });
  assert.deepEqual(reads.calls, [['list', epochs.owner]], 'listed once, for the signed-in owner');
  await h.advance(600_000);
  assert.equal(reads.calls.length, 1, 'a listing is not read again on a timer');
  const before = h.calls.length;
  const pressed = h.controller.track(enrollRequest.vault);
  assert.equal(h.controller.getSnapshot().starting, enrollRequest.vault);
  await pressed;
  assert.deepEqual(reads.calls.at(-1), ['members', epochs.owner, enrollRequest.vault]);
  const sent = h.calls.slice(before).filter(call => call.url.endsWith('/enroll'));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].init.body), enrollRequest, 'the fixture request: the vault and its complete active set, nothing typed');
  assert.deepEqual([sent[0].url, sent[0].init.method, sent[0].init.credentials, sent[0].init.headers['X-Domino-CSRF']], ['/api/performance/v2/enroll', 'POST', 'same-origin', 'never-persist-this']);
  assert.deepEqual([h.controller.getSnapshot().starting, h.controller.getSnapshot().enrollment], [null, { vault: enrollRequest.vault, ok: true }]);
  assert.deepEqual(Object.keys(reads).sort(), ['calls', 'list', 'members'], 'the reads offer nothing that could sign or send');
  h.stop();
});

test('the listing waits while hidden, is asked again at most three times after a wallet failure, and never after a final one or without a deployment', async () => {
  let off = true;
  const quiet = fakeReads();
  const q = harness(url => off ? reply({ error: 'route_not_available' }, 404) : performanceRoute(url), { sequences: quiet });
  await flush(); await q.advance(30_000);
  assert.deepEqual([quiet.calls.length, q.controller.getSnapshot().sequences.state], [0, 'idle'], 'history off: Start tracking has nowhere to send, so the chain is not read');
  // A switched-off history route is not asked again on a timer (changed on purpose with the receipts polling bound): coming back to the tab asks.
  off = false; await q.advance(30_000); q.visibility(false); q.visibility(true); await flush();
  assert.deepEqual([quiet.calls.length, q.controller.getSnapshot().sequences.state], [1, 'ready'], 'history on: the listing follows its first answer'); q.stop();

  const hidden = fakeReads();
  const later = harness(performanceRoute, { sequences: hidden, visible: false });
  await later.advance(120_000); assert.deepEqual([hidden.calls.length, later.controller.getSnapshot().sequences.state], [0, 'idle']);
  later.visibility(true); await flush();
  assert.deepEqual([hidden.calls.length, later.controller.getSnapshot().sequences.state], [1, 'ready']); later.stop();

  const flaky = fakeReads({ list: () => { throw new Error('wallet_timeout'); } });
  const h = harness(performanceRoute, { sequences: flaky });
  await flush();
  const at = [0];
  for (let t = 0; t < 400_000; t += 1_000) { const seen = flaky.calls.length; await h.advance(1_000); if (flaky.calls.length > seen) at.push(t + 1_000); }
  assert.deepEqual(at, [0, 15_000, 45_000, 105_000], 'once, then 15 s, 30 s and 60 s later, then no more');
  assert.equal(SEQUENCE_LIST_TRIES, 3);
  assert.deepEqual(h.controller.getSnapshot().sequences, { state: 'unavailable', rows: [], older: false, reason: 'wallet_timeout' });
  h.stop();

  const retryHidden = fakeReads({ list: n => { if (n === 1) throw new Error('wallet_action_busy'); return { rows: [], older: false }; } });
  const r = harness(performanceRoute, { sequences: retryHidden });
  await flush(); r.visibility(false); await r.advance(60_000);
  assert.equal(retryHidden.calls.length, 1, 'a retry that comes due while hidden waits');
  r.visibility(true); await flush();
  assert.deepEqual([retryHidden.calls.length, r.controller.getSnapshot().sequences.state], [2, 'ready']); r.stop();

  for (const [list, reason] of [[() => { throw new Error('deployment_code_changed'); }, 'deployment_code_changed'], [() => null, 'no_deployment'], [() => { throw 'not an error'; }, 'wallet_read_failed']]) {
    const reads = fakeReads({ list });
    const x = harness(performanceRoute, { sequences: reads });
    await flush(); for (let t = 0; t < 400_000; t += 5_000) await x.advance(5_000);
    assert.equal(reads.calls.length, reason === 'wallet_read_failed' ? 4 : 1, reason);
    assert.equal(x.controller.getSnapshot().sequences.reason, reason); x.stop();
  }
});

test('a failed positions read sends nothing and says why for that vault; an account change drops a Start tracking still on its way', async () => {
  const refused = fakeReads({ members: () => { throw new Error('sequence_members_incomplete'); } });
  const h = harness(performanceRoute, { sequences: refused });
  await flush();
  await h.controller.track(enrollRequest.vault);
  assert.equal(h.calls.filter(call => call.url.endsWith('/enroll')).length, 0);
  assert.deepEqual([h.controller.getSnapshot().starting, h.controller.getSnapshot().enrollment], [null, { vault: enrollRequest.vault, ok: false, reason: 'sequence_members_incomplete' }]);
  h.stop();

  let release;
  const slow = fakeReads({ members: () => new Promise(resolve => { release = resolve; }) });
  const s = harness(performanceRoute, { sequences: slow });
  await flush();
  const pressed = s.controller.track(enrollRequest.vault);
  await flush();
  s.controller.track(enrollRequest.vault); await flush();
  assert.equal(slow.calls.filter(call => call[0] === 'members').length, 1, 'a second press while one is on its way adds nothing');
  s.identity({ kind: 'signed_in', owner: '0x' + '33'.repeat(20), chainId: 4663, epoch: 2, connectorUid: 'two' });
  release(enrollRequest.tokenIds); await pressed; await flush();
  assert.equal(s.calls.filter(call => call.url.endsWith('/enroll')).length, 0, 'nothing is sent for the owner that left');
  assert.deepEqual([s.controller.getSnapshot().starting, s.controller.getSnapshot().enrollment], [null, null]);
  s.stop();
});

test('Start tracking pressed while history is on the wire is sent right after it, and read back 30 s later', async () => {
  let hold = true, releaseEpochs;
  const reads = fakeReads();
  const h = harness((url) => {
    if (url.endsWith('/epochs') && hold) { hold = false; return new Promise(resolve => { releaseEpochs = () => resolve(reply(epochs)); }); }
    return performanceRoute(url);
  }, { sequences: reads });
  await flush();
  assert.equal(h.controller.getSnapshot().busy, true);
  const pressed = h.controller.track(enrollRequest.vault); await flush();
  assert.equal(h.calls.filter(call => call.url.endsWith('/enroll')).length, 0, 'it waits for the cycle on the wire');
  releaseEpochs(); await pressed; await flush();
  assert.deepEqual(h.calls.map(call => call.url.split('/').at(-1)), ['epochs', 'cards', 'enroll']);
  assert.deepEqual(h.controller.getSnapshot().enrollment, { vault: enrollRequest.vault, ok: true });
  await h.advance(29_999); assert.equal(h.calls.length, 3);
  await h.advance(1); assert.deepEqual(h.calls.slice(3).map(call => call.url.split('/').at(-1)), ['epochs', 'cards']);
  h.stop();
});

test('a listed row carries the vault and root NFT as text, whatever the client returned them as', () => {
  assert.deepEqual(trackableSequence({ vault: '0x' + 'ab'.repeat(20), rootTokenId: 42n, ownerNonce: 0n }), { vault: '0x' + 'ab'.repeat(20), rootTokenId: '42' });
});

// The sequence client's own reads for tracking, over a fake chain answered through a fake wallet: only reads, never a signature.
const hexOf = (byte, bytes) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`;
const ZERO32 = hexOf(0, 32);
const CHAIN_OWNER = hexOf(0x2a, 20);
const READ_METHODS = ['eth_accounts', 'eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode'];
function fakeChain({ sequences = 1, owner = CHAIN_OWNER, chains = {}, active = {} } = {}) {
  const implementation = hexOf(0x12, 20), factoryCode = '0x6001', implementationCode = '0x6002';
  const d = { factory: hexOf(0x11, 20), implementation, poolManager: hexOf(0x13, 20), positionManager: hexOf(0x14, 20), stateView: hexOf(0x15, 20), readHelper: hexOf(0x16, 20),
    engine: hexOf(0x17, 20), routing: hexOf(0x18, 20), priceGuard: hexOf(0x19, 20), serviceFeeRecipient: hexOf(0x1a, 20), operator: hexOf(0x1b, 20), pricePublisher: hexOf(0x1c, 20),
    serviceFeeBps: 200, expiresAt: 4_000_000_000,
    codeHashes: { factory: keccak256(factoryCode), implementation: keccak256(implementationCode), poolManager: hexOf(0x23, 32), positionManager: hexOf(0x24, 32), stateView: hexOf(0x25, 32),
      readHelper: hexOf(0x26, 32), engine: hexOf(0x27, 32), routing: hexOf(0x28, 32), priceGuard: hexOf(0x29, 32), vault: keccak256(cloneRuntime(implementation)) } };
  const vaults = new Map();
  for (let n = 0; n < sequences; n++) {
    const { id, vault } = sequenceIdentity(d, CHAIN_OWNER, BigInt(n));
    vaults.set(vault, { id, owner, root: BigInt(100 + n), chain: chains[n] ?? [], active: active[n] });
  }
  const position = (known, isActive, isRoot, parentTokenId) => ({ known, active: isActive, isRoot, parentTokenId, generation: 0n, tickLower: -60, tickUpper: 60, registrationBaselineId: ZERO32, identity: ZERO32, source0: ZERO32, source1: ZERO32 });
  function answer(to, name, args) {
    const same = { poolManager: d.poolManager, positionManager: d.positionManager, stateView: d.stateView, serviceFeeRecipient: d.serviceFeeRecipient };
    if (to === d.factory) {
      if (name in same) return same[name];
      if (name === 'implementation') return implementation;
      if (name === 'implementationCodeHash') return d.codeHashes.implementation;
      if (name === 'nextOwnerNonce') return BigInt(sequences);
      if (name === 'vaultForSequence') return [...vaults].find(([, v]) => v.id === args[0])?.[0] ?? zeroAddress;
      if (name === 'isVault') return vaults.has(args[0].toLowerCase());
    }
    if (to === implementation) {
      if (name in same) return same[name];
      const links = { factory: d.factory, implementation, implementationVersion: 4n, readHelper: d.readHelper, executionEngine: d.engine };
      if (name in links) return links[name];
    }
    const v = vaults.get(to);
    if (v) {
      const at = (id) => v.chain.findIndex(member => member.id === id);
      switch (name) {
        case 'owner': return v.owner;
        case 'sequenceId': return v.id;
        case 'policy': return { serviceFeeBps: 200, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 60, maxPositions: 3, version: 1n, paused: true };
        case 'rootTokenId': return v.root;
        case 'operator': return d.operator;
        case 'rootPermissionValid': return true;
        case 'baseCurrency': return hexOf(0x31, 20);
        case 'quoteCurrency': return hexOf(0x32, 20);
        case 'stateNonce': return 1n;
        case 'position': return args[0] === v.root ? position(true, true, true, 0n) : at(args[0]) === -1 ? position(false, false, false, 0n)
          : position(true, v.chain[at(args[0])].active, false, at(args[0]) === 0 ? v.root : v.chain[at(args[0]) - 1].id);
        case 'successorOf': return args[0] === v.root ? v.chain[0]?.id ?? 0n : at(args[0]) === -1 ? 0n : v.chain[at(args[0]) + 1]?.id ?? 0n;
        case 'activePositions': return v.active ?? BigInt(1 + v.chain.filter(member => member.active).length);
      }
    }
    throw new Error(`unexpected ${name} on ${to}`);
  }
  const log = [];
  const wallet = { owner: CHAIN_OWNER, current: () => true, nonceOffered: () => false, releaseRejectedNonce: async () => undefined,
    claimNonce: async () => { log.push('claimNonce'); throw new Error('a read never claims a nonce'); },
    request: async (method, params) => {
      log.push(method);
      if (method === 'eth_accounts') return [CHAIN_OWNER];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: hexOf(0xbb, 32) };
      if (method === 'eth_getCode') return params[0] === d.factory ? factoryCode : params[0] === implementation ? implementationCode : vaults.has(params[0]) ? cloneRuntime(implementation) : '0x';
      if (method === 'eth_call') {
        const { to, data } = params[0];
        const { functionName, args } = decodeFunctionData({ abi: sequenceAbi, data });
        return encodeFunctionResult({ abi: sequenceAbi, functionName, result: answer(to, functionName, args ?? []) });
      }
      throw new Error(`the wallet was asked for ${method}`);
    } };
  return { d, wallet, log, vaults: [...vaults.keys()], client: createSequenceClient(wallet, d) };
}

test('the closed owner ABIs ship as JSON, and each equals what viem parses from the reviewed signatures written beside it', () => {
  const source = (path) => readFileSync(new URL(`../src/finance/${path}`, import.meta.url), 'utf8');
  const signatures = (text, name) => {
    const lines = text.split('\n'), at = lines.indexOf(` * ${name} signatures:`), listed = [];
    assert.ok(at >= 0, `${name} lists its signatures`);
    for (const line of lines.slice(at + 1)) { const match = /^ \* {3}(.+)$/.exec(line); if (!match) break; listed.push(match[1]); }
    return listed;
  };
  const parameters = (text, name) => { const match = new RegExp(`^/\\*\\* ${name} signature: (.+) \\*/$`, 'm').exec(text); assert.ok(match, `${name} names its signature`); return match[1]; };
  const setupText = source('setup.ts'), sequenceText = source('sequence.ts');
  assert.deepEqual(setupAbi, parseAbi(signatures(setupText, 'setupAbi')));
  assert.deepEqual(tokenAbi, parseAbi(signatures(setupText, 'tokenAbi')));
  assert.deepEqual(operationIdParameters, parseAbiParameters(parameters(setupText, 'operationIdParameters')));
  assert.deepEqual(sequenceAbi, parseAbi(signatures(sequenceText, 'sequenceAbi')));
  assert.deepEqual(sequenceIdParameters, parseAbiParameters(parameters(sequenceText, 'sequenceIdParameters')));
  assert.deepEqual(poolKeyParameters, parseAbiParameters(parameters(sequenceText, 'poolKeyParameters')));
  assert.deepEqual([setupAbi.length, tokenAbi.length, sequenceAbi.length], [13, 2, 58], 'every signature, and nothing else');
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const text of [setupText, sequenceText]) assert.doesNotMatch(code(text), /\bparseAbi(Parameters)?\b/, 'no ABI parser runs in the page');
});

test('the sequence client lists this wallet\'s newest sequences with their root NFTs, and says when it created more than the listing holds', async () => {
  const two = fakeChain({ sequences: 2 });
  const listed = await two.client.sequences();
  assert.deepEqual(listed.rows.map(row => [row.vault, row.ownerNonce, row.rootTokenId]), [[two.vaults[1], 1n, 101n], [two.vaults[0], 0n, 100n]], 'newest first');
  assert.equal(listed.older, false);
  const many = fakeChain({ sequences: SEQUENCE_LIST_LIMIT + 1 });
  const full = await many.client.sequences();
  assert.deepEqual([full.rows.length, full.rows.at(-1).ownerNonce, full.older], [8, 1n, true]);
  assert.deepEqual([...new Set([...two.log, ...many.log])].sort(), READ_METHODS, 'only reads reach the wallet');
});

test('members walks the successors from the root, keeps only the positions the vault still holds, and must match activePositions', async () => {
  const chain = fakeChain({ sequences: 1, chains: { 0: [{ id: 11n, active: true }, { id: 12n, active: false }, { id: 13n, active: true }] } });
  const read = await chain.client.members(chain.vaults[0]);
  assert.deepEqual([read.vault, read.rootTokenId, read.tokenIds], [chain.vaults[0], 100n, [100n, 11n, 13n]]);
  assert.ok(runtime.validateRequest('enroll', { vault: read.vault, tokenIds: read.tokenIds.map(String) }), 'what it reads is a valid enroll request');
  assert.deepEqual([...new Set(chain.log)].sort(), READ_METHODS);
  assert.equal(chain.log.includes('claimNonce'), false);

  const short = fakeChain({ chains: { 0: [{ id: 11n, active: true }] }, active: { 0: 3n } });
  await assert.rejects(short.client.members(short.vaults[0]), /sequence_members_incomplete/);
  const long = fakeChain({ chains: { 0: Array.from({ length: SEQUENCE_MEMBER_STEPS + 1 }, (_, i) => ({ id: BigInt(1000 + i), active: false })) } });
  await assert.rejects(long.client.members(long.vaults[0]), /sequence_members_unbounded/);
  const foreign = fakeChain({ owner: hexOf(0x5e, 20) });
  await assert.rejects(foreign.client.members(foreign.vaults[0]), /deployment_identity_changed/, 'a sequence another wallet owns is refused');
  await assert.rejects(chain.client.members(hexOf(0x77, 20)), /unqualified_sequence/, 'an address that is not a sequence is refused');
});

test('members at exactly the most successors it follows is read whole within the sequence client\'s ceiling of 100 wallet calls', async (t) => {
  assert.equal(SEQUENCE_MEMBER_STEPS, 30);
  const successors = Array.from({ length: SEQUENCE_MEMBER_STEPS }, (_, i) => ({ id: BigInt(2000 + i), active: i % 2 === 0 }));
  const longest = fakeChain({ chains: { 0: successors } });
  const read = await longest.client.members(longest.vaults[0]);
  assert.deepEqual(read.tokenIds, [100n, ...successors.filter(member => member.active).map(member => member.id)], 'the root, then every successor it still holds');
  assert.ok(longest.log.length <= 100, `${longest.log.length} wallet calls, over the ceiling`);
  assert.deepEqual([...new Set(longest.log)].sort(), READ_METHODS, 'only reads');
  t.diagnostic(`members() over ${SEQUENCE_MEMBER_STEPS} successors: ${longest.log.length} of 100 wallet calls`);
});

/**
 * The anchor the deployment records never had.
 *
 * Everything sequenceDeploymentFrom and deploymentFrom check proves the record
 * is SELF-CONSISTENT; nothing proved it was ours, because every address they
 * compare comes from the record. A record-controlling attacker — an extension
 * rewriting the release reply, or a planted localStorage recovery profile —
 * could name their own factory, satisfy the whole on-chain verification against
 * it, and become the spender of a real ERC-721 approval over a real position.
 *
 * `src/finance/pin.ts` anchors one identity per lane outside the record. The
 * contracts are not published yet, so both pins are null, and a null pin
 * REFUSES rather than passes: the wallet paths fail closed until the real
 * addresses are committed. These compile outside Vite, where the deployable
 * flag is absent and the pin defaults to required — the same state a deployable
 * build is in.
 */
test('a deployment record with no pinned identity is refused, on both lanes', () => {
  assert.equal(SEQUENCE_FACTORY, null, 'unpublished: nothing to pin yet');
  assert.equal(SETUP_CONTRACT, null, 'unpublished: nothing to pin yet');
  assert.equal(POSITION_MANAGER, '0x58daec3116aae6d93017baaea7749052e8a04fa7', 'the deposit lane already pins this one');

  const at = (byte) => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
  const hash32 = (byte) => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
  const implementation = at(0x42);
  const clone = concatHex(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']);
  const sequence = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: {
    factory: at(0x41), implementation, poolManager: at(0x43), positionManager: at(0x44), stateView: at(0x45),
    readHelper: at(0x46), engine: at(0x47), routing: at(0x48), priceGuard: at(0x49), serviceFeeRecipient: at(0x4a),
    operator: at(0x4b), pricePublisher: at(0x4c), serviceFeeBps: 200, expiresAt: 4_000_000_000,
    codeHashes: { factory: hash32(0x51), implementation: hash32(0x52), poolManager: hash32(0x53), positionManager: hash32(0x54),
      stateView: hash32(0x55), readHelper: hash32(0x56), engine: hash32(0x57), routing: hash32(0x58), priceGuard: hash32(0x59),
      vault: keccak256(clone) } } };
  // Structurally perfect, and still refused: it names a factory this build does not know.
  assert.throws(() => sequenceDeploymentFrom(sequence, 1000), (error) => /deployment_not_pinned/.test(String(error.message ?? error)));
  // available:false is not a record and stays parseable, so a switched-off lane still reads as switched off.
  assert.equal(sequenceDeploymentFrom({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null }, 1000), null);

  const setup = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: {
    setup: at(0x61), poolManager: at(0x43), positionManager: POSITION_MANAGER, stateView: at(0x45), feeRecipient: at(0x62),
    setupCodeHash: hash32(0x71), poolManagerCodeHash: hash32(0x72), positionManagerCodeHash: hash32(0x73), stateViewCodeHash: hash32(0x74),
    feeBps: 20, tariffVersion: '1', expiresAt: 4_000_000_000 } };
  assert.throws(() => deploymentFrom(setup, 1000), (error) => /deployment_not_pinned/.test(String(error.message ?? error)));
  assert.equal(deploymentFrom({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null }, 1000), null);
});

/**
 * The owner's whole surface, checked against the contract rather than against
 * a list someone kept up to date.
 *
 * On 2026-09-20 five of the nine onlyOwner functions had no way in from this
 * product: setPolicy and setExecutionLimits (so a sequence's rules and safety
 * limits were write-once, and one that met its own maxPositions had no way
 * forward), rearmRoot (the repair for a lapsed root permission), and the two
 * recoveries for an NFT or a balance that ended up in the vault by accident.
 * Nothing failed while they were missing, because nothing was looking.
 *
 * This reads DominoVaultV4.sol and fails by name the day another appears.
 */
test('every onlyOwner function of the vault has an ABI entry the app can encode', () => {
  const vault = readFileSync(new URL('../../contracts/src/DominoVaultV4.sol', import.meta.url), 'utf8');
  const owner = [...vault.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*external\s+onlyOwner/g)].map((match) => match[1]);
  assert.ok(owner.length >= 9, `expected the owner surface, found ${owner.length}`);
  const encodable = new Set(sequenceAbi.filter((entry) => entry.type === 'function' && entry.stateMutability !== 'view').map((entry) => entry.name));
  const absent = owner.filter((name) => !encodable.has(name));
  assert.deepEqual(absent, [], `owner functions with no way in from the app: ${absent.join(', ')}`);
  // And the reverse: nothing writable in our ABI that the vault does not have.
  // approve is the position manager's, not the vault's, so it is named here.
  const vaultWrites = [...encodable].filter((name) => name !== 'approve' && name !== 'createVault');
  const known = new Set([...vault.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]));
  assert.deepEqual(vaultWrites.filter((name) => !known.has(name)), [], 'the app can encode nothing the vault does not declare');
});
