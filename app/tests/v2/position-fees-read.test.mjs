/**
 * read-v6 1.2.0-rc.1's `position-fees`, the app's side (src/v2/read/v6.ts readPositionFees, docs/v2/V2_FEES.md): it alone is
 * asked in that version, every other read stays 1.1.0-rc.1 and may be answered in either, and until the Worker's
 * capabilities name the route nothing changes for any other read.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const { READ_V6_ANSWER_VERSIONS, READ_V6_CONTRACT_VERSION, READ_V6_NEXT_CONTRACT_VERSION, readPortfolio, readPositionFees } = require('../../.test-build/app/src/v2/read/v6.js');
const { READ_V6_PATHS, createHttpReadV6Transport } = require('../../.test-build/app/src/v2/read/v6HttpTransport.js');
const { V2_ROUTE_SPECS, askV2Route, createV2RouteProbe, routeServes, routeStateOf } = require('../../.test-build/app/src/v2/routes.js');

/**
 * Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): the package's own two versions (its CONTRACT_VERSION, 1.1.0-rc.1
 * on 7 Nov, and its NEXT_VERSION, 1.2.0-rc.1, whose fixtures sit in a folder of that name), never literals, so a day-9
 * version move needs only docs/ELYSIUM_DAY9.md step 3. WINDOW: the package still has two (a probe that asks the next
 * version first, then its own); a package of one version has no window, and the tests of the two-step probe say so.
 */
const V11 = runtime.CONTRACT_VERSION;
const V12 = runtime.NEXT_VERSION;
const WINDOW = V11 !== V12;
const NO_WINDOW = 'the package has one version (CONTRACT_VERSION is its NEXT_VERSION): no window to probe';
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${path}`, import.meta.url), 'utf8'));
const ANSWER = fixture(`${V12}/valid/position-fees.json`);
const ASKED = ANSWER.positions.map(({ dex, tokenId }) => ({ dex, tokenId }));

const reply = (status, body, header) => ({ kind: 'reply', reply: { status, opaqueRedirect: false, contentType: 'application/json', contractHeader: header, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: JSON.stringify(body) } } });

test('the two versions are the package\'s, and this route is its next version\'s alone', () => {
  assert.equal(READ_V6_CONTRACT_VERSION, runtime.CONTRACT_VERSION);
  assert.equal(READ_V6_NEXT_CONTRACT_VERSION, runtime.NEXT_VERSION);
  assert.deepEqual([...new Set(READ_V6_ANSWER_VERSIONS)], [...runtime.CONTRACT_VERSIONS]);
  assert.deepEqual([...runtime.NEXT_ROUTES], ['position-fees']);
  assert.equal(READ_V6_PATHS['position-fees'], '/api/read/v6/position-fees');
});

test('position-fees is asked in 1.2.0-rc.1 over HTTP, and its answer passes the package\'s validators', async () => {
  const sent = [];
  const transport = createHttpReadV6Transport({ post: async (url, init) => { sent.push({ url, init }); return reply(200, ANSWER, V12); } });
  const result = await readPositionFees(transport, runtime, 8453, ASKED);
  assert.equal(result.kind, 'ok');
  assert.equal(sent[0].url, '/api/read/v6/position-fees');
  assert.equal(sent[0].init.headers['X-Domino-Read-Contract'], V12);
  assert.deepEqual(JSON.parse(sent[0].init.body), { chainId: 8453, positions: ASKED });
});

test('an answer about other positions, or a request the contract refuses, is never data', async () => {
  const answered = createHttpReadV6Transport({ post: async () => reply(200, ANSWER, V12) });
  assert.deepEqual(await readPositionFees(answered, runtime, 8453, [ASKED[0]]), { kind: 'invalid', detail: 'exchange' });
  assert.deepEqual(await readPositionFees(answered, runtime, 8453, []), { kind: 'invalid', detail: 'request' });
  assert.deepEqual(await readPositionFees(answered, runtime, 8453, Array.from({ length: 9 }, (_, i) => ({ dex: 4, tokenId: String(i + 1) }))), { kind: 'invalid', detail: 'request' });
});

test('the route closed is said as closed, in the version the Worker speaks today', async () => {
  const transport = createHttpReadV6Transport({ post: async () => reply(404, { error: 'route_not_available' }, V11) });
  assert.deepEqual(await readPositionFees(transport, runtime, 8453, ASKED), { kind: 'unavailable', reason: 'route_not_available' });
});

test('every other read stays 1.1.0-rc.1, and its answer may carry either version', async () => {
  const body = fixture('valid/portfolio.json');
  const request = fixture('requests/portfolio.json');
  const sent = [];
  const today = createHttpReadV6Transport({ post: async (url, init) => { sent.push(init); return reply(200, body, V11); } });
  assert.equal((await readPortfolio(today, runtime, request.wallet)).kind, 'ok');
  assert.equal(sent[0].headers['X-Domino-Read-Contract'], V11);
  const next = fixture(`${V12}/valid/portfolio.json`);
  const moved = createHttpReadV6Transport({ post: async () => reply(200, next, V12) });
  assert.equal((await readPortfolio(moved, runtime, request.wallet)).kind, 'ok');
  const older = createHttpReadV6Transport({ post: async () => reply(200, body, '1.0.0-rc.1') });
  assert.deepEqual(await readPortfolio(older, runtime, request.wallet), { kind: 'unavailable', reason: 'network' }, 'a version read-v6 no longer has is not the route');
});

// Rewritten on purpose 2026-11-06 (the owner: nothing pending on our side; the read Worker answers its capabilities in the
// version asked): the read route's capabilities are asked in 1.2.0-rc.1 first, and again in 1.1.0-rc.1, exactly as
// production asks them today, when that answer is not 1.2.0-rc.1's own. position-fees is on only from a 1.2.0-rc.1 answer.
const capabilities = (enabledReads, contractVersion = V11) => ({ contractVersion, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads, walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false });
const html = (status) => ({ kind: 'reply', reply: { status, opaqueRedirect: false, contentType: 'text/html; charset=utf-8', contractHeader: null, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: '<!doctype html><title>502</title>' } } });
const TODAY = ['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens'];

/** A capabilities GET: `answer(version)` says what the Worker answers to a request in that version; `seen` the versions asked. */
function worker(answer) {
  const seen = [];
  const get = async (path, options) => {
    assert.equal(path, '/api/read/v6/capabilities');
    const version = options.headers['X-Domino-Read-Contract'];
    seen.push(version);
    return answer(version);
  };
  return { get, seen };
}
/** Today's read Worker: 1.1.0-rc.1 alone; a request in 1.2.0-rc.1 is upstream_contract_mismatch, a 502 in its own version. */
const today = (reads = TODAY) => worker((version) => (version === V11 ? reply(200, capabilities(reads), V11) : reply(502, { error: 'upstream_contract_mismatch' }, V11)));
/** The read Worker of the window: each version's capabilities in that version, position-fees in 1.2.0-rc.1's alone. */
const windowed = (reads) => worker((version) => reply(200, capabilities(version === V12 ? reads : reads.filter((name) => name !== 'position-fees'), version), version));

test('capabilities: a 502 to 1.2.0-rc.1 is asked again in 1.1.0-rc.1, read as production reads it, and position-fees stays off', async (t) => {
  if (!WINDOW) return t.skip(NO_WINDOW);
  assert.equal(V2_ROUTE_SPECS.readV6.version, V11, 'every other read stays 1.1.0-rc.1');
  // Changed on purpose 2026-11-06 (review F2): the Worker's own refusal; an HTML 502, which no Worker sends, is below.
  for (const [name, refusal] of [['the Worker\'s JSON 502', reply(502, { error: 'upstream_contract_mismatch' }, V11)]]) {
    const { get, seen } = worker((version) => (version === V11 ? reply(200, capabilities(TODAY), V11) : refusal));
    const state = await askV2Route('readV6', get);
    assert.deepEqual(state, { on: true, routes: TODAY }, name);
    assert.deepEqual(seen, [V12, V11], `${name}: 1.2.0-rc.1 first, then 1.1.0-rc.1`);
    assert.equal(routeServes(state, 'position-fees'), false);
  }
  // A 1.1.0-rc.1 body, a body that fails the shape, a version this app does not know: none is 1.2.0-rc.1's answer.
  for (const [name, wrong] of [
    ['a 1.1.0-rc.1 answer', reply(200, capabilities(['portfolio', 'position-fees']), V11)],
    ['a 1.1.0-rc.1 body under the 1.2.0-rc.1 header', reply(200, capabilities(['portfolio', 'position-fees']), V12)],
    ['a body without its fields', reply(200, { contractVersion: V12, dataMode: 'live_read_only' }, V12)],
    ['an unknown route', reply(200, capabilities(['portfolio', 'featured-pools'], V12), V12)],
    ['another version', reply(200, capabilities(['portfolio'], '1.3.0-rc.1'), '1.3.0-rc.1')],
  ]) {
    const { get, seen } = worker((version) => (version === V11 ? reply(200, capabilities(['portfolio', 'activity']), V11) : wrong));
    assert.deepEqual(await askV2Route('readV6', get), { on: true, routes: ['portfolio', 'activity'] }, name);
    assert.deepEqual(seen, [V12, V11], name);
  }
  // Changed on purpose 2026-11-06 (review F2): no Worker's answer at all (no reply, an opaque redirect, a reply without the
  // contract header: the forwarder's own 503 and 404, an HTML page) is the same in either version, so it is the answer, in
  // one GET: an outage costs one GET per ask, as before the window, and never twice the GET's deadline.
  const opaque = { kind: 'reply', reply: { ...html(200).reply, opaqueRedirect: true, contentType: null, body: { kind: 'text', text: '' } } };
  for (const [name, none, expected] of [
    ['the network', { kind: 'network' }, { on: false, reason: 'unavailable' }],
    ['a timeout', { kind: 'timeout' }, { on: false, reason: 'unavailable' }],
    ['an opaque redirect', opaque, { on: false, reason: 'unavailable' }],
    ['an HTML 502', html(502), { on: false, reason: 'unavailable' }],
    ['the forwarder\'s 503', reply(503, { error: 'bridge_unavailable' }, null), { on: false, reason: 'unavailable' }],
    ['the forwarder\'s 404', reply(404, { error: 'not_found' }, null), { on: false, reason: 'not_deployed' }],
  ]) {
    let refused = 0;
    const { get, seen } = worker((version) => (version === V11 ? reply(200, capabilities(['portfolio', 'activity']), V11) : none));
    assert.deepEqual(await askV2Route('readV6', get, undefined, { refused: () => { refused += 1; } }), expected, name);
    assert.deepEqual(seen, [V12], `${name}: one GET`);
    assert.equal(refused, 0, `${name}: nothing learned about the Worker`);
  }
  // The Worker's refusal in its own version says it does not speak 1.2.0-rc.1, even when its own version then fails.
  let refused = 0;
  const busy = worker((version) => (version === V11 ? reply(503, { error: 'upstream_unavailable' }, V11) : reply(502, { error: 'upstream_contract_mismatch' }, V11)));
  assert.deepEqual(await askV2Route('readV6', busy.get, undefined, { refused: () => { refused += 1; } }), { on: false, reason: 'unavailable' });
  assert.deepEqual(busy.seen, [V12, V11]);
  assert.ok(refused >= 1, 'learned: its Worker does not speak 1.2.0-rc.1');
});

test('capabilities: a 1.2.0-rc.1 answer without position-fees is on with its routes, in one GET, and position-fees is not asked', async () => {
  const { get, seen } = windowed(TODAY);
  const state = await askV2Route('readV6', get);
  assert.deepEqual(state, { on: true, routes: TODAY });
  assert.deepEqual(seen, [V12]);
  assert.equal(routeServes(state, 'position-fees'), false);
  assert.equal(routeServes(state, 'portfolio'), true);
  // Its own refusals stand in that version: one GET.
  for (const [name, said, expected] of [
    ['disabled', reply(200, { ...capabilities([], V12), dataMode: 'disabled' }, V12), { on: false, reason: 'disabled' }],
    ['a 503 of its own', reply(503, { error: 'upstream_unavailable' }, V12), { on: false, reason: 'unavailable' }],
    ['route_not_available', reply(404, { error: 'route_not_available' }, V12), { on: false, reason: 'disabled' }],
  ]) {
    const asked = worker(() => said);
    assert.deepEqual(await askV2Route('readV6', asked.get), expected, name);
    assert.deepEqual(asked.seen, [V12], name);
  }
});

test('capabilities: a 1.2.0-rc.1 answer with position-fees serves it, and every other read', async () => {
  const { get, seen } = windowed([...TODAY, 'position-fees']);
  const state = await askV2Route('readV6', get);
  assert.deepEqual(state, { on: true, routes: [...TODAY, 'position-fees'] });
  assert.deepEqual(seen, [V12]);
  assert.equal(routeServes(state, 'position-fees'), true);
  for (const name of TODAY) assert.equal(routeServes(state, name), true, name);
});

test('capabilities in 1.1.0-rc.1 that name position-fees never turn the reads off, and never serve it; an unknown route is still refused', (t) => {
  if (!WINDOW) return t.skip(NO_WINDOW);
  const named = routeStateOf('readV6', reply(200, capabilities(['portfolio', 'activity', 'position-fees']), V11));
  assert.deepEqual(named, { on: true, routes: ['portfolio', 'activity'] });
  assert.deepEqual(routeStateOf('readV6', reply(200, capabilities(['position-fees']), V11)), { on: false, reason: 'disabled' }, 'nothing this version serves');
  assert.deepEqual(routeStateOf('readV6', reply(200, capabilities(['portfolio', 'something-else']), V11)), { on: false, reason: 'invalid' }, 'a route this app does not know is still refused');
  // Read in 1.1.0-rc.1, exactly as production: its own header only.
  assert.deepEqual(routeStateOf('readV6', reply(200, capabilities(['portfolio'], V12), V12)), { on: false, reason: 'invalid' });
  assert.deepEqual(routeStateOf('readV6', reply(200, capabilities(['portfolio', 'position-fees'], V12), V12), 'next'), { on: true, routes: ['portfolio', 'position-fees'] });
  assert.deepEqual(routeStateOf('readV6', reply(200, capabilities(['portfolio']), V11), 'next'), { on: false, reason: 'invalid' });
});

test('capabilities: the beta gate and a question given up are not asked twice', async () => {
  const gate = worker(() => ({ kind: 'reply', reply: { status: 401, opaqueRedirect: false, contentType: 'application/json', contractHeader: null, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: '{"error":"beta_access_required"}' } } }));
  assert.deepEqual(await askV2Route('readV6', gate.get), { on: false, reason: 'gate_required' });
  assert.deepEqual(gate.seen, [V12]);
  const gone = worker(() => ({ kind: 'aborted' }));
  assert.deepEqual(await askV2Route('readV6', gone.get), { on: false, reason: 'aborted' });
  assert.deepEqual(gone.seen, [V12]);
  // The plan and crosschain routes have no window: one GET in their own version, as before.
  const plan = [];
  await askV2Route('plan', async (path, options) => { plan.push(options.headers); return { kind: 'network' }; });
  assert.deepEqual(plan, [{ Accept: 'application/json', 'X-Domino-Position-Plan-Contract': V2_ROUTE_SPECS.plan.version }]);
});

test('the probe: today\'s Worker costs one extra GET once per page load; after that it asks 1.1.0-rc.1 alone, as production', async (t) => {
  if (!WINDOW) return t.skip(NO_WINDOW);
  let clock = 1_000;
  const old = today();
  const probe = createV2RouteProbe({ now: () => clock, get: old.get });
  assert.deepEqual(await probe.state('readV6'), { on: true, routes: TODAY });
  assert.deepEqual(old.seen, [V12, V11]);
  // Kept as before: five minutes for an answer that is on, and nothing asked in between, whatever the screens.
  await Promise.all([probe.state('readV6'), probe.state('readV6')]);
  assert.equal(old.seen.length, 2);
  clock += 300_000;
  await probe.state('readV6');
  assert.deepEqual(old.seen, [V12, V11, V11], 'the refused version is not asked again this page load');
  probe.forget();
  await probe.state('readV6');
  assert.deepEqual(old.seen.slice(3), [V12, V11], 'forget() asks it afresh');
  // Changed on purpose 2026-11-06 (review F2): no answer for the moment: nothing is kept and nothing learned, and each
  // question is one GET (it was two); the next question starts at 1.2.0-rc.1 again.
  const down = worker(() => ({ kind: 'network' }));
  const outage = createV2RouteProbe({ now: () => clock, get: down.get });
  assert.deepEqual(await outage.state('readV6'), { on: false, reason: 'unavailable' });
  await outage.state('readV6');
  assert.deepEqual(down.seen, [V12, V12]);
  // Today's Worker with its upstream down: its 502 in 1.1.0-rc.1 is learned, so the next question asks 1.1.0-rc.1 alone.
  const flaky = worker((version) => (version === V11 ? reply(503, { error: 'upstream_unavailable' }, V11) : reply(502, { error: 'upstream_contract_mismatch' }, V11)));
  const learned = createV2RouteProbe({ now: () => clock, get: flaky.get });
  assert.deepEqual(await learned.state('readV6'), { on: false, reason: 'unavailable' });
  await learned.state('readV6');
  assert.deepEqual(flaky.seen, [V12, V11, V11]);
});

test('the probe: the windowed Worker is asked once per answer, and says what it keeps without asking', async (t) => {
  if (!WINDOW) return t.skip(NO_WINDOW);
  let clock = 1_000;
  const next = windowed([...TODAY, 'position-fees']);
  const probe = createV2RouteProbe({ now: () => clock, get: next.get });
  assert.equal(probe.known('readV6'), null);
  assert.equal(next.seen.length, 0, 'knowing asks nothing');
  await probe.state('readV6');
  assert.deepEqual(next.seen, [V12]);
  assert.equal(routeServes(probe.known('readV6'), 'position-fees'), true);
  clock += 300_000;
  await probe.state('readV6');
  assert.deepEqual(next.seen, [V12, V12]);
});
