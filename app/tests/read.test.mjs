/**
 * The read adapter against rugged97's own package, in place.
 *
 * Every fixture in api-contracts/read-v1/fixtures/index.json goes through the
 * real pipeline with the real runtime, and every state the contract can end
 * in is checked for what it becomes. The beta gate is the compiled
 * functions/_middleware.ts; the bridge is the real bridge/src/worker.mjs in
 * front of a fake gateway. Nothing here re-implements a validator.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/lib/read/${name}.js`);
const { interpretReply, GATE_REFUSAL, GATE_PAGE_MARKER } = built('interpret');
const { createFixtureSource } = built('fixtureSource');
const { createBridgeSource, READ_HEADERS, READ_INIT } = built('bridgeSource');
const { BRIDGE_RETRY } = built('pipeline');
const { ERROR_CLASS } = built('errors');
const { createScheduledSource, GATEWAY_BUDGET, BUDGET_RESERVE } = built('scheduler');
const { createPublicMetadataCache, TOKEN_METADATA_CACHE_MS } = built('publicMetadataCache');
const { describeFailure, reasonText } = built('describe');
const decimal = built('decimal');
const project = built('project');
const pagers = built('pagers');
const scenarios = built('scenarios');
const { loadSelectedPools, createReadMarketsProvider, tableMarketRequest, LEAVE_GRACE_MS, BUSY_RECOVERY_ATTEMPTS, PROVIDER_BUSY_ATTEMPTS, busyRecoveryDelayMs, providerBusyDelayMs } = built('marketsProvider');
const markets = require('../.test-build/app/src/lib/markets.js');
const middleware = require('../.test-build/app/functions/_middleware.js');

const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1');
const SRC = resolve(import.meta.dirname, '../src');
const text = (path) => readFileSync(join(READ, path), 'utf8');
const INDEX = JSON.parse(text('fixtures/index.json'));
const catalog = { index: INDEX, text };
const { FIXTURE_POOL, FIXTURE_TOKEN, NATIVE, MUTATED_CURSOR, gateway, errorFixture, invalidFixture, requestFor } = scenarios;

const ROUTES = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot'];
const RC3 = '1.1.0-rc.3';

/** A fixture source serving one script, with the real runtime. */
const fixtures = (script, options = {}) => createFixtureSource({ catalog, validators: runtime, script, ...options });
const one = (route, fixture, extra = {}) => fixtures({ [route]: [{ fixture, ...extra }] });

/** The runtime, counting every call that would treat a body as a producer payload. */
function spied() {
  const calls = { assertResponse: 0, validateError: 0 };
  return {
    calls,
    validators: {
      ...runtime,
      assertResponse: (...args) => (calls.assertResponse++, runtime.assertResponse(...args)),
      validateError: (...args) => (calls.validateError++, runtime.validateError(...args)),
    },
  };
}

/**
 * A clock that only moves when the code under test sleeps, or when a test
 * moves it; its timers fire as it passes them. It keeps two times, as a
 * browser does: `monotonic`, which only moves forward and which its timers
 * run on, and `now`, the wall clock. `advance` moves both, as time passing
 * does; `jump` steps the wall clock alone, as an NTP step, a manual change or
 * a resume from sleep can. `random` is the jitter draw.
 */
function fakeClock({ random = () => 0 } = {}) {
  let steady = 0;
  let wall = 0;
  const delays = [];
  const timers = new Set();
  const advance = (ms) => {
    steady += ms;
    wall += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > steady) break;
      // One that an earlier one cancelled does not fire.
      if (timers.delete(timer)) timer.fire();
    }
  };
  return {
    delays,
    advance,
    jump: (ms) => {
      wall += ms;
    },
    now: () => wall,
    monotonic: () => steady,
    random,
    timer: (ms, fire) => {
      const timer = { at: steady + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      delays.push(ms);
      advance(ms);
    },
  };
}

const raw = (status, contentType, body, contract = RC3, extra = {}) => ({
  status,
  opaqueRedirect: false,
  contentType,
  contractHeader: contract,
  requestIdHeader: null,
  retryAfterHeader: null,
  body: { kind: 'text', text: body },
  ...extra,
});
const provenance = { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 };
const tokenRequest = { token: FIXTURE_TOKEN };
/** A token no fixture mentions. */
const OTHER_TOKEN = `0x${'12'.repeat(20)}`;

// ---------------------------------------------------------------------------
// R1: nine routes, one interface, every fixture
// ---------------------------------------------------------------------------

test('the nine read routes are the runtime’s, the index’s and the lab’s, and nothing else', () => {
  assert.deepEqual([...runtime.ENABLED_READS].sort(), [...ROUTES].sort());
  assert.deepEqual(INDEX.requests.map((r) => r.route).sort(), [...ROUTES].sort());
  const gatewayRoutes = new Set(INDEX.fixtures.filter((f) => f.kind === 'gateway').map((f) => f.route));
  assert.deepEqual([...gatewayRoutes].sort(), [...ROUTES, 'capabilities'].sort());
  const labRoutes = new Set(scenarios.familyCases(catalog).map((c) => c.route));
  assert.deepEqual([...labRoutes].sort(), [...ROUTES].sort(), 'the read lab covers every route');
  for (const route of ROUTES) {
    assert.equal(runtime.validateRequest(route, requestFor(catalog, route)), true, `${route} canonical request`);
  }
});

const CLASS_STATE = {
  restart: 'restart_required',
  route_disabled: 'disabled',
  request_rejected: 'request_rejected',
  busy: 'busy',
  incompatible: 'incompatible',
  unavailable: 'unavailable',
};

for (const entry of INDEX.fixtures.filter((f) => f.kind !== 'producer' && f.route !== 'capabilities')) {
  test(`fixture ${entry.file} reaches the state it describes`, async () => {
    const request = requestFor(catalog, entry.route, entry.file);
    assert.equal(runtime.validateRequest(entry.route, request), true, 'the request that fits the fixture is itself valid');
    const outcome = await one(entry.route, entry.file).read(entry.route, request);

    if (entry.kind === 'invalid') {
      assert.equal(outcome.state, 'invalid');
      assert.equal(outcome.reason, 'response_contract');
      assert.equal('data' in outcome, false, 'an invalid payload carries nothing to render');
      return;
    }
    if (entry.kind === 'error') {
      const code = JSON.parse(text(entry.file)).error;
      assert.equal(entry.status, runtime.ERROR_STATUS_BY_CODE[code], 'the index status is the runtime status');
      const rule = ERROR_CLASS[code];
      assert.equal(outcome.state, CLASS_STATE[rule.kind], `${code} -> ${outcome.state}`);
      if (rule.kind === 'unavailable') {
        assert.equal(outcome.retryable, rule.retryable);
        assert.deepEqual(outcome.cause, { kind: 'producer', code, status: entry.status });
      }
      assert.equal('data' in outcome, false);
      return;
    }
    // A gateway fixture: ok, with provenance and freshness, and it projects.
    assert.equal(outcome.state, 'ok', `${entry.file}: ${outcome.state} ${outcome.reason ?? ''}`);
    assert.equal(outcome.provenance.transport, 'fixture');
    assert.equal(outcome.provenance.fixture, entry.file.replace(/^fixtures\//, ''));
    assert.equal(outcome.provenance.contract, RC3);
    assert.equal(outcome.provenance.attempts, 1);
    if (entry.route === 'catalogue' || entry.route === 'markets-snapshot') {
      // Stored views: no block evidence in the reply itself.
      assert.equal(outcome.observation.block, null);
    }
    if (entry.route === 'catalogue') {
      assert.deepEqual(outcome.observation.interval, { startBlock: 10, indexedThrough: 650, coverage: 'configured_interval_only' });
      assert.equal(outcome.observation.revision, 2);
    } else if (entry.route !== 'markets-snapshot') {
      assert.equal(typeof outcome.observation.block.number, 'number');
      assert.match(outcome.observation.block.hash, /^0x[0-9a-f]{64}$/);
    }
    if (entry.route === 'wallet-assets') {
      const step = await pagers.createWalletPager(one(entry.route, entry.file), request).first();
      assert.equal(step.failure, null);
      assert.ok(step.view.rows.length + step.view.unavailable.length > 0);
    } else {
      const view = project.projectFamily(outcome);
      assert.equal(view.route, entry.route);
      assert.ok(view.facts.length > 0);
      assert.ok(view.freshness.length > 0);
    }
  });
}

test('both capabilities fixtures are valid capabilities replies', () => {
  for (const name of ['capabilities.disabled', 'capabilities.live_read_only']) {
    assert.equal(runtime.validateResponse('capabilities', JSON.parse(text(`fixtures/gateway/${name}.json`))), true, name);
  }
});

test('every mutation in the scenarios still passes the package runtime', () => {
  const opaque = scenarios.withCursor(MUTATED_CURSOR)(JSON.parse(text(gateway('wallet-assets.opaque-page'))));
  assert.equal(runtime.validateResponse('wallet-assets', opaque), true);
  assert.match(MUTATED_CURSOR, /^[0-9a-f]{64}$/);
  assert.equal(runtime.validateResponse('catalogue', scenarios.withNextCataloguePage(JSON.parse(text(gateway('catalogue.success'))))), true);
  const hostile = scenarios.withSymbol(scenarios.HOSTILE_SYMBOL)(JSON.parse(text(gateway('token.success'))));
  assert.equal(runtime.validateResponse('token', hostile), true);
  for (const name of ['success', 'zero', 'missing', 'stale', 'expired', 'rejected', 'rejected-currencies', 'provider-timeout', 'provider-rate-limited']) {
    const body = scenarios.withoutHistory(JSON.parse(text(gateway(`pool-market.${name}`))));
    assert.equal(runtime.validateResponse('pool-market', body), true, `pool-market.${name} without history`);
  }
  const stored = scenarios.MARKET_CASES.filter((c) => c.script['markets-snapshot']);
  assert.equal(stored.length, 10, 'the snapshot cases of the read lab');
  for (const { id, script } of stored) {
    const [step] = script['markets-snapshot'];
    if (!step.mutate) continue;
    assert.equal(runtime.validateResponse('markets-snapshot', step.mutate(JSON.parse(text(step.fixture)))), true, id);
  }
});

test('a fixture source lists exactly the routes its script answers, asked without a request; the screens’ wrappers and the queue pass the question on', async () => {
  const { withReadBudget } = built('screens/screenRead');
  const { withDelays } = built('screens/delayedSource');
  const script = { 'markets-snapshot': [{ fixture: gateway('markets-snapshot.subset') }], token: [{ fixture: gateway('token.success') }] };
  const source = fixtures(script);
  assert.deepEqual(await source.routeEnabled('markets-snapshot'), { state: 'enabled' });
  assert.deepEqual(await source.routeEnabled('pool-metrics'), { state: 'not_enabled' });
  const cancelled = new AbortController();
  cancelled.abort();
  const stopped = await source.routeEnabled('token', { signal: cancelled.signal });
  assert.deepEqual([stopped.state, stopped.outcome.route, stopped.outcome.state], ['failed', 'token', 'aborted']);
  assert.deepEqual(source.requests, [], 'asking is not a read');
  const logged = withDelays(source, () => ({ hang: true }));
  const wrapped = withReadBudget(createScheduledSource(logged, { minIntervalMs: 0 }));
  assert.deepEqual([await wrapped.routeEnabled('markets-snapshot'), await wrapped.routeEnabled('pool-positions')], [{ state: 'enabled' }, { state: 'not_enabled' }]);
  assert.deepEqual(logged.log, [], 'never delayed, never logged');
  const bare = { transport: 'fixture', read: source.read };
  assert.equal('routeEnabled' in withReadBudget(bare), false, 'a source that cannot say still cannot through the wrapper');
  assert.equal('routeEnabled' in withDelays(bare, () => undefined), false);
});

// ---------------------------------------------------------------------------
// R2: the order — gate, header, then the runtime
// ---------------------------------------------------------------------------

const GATE_ENV = { BETA_PASSWORD: 'adapter-test-beta-password', BETA_COOKIE_KEY: 'Hk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeA' };

/** The compiled beta gate as the only thing on the wire, with no cookie. */
function behindGate(env) {
  const seen = [];
  const fetch = async (path, init) => {
    seen.push({ path, init });
    const request = new Request(new URL(path, 'https://domino.money'), { method: init.method, headers: init.headers, body: init.body });
    return middleware.onRequest({ request, env, next: () => { throw new Error('the gate let a read through without a cookie'); } });
  };
  return { fetch, seen };
}

test('the real gate’s 401 is gate_required, decided before any producer validation', async () => {
  const { calls, validators } = spied();
  const wire = behindGate(GATE_ENV);
  const outcome = await createBridgeSource({ enabled: true, validators, fetch: wire.fetch, clock: fakeClock() }).read('token', tokenRequest);
  assert.equal(outcome.state, 'gate_required');
  assert.equal(outcome.route, 'token');
  assert.deepEqual(calls, { assertResponse: 0, validateError: 0 });
  assert.equal(wire.seen.length, 1, 'only the capabilities GET was attempted; the POST never went out');
  assert.equal(describeFailure(outcome).signIn, true);
});

test('the real gate’s 503 page (broken configuration) is gate_unavailable, before any validation', async () => {
  const { calls, validators } = spied();
  const outcome = await createBridgeSource({ enabled: true, validators, fetch: behindGate({}).fetch, clock: fakeClock() }).read('pool-market', {
    poolId: FIXTURE_POOL,
  });
  assert.equal(outcome.state, 'gate_unavailable');
  assert.deepEqual(calls, { assertResponse: 0, validateError: 0 });
});

test('gate detection is exact: its body decides, the header does not', () => {
  const run = (reply) => interpretReply('token', tokenRequest, reply, runtime, provenance);
  // A 401 carrying the contract header and the gate's body is still the gate.
  assert.equal(run(raw(401, 'application/json', GATE_REFUSAL)).state, 'gate_required');
  assert.equal(run(raw(401, 'application/json; charset=utf-8', GATE_REFUSAL, null)).state, 'gate_required');
  // Any other 401 is nobody we know.
  const other = run(raw(401, 'application/json', '{"error":"invalid_request"}'));
  assert.deepEqual([other.state, other.reason], ['invalid', 'unrecognised_401']);
  // A producer 503 is not the gate.
  const producer = run(raw(503, 'application/json; charset=utf-8', '{"error":"upstream_unavailable"}'));
  assert.equal(producer.state, 'unavailable');
  assert.equal(producer.cause.kind, 'producer');
  // An HTML 5xx without the gate's page is the edge, not the gate and not a contract.
  for (const status of [500, 502, 503, 504]) {
    const edge = run(raw(status, 'text/html; charset=UTF-8', '<html>error</html>', null));
    assert.deepEqual([edge.state, edge.cause.kind, edge.retryable], ['unavailable', 'edge', false], `HTML ${status}`);
  }
  assert.equal(run(raw(503, 'text/html', `<html><head>${GATE_PAGE_MARKER}</head></html>`, null)).state, 'gate_unavailable');
  assert.equal(run({ ...raw(0, null, '', null), opaqueRedirect: true }).state, 'access_required');
});

test('a missing or rc.2 contract header is incompatible, and no validator sees the body', () => {
  const body = text(gateway('token.success'));
  for (const [reply, reason] of [
    [raw(200, 'application/json', body, null), 'contract_header_missing'],
    [raw(200, 'application/json', body, '1.1.0-rc.2'), 'contract_version_not_accepted'],
    [raw(200, 'application/json', body, ` ${RC3}`), 'contract_version_not_accepted'],
    [raw(503, 'application/json', '{"error":"upstream_unavailable"}', null), 'contract_header_missing'],
    [raw(503, 'application/json', '{"error":"upstream_unavailable"}', '1.0.0'), 'contract_version_not_accepted'],
  ]) {
    const { calls, validators } = spied();
    const outcome = interpretReply('token', tokenRequest, reply, validators, provenance);
    assert.deepEqual([outcome.state, outcome.reason], ['incompatible', reason]);
    assert.deepEqual(calls, { assertResponse: 0, validateError: 0 });
  }
  // HTML with a 200 and no header is not the bridge: it is a site with no /api function (below).
  const spa = interpretReply('token', tokenRequest, raw(200, 'text/html', '<!doctype html>', null), runtime, provenance);
  assert.deepEqual([spa.state, spa.reason], ['not_connected', 'no_forwarder']);
});

// ---------------------------------------------------------------------------
// The site's own /api layer (#80): refusals from the forwarder, or no forwarder
// at all. Recognised after the gate and before the contract header.
// ---------------------------------------------------------------------------

const FORWARDER = [
  [503, '{"error":"bridge_unavailable"}', 'bridge_unavailable'],
  [404, '{"error":"not_found"}', 'not_found'],
  [403, '{"error":"worker_subrequest_refused"}', 'worker_subrequest_refused'],
];
const kind = (outcome) => [outcome.state, outcome.reason ?? outcome.cause?.kind];

test('the /api forwarder’s refusals are not_connected, decided before the contract header and before any validation', () => {
  for (const [status, body, reason] of FORWARDER) {
    const { calls, validators } = spied();
    const outcome = interpretReply('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false }, raw(status, 'application/json; charset=utf-8', body, null), validators, provenance);
    assert.deepEqual([outcome.state, outcome.reason], ['not_connected', reason], `${status} ${body}`);
    assert.deepEqual(calls, { assertResponse: 0, validateError: 0 }, 'no validator sees the body');
    assert.equal('data' in outcome, false);
  }
});

test('only the forwarder’s exact refusal is not_connected: another status, other bytes, other media or a contract header is not the forwarder', () => {
  const run = (reply) => interpretReply('token', tokenRequest, reply, runtime, provenance);
  // The right code under the wrong status, the wrong code under the right one, or anything added: header-less JSON, which is no contract.
  for (const [status, body] of [
    [404, '{"error":"bridge_unavailable"}'],
    [503, '{"error":"not_found"}'],
    [403, '{"error":"not_found"}'],
    [503, '{"error":"bridge_unavailable","detail":1}'],
    [503, '{"error": "bridge_unavailable"}'],
    [503, '{"error":"bridge_unavailable"}\n'],
    [503, '{"error":"upstream_unavailable"}'],
  ]) {
    assert.deepEqual(kind(run(raw(status, 'application/json; charset=utf-8', body, null))), ['incompatible', 'contract_header_missing'], `${status} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(kind(run(raw(503, 'text/plain', '{"error":"bridge_unavailable"}', null))), ['unavailable', 'edge'], 'not JSON media');
  // With the contract header it is the bridge speaking, and bridge_unavailable is no read-v1 code.
  assert.deepEqual(kind(run(raw(503, 'application/json', '{"error":"bridge_unavailable"}'))), ['invalid', 'error_contract']);
  // The gate's own answers still come first.
  assert.equal(run(raw(401, 'application/json; charset=utf-8', GATE_REFUSAL, null)).state, 'gate_required');
  assert.equal(run(raw(503, 'text/html', `<html><head>${GATE_PAGE_MARKER}</head></html>`, null)).state, 'gate_unavailable');
  assert.equal(run({ ...raw(0, null, '', null), opaqueRedirect: true }).state, 'access_required');
});

test('a site with no /api function answers a read with its index page: not_connected, not an edge error; other pages are still the edge', () => {
  const run = (reply) => interpretReply('token', tokenRequest, reply, runtime, provenance);
  for (const type of ['text/html; charset=utf-8', 'text/html']) {
    assert.deepEqual(kind(run(raw(200, type, '<!doctype html><div id="root"></div>', null))), ['not_connected', 'no_forwarder'], type);
  }
  for (const status of [404, 500, 502, 504]) {
    assert.deepEqual(kind(run(raw(status, 'text/html; charset=UTF-8', '<html>error</html>', null))), ['unavailable', 'edge'], `HTML ${status}`);
  }
  // HTML under the contract header is a broken bridge reply, not a missing forwarder.
  assert.deepEqual(kind(run(raw(200, 'text/html', '<!doctype html>'))), ['invalid', 'not_json']);
});

test('a forwarder refusal of the capabilities GET ends the read there: one GET, no POST, and nothing kept for the next read', async () => {
  const replies = [
    ...FORWARDER.map(([status, body, reason]) => [reason, () => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })]),
    ['no_forwarder', () => new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })],
  ];
  for (const [reason, answer] of replies) {
    const seen = [];
    const fetch = async (path, init) => (seen.push(`${init.method} ${path}`), answer());
    const { calls, validators } = spied();
    const source = createBridgeSource({ enabled: true, validators, fetch, clock: fakeClock() });
    const outcome = await source.read('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false });
    assert.deepEqual([outcome.state, outcome.reason, outcome.route], ['not_connected', reason, 'pool-market'], reason);
    assert.equal(outcome.provenance.attempts, 1, 'asked once, never again on its own');
    assert.deepEqual(seen, ['GET /api/read/v1/capabilities'], `${reason}: the POST never went out`);
    assert.deepEqual(calls, { assertResponse: 0, validateError: 0 });
    assert.equal((await source.read('token', tokenRequest)).state, 'not_connected');
    assert.deepEqual(seen, ['GET /api/read/v1/capabilities', 'GET /api/read/v1/capabilities'], `${reason}: a refusal is not kept, and still nothing is posted`);
  }
  // The fixture transports carry the same bytes through the same pipeline.
  for (const [transport, reason] of [['forwarder503', 'bridge_unavailable'], ['forwarder404', 'not_found'], ['forwarder403', 'worker_subrequest_refused'], ['spaHtml200', 'no_forwarder']]) {
    const outcome = await fixtures({ token: [{ transport }] }).read('token', tokenRequest);
    assert.deepEqual([outcome.state, outcome.reason], ['not_connected', reason], transport);
  }
});

test('the honest states have their own words, and none offers a Retry that cannot help', () => {
  const words = (failure) => {
    const text = describeFailure({ route: 'pool-market', provenance: {}, ...failure });
    return [text.title, text.retry, Boolean(text.signIn)];
  };
  const NOT_CONNECTED = 'Live data unavailable';
  assert.deepEqual(words({ state: 'not_connected', reason: 'bridge_unavailable' }), [NOT_CONNECTED, false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'no_forwarder' }), [NOT_CONNECTED, false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'not_found' }), ['Live data isn\'t available here', false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'worker_subrequest_refused' }), ['Request refused', false, false]);
  for (const reason of ['bridge_data_mode_disabled', 'route_not_enabled', 'live_data_disabled']) {
    assert.deepEqual(words({ state: 'disabled', reason }), ['Live data is switched off for now', false, false], reason);
  }
  assert.deepEqual(words({ state: 'gate_required' }), ['Access expired', false, true]);
  assert.deepEqual(words({ state: 'busy', retryAfterSeconds: 3 }), ['Read service busy', true, false]);
  assert.deepEqual(words({ state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true }), ['Pool data unavailable', true, false]);
  // Every producer code the error table calls transient reads as temporarily unavailable, with a Retry for a person;
  // every final one keeps its own title and offers none.
  let transient = 0;
  for (const [code, rule] of Object.entries(ERROR_CLASS)) {
    if (rule.kind !== 'unavailable') continue;
    const failure = { state: 'unavailable', cause: { kind: 'producer', code, status: runtime.ERROR_STATUS_BY_CODE[code] }, retryable: rule.retryable };
    assert.deepEqual(words(failure), rule.retryable ? ['Temporarily unavailable', true, false] : ['Pool data unavailable', false, false], code);
    if (rule.retryable) transient += 1;
  }
  assert.ok(transient >= 3, 'upstream_unavailable, upstream_timeout and read_deadline_exceeded at least');
  assert.match(describeFailure({ route: 'pool-market', provenance: {}, state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true }).detail, /answered: read service unavailable/);
});

test('invalid payloads fail closed as `invalid`, with nothing to render', async () => {
  const mutated = (route, fixture, mutate, request = requestFor(catalog, route, fixture)) => one(route, fixture, { mutate }).read(route, request);
  const cases = [
    ['wallet amountRaw as a number', () => mutated('wallet-assets', gateway('wallet-assets.fallback'), (b) => ((b.items[1].amountRaw = 5), b)), 'response_contract'],
    ['snapshot removed', () => mutated('token', gateway('token.success'), (b) => (delete b.snapshot, b)), 'response_contract'],
    ['unknown key added', () => mutated('token', gateway('token.success'), (b) => ((b.extra = true), b)), 'response_contract'],
    ['symbol as a number', () => mutated('token', gateway('token.success'), (b) => ((b.asset.symbol = 7), b)), 'response_contract'],
    ['chain 1', () => mutated('token', gateway('token.success'), (b) => ((b.chainId = 1), b)), 'response_contract'],
    ['reference analytics claimed current', () => mutated('pool-metrics', gateway('pool-metrics.reference-analytics'), (b) => ((b.usableAsCurrent24h = true), b)), 'response_contract'],
    ['provider volume as a number', () => mutated('pool-market', gateway('pool-market.success'), (b) => ((b.market.data.volume24hUsd = 0), b)), 'response_contract'],
    ['another token answered', () => one('token', gateway('token.success')).read('token', { token: NATIVE }), 'identity_mismatch'],
    ['another pool answered', () => one('pool-market', gateway('pool-market.success')).read('pool-market', { poolId: `0x${'ab'.repeat(32)}` }), 'identity_mismatch'],
    ['market currencies differ from the pool', () => mutated('pool-market', gateway('pool-market.success'), (b) => ((b.market.data.currencies = [...b.market.data.currencies].reverse()), b)), 'identity_mismatch'],
    ['history asked for, not requested answered', () => one('pool-market', gateway('pool-market.not-requested')).read('pool-market', requestFor(catalog, 'pool-market')), 'identity_mismatch'],
    ['NFT snapshot at another block', () => one('nft-positions', gateway('nft-positions.stale')).read('nft-positions', requestFor(catalog, 'nft-positions')), 'identity_mismatch'],
    // Every bound route: an answer about another pool, token or revision is a wrong answer.
    ['pool metrics about another pool', () => one('pool-metrics', gateway('pool-metrics.qualified')).read('pool-metrics', { poolId: scenarios.OTHER_POOL }), 'identity_mismatch'],
    ['pool activity about another pool', () => one('pool-activity', gateway('pool-activity.success')).read('pool-activity', { ...requestFor(catalog, 'pool-activity'), poolId: scenarios.OTHER_POOL }), 'identity_mismatch'],
    ['pool positions about another pool', () => one('pool-positions', gateway('pool-positions.success')).read('pool-positions', { ...requestFor(catalog, 'pool-positions'), poolId: scenarios.OTHER_POOL }), 'identity_mismatch'],
    ['pool metrics payload naming another pool', () => mutated('pool-metrics', gateway('pool-metrics.qualified'), scenarios.withPoolId(scenarios.OTHER_POOL)), 'identity_mismatch'],
    ['pools for another token', () => one('pools', gateway('pools.success')).read('pools', { ...requestFor(catalog, 'pools'), token: OTHER_TOKEN }), 'identity_mismatch'],
    ['catalogue for another token', () => one('catalogue', gateway('catalogue.success')).read('catalogue', { ...requestFor(catalog, 'catalogue'), token: OTHER_TOKEN }), 'identity_mismatch'],
    ['catalogue at another revision', () => one('catalogue', gateway('catalogue.success')).read('catalogue', { ...requestFor(catalog, 'catalogue'), revision: 3 }), 'identity_mismatch'],
    ['an NFT that was not asked for', () => one('nft-positions', gateway('nft-positions.success')).read('nft-positions', { tokenIds: ['1'], blockNumber: 700 }), 'identity_mismatch'],
    ['not JSON', () => one('token', gateway('token.success'), { transport: 'notJson' }).read('token', tokenRequest), 'not_json'],
    ['malformed JSON', () => one('token', gateway('token.success'), { transport: 'malformedJson' }).read('token', tokenRequest), 'invalid_json'],
    ['over the size bound', () => one('token', gateway('token.success'), { transport: 'tooLarge' }).read('token', tokenRequest), 'too_large'],
  ];
  for (const [name, run, reason] of cases) {
    const outcome = await run();
    assert.deepEqual([outcome.state, outcome.reason], ['invalid', reason], name);
    assert.equal('data' in outcome, false, `${name} carries data`);
  }
  // Error bodies: the code and the status must agree, and the code must exist.
  for (const [status, body] of [[404, '{"error":"upstream_unavailable"}'], [503, '{"error":"no_such_code"}'], [503, '{"error":"upstream_unavailable","detail":"x"}'], [503, '[]']]) {
    const outcome = interpretReply('token', tokenRequest, raw(status, 'application/json', body), runtime, provenance);
    assert.deepEqual([outcome.state, outcome.reason], ['invalid', 'error_contract'], `${status} ${body}`);
  }
});

test('nft-positions is an answer only with exactly one result per requested id (#69 D2)', async () => {
  const success = gateway('nft-positions.success');
  const zero = gateway('nft-positions.zero');
  const [, big] = requestFor(catalog, 'nft-positions').tokenIds;
  const read = (fixture, request, mutate) => one('nft-positions', fixture, mutate ? { mutate } : {}).read('nft-positions', request);
  const refused = async (label, pending) => {
    const outcome = await pending;
    assert.deepEqual([outcome.state, outcome.reason], ['invalid', 'identity_mismatch'], label);
    assert.equal('data' in outcome, false, `${label} carries data`);
  };
  // rugged97's probe: two ids asked for at the latest block, only "1" answered.
  await refused('an id with no result', read(zero, { tokenIds: ['1', '999999999'], blockNumber: null }));
  await refused('an id with no result, at a pinned block', read(success, { tokenIds: ['1', big, '999999999'], blockNumber: 700 }));
  // As many results as ids, but one id twice and the other missing. The package runtime accepts this body.
  const twice = (body) => ((body.items[1] = { ...body.items[0] }), body);
  await refused('one id answered twice, the other not at all', read(success, { tokenIds: ['1', big], blockNumber: 700 }, twice));
  await refused('one id asked for and answered twice', read(success, { tokenIds: ['1'], blockNumber: 700 }, twice));
  await refused('an id that was not asked for', read(success, { tokenIds: ['1'], blockNumber: 700 }));
  // The pinned-block check stays: the right id at another block is still a wrong answer.
  await refused('the right id at another block', read(gateway('nft-positions.stale'), { tokenIds: ['1'], blockNumber: 700 }));
  // The complete set, in either order, is the answer.
  for (const tokenIds of [['1', big], [big, '1']]) {
    assert.equal((await read(success, { tokenIds, blockNumber: 700 })).state, 'ok', tokenIds.join(' then '));
  }
  assert.equal((await read(zero, { tokenIds: ['1'], blockNumber: null })).state, 'ok');
});

// R-1 on #1: one retry policy for every logical read, in the pipeline both sources share.
const busyReply = (after) => ({ fixture: errorFixture('token.read_capacity_busy'), retryAfter: after });
const tokenOk = { fixture: gateway('token.success') };

test('R-1: a validated 429 read_capacity_busy is asked again after its Retry-After plus jitter, three attempts in all', async () => {
  // Retry-After 2, then 3: waits of 2 s and 3 s, each plus the jitter drawn (0.9 of 250 ms).
  const clock = fakeClock({ random: () => 0.9 });
  const outcome = await fixtures({ token: [busyReply('2'), busyReply('3'), tokenOk] }, { clock, policy: BRIDGE_RETRY }).read('token', tokenRequest);
  assert.deepEqual([outcome.state, outcome.provenance.attempts], ['ok', 3]);
  assert.deepEqual(clock.delays, [2225, 3225]);

  // A third 429 is shown, with the wait it asks for.
  const always = fixtures({ token: [busyReply('4')] }, { clock: fakeClock(), policy: BRIDGE_RETRY });
  const shown = await always.read('token', tokenRequest);
  assert.deepEqual([shown.state, shown.retryAfterSeconds, shown.provenance.attempts], ['busy', 4, 3]);
  assert.equal(describeFailure(shown).detail, 'Try again in 4 s.');

  // Out of the bridge's 1 to 60 s, or missing: its fallback of 1 s.
  const fallback = fakeClock();
  await fixtures({ token: [busyReply('61'), busyReply(undefined), tokenOk] }, { clock: fallback, policy: BRIDGE_RETRY }).read('token', tokenRequest);
  assert.deepEqual(fallback.delays, [1000, 1000]);
});

test('R-1: a transient 503 or 504, rc.3’s gas and revert codes included, is shown after one attempt, as itself, for a person to retry', async () => {
  for (const [code, status] of [['upstream_unavailable', 503], ['upstream_timeout', 504], ['rpc_call_gas_limit', 503], ['rpc_call_reverted', 503], ['stale_or_future_block', 503]]) {
    assert.equal(runtime.validateError(status, { error: code }), true, code);
    const clock = fakeClock();
    const outcome = await fixtures({ token: [{ fixture: errorFixture(`token.${code}`) }, tokenOk] }, { clock, policy: BRIDGE_RETRY }).read('token', tokenRequest);
    assert.equal(outcome.state, 'unavailable', code);
    assert.deepEqual(outcome.cause, { kind: 'producer', code, status }, code);
    assert.equal(outcome.retryable, true, `${code} is transient`);
    assert.equal(outcome.provenance.attempts, 1, `${code} was asked again automatically`);
    assert.deepEqual(clock.delays, [], code);
    assert.equal(describeFailure(outcome).retry, true, `${code} offers Retry`);
  }
  // Retry, pressed by the person, is a new read.
  const source = fixtures({ token: [{ fixture: errorFixture('token.upstream_unavailable') }, tokenOk] }, { clock: fakeClock(), policy: BRIDGE_RETRY });
  assert.equal((await source.read('token', tokenRequest)).state, 'unavailable');
  assert.equal((await source.read('token', tokenRequest)).state, 'ok');
});

test('R-1: nothing else is asked again on its own', async () => {
  const attemptsFor = async (script) => {
    const outcome = await fixtures({ token: [script, tokenOk] }, { clock: fakeClock(), policy: BRIDGE_RETRY }).read('token', tokenRequest);
    return [outcome.state, outcome.provenance.attempts];
  };
  assert.deepEqual(await attemptsFor({ transport: 'network' }), ['unavailable', 1], 'a transport failure is ambiguous, so it is shown');
  assert.deepEqual(await attemptsFor({ transport: 'edgeHtml502' }), ['unavailable', 1]);
  assert.deepEqual(await attemptsFor({ transport: 'gate401' }), ['gate_required', 1]);
  assert.deepEqual(await attemptsFor({ transport: 'gate503' }), ['gate_unavailable', 1]);
  assert.deepEqual(await attemptsFor({ transport: 'opaqueRedirect' }), ['access_required', 1]);
  assert.deepEqual(await attemptsFor({ ...tokenOk, transport: 'headerMissing' }), ['incompatible', 1]);
  assert.deepEqual(await attemptsFor({ fixture: errorFixture('token.upstream_contract_mismatch') }), ['incompatible', 1]);
  assert.deepEqual(await attemptsFor({ ...tokenOk, transport: 'malformedJson' }), ['invalid', 1]);
  assert.deepEqual(await attemptsFor({ ...tokenOk, mutate: (b) => ((b.asset.symbol = 7), b) }), ['invalid', 1]);
  assert.deepEqual(await attemptsFor({ fixture: gateway('token.native') }), ['invalid', 1], 'an answer about another token');
  assert.deepEqual(await attemptsFor({ fixture: errorFixture('token.upstream_unavailable'), mutate: () => ({ error: 'catalogue_not_configured' }) }), ['unavailable', 1]);
  assert.deepEqual(await attemptsFor({ fixture: errorFixture('token.invalid_request') }), ['request_rejected', 1]);
  assert.deepEqual(await attemptsFor({ fixture: errorFixture('pools.catalogue_revision_changed') }), ['restart_required', 1], 'a restart belongs to the pager, once');
  // A 429 is asked again only once validated: the contract header, then a known code with its own status.
  assert.deepEqual(await attemptsFor({ ...busyReply('1'), transport: 'headerMissing' }), ['incompatible', 1]);
  assert.deepEqual(await attemptsFor({ ...busyReply('1'), mutate: () => ({ error: 'upstream_unavailable' }) }), ['invalid', 1], 'a 429 naming another code');
});

test('R-1: a 429 whose wait the read’s budget cannot cover is shown with that wait, not waited for', async () => {
  // 60 s asked for at the start of a 60 s read: nothing would be left of it.
  const clock = fakeClock();
  const long = await fixtures({ token: [busyReply('60'), tokenOk] }, { clock, policy: BRIDGE_RETRY }).read('token', tokenRequest);
  assert.deepEqual([long.state, long.retryAfterSeconds, long.provenance.attempts], ['busy', 60, 1]);
  assert.deepEqual(clock.delays, []);
  // 30 s, then 30 s more: the first wait fits, the second would end at the deadline.
  const halves = fakeClock();
  const late = await fixtures({ token: [busyReply('30'), busyReply('30'), tokenOk] }, { clock: halves, policy: BRIDGE_RETRY }).read('token', tokenRequest);
  assert.deepEqual([late.state, late.retryAfterSeconds, late.provenance.attempts], ['busy', 30, 2]);
  assert.deepEqual(halves.delays, [30_000]);
});

test('429 carries a bounded Retry-After', async () => {
  for (const [header, seconds] of [['7', 7], ['60', 60], ['61', 1], ['0', 1], ['1.5', 1], ['soon', 1], [undefined, 1]]) {
    const outcome = await one('token', errorFixture('token.read_capacity_busy'), { retryAfter: header }).read('token', tokenRequest);
    assert.deepEqual([outcome.state, outcome.retryAfterSeconds], ['busy', seconds], `Retry-After ${header}`);
  }
});

test('R-1: an abort during the Retry-After wait ends the read there', async () => {
  const controller = new AbortController();
  let waited = null;
  const waiting = {
    now: () => 0,
    monotonic: () => 0,
    random: () => 0,
    timer: () => () => undefined,
    sleep: (ms, signal) =>
      new Promise((_, reject) => {
        waited = ms;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
  const pending = fixtures({ token: [busyReply('5'), tokenOk] }, { clock: waiting, policy: BRIDGE_RETRY }).read('token', tokenRequest, { signal: controller.signal });
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(waited, 5000, 'waiting out the Retry-After');
  controller.abort();
  const outcome = await pending;
  assert.deepEqual([outcome.state, outcome.provenance.attempts], ['aborted', 1]);
});

test('the error table covers every producer code, consistently with its status', () => {
  assert.deepEqual(Object.keys(ERROR_CLASS).sort(), Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  for (const [code, rule] of Object.entries(ERROR_CLASS)) {
    const status = runtime.ERROR_STATUS_BY_CODE[code];
    if (rule.kind === 'restart') assert.ok([400, 409].includes(status), code);
    if (rule.kind === 'busy') assert.equal(status, 429, code);
    if (rule.kind === 'route_disabled') assert.equal(status, 404, code);
    if (rule.kind === 'request_rejected') assert.ok(status >= 400 && status < 500, code);
    if (rule.kind === 'incompatible' || rule.kind === 'unavailable') assert.ok(status >= 500, code);
    if (rule.kind === 'unavailable' && rule.retryable) assert.ok([503, 504].includes(status), `${code} is retried on ${status}`);
  }
  assert.equal(ERROR_CLASS.catalogue_database_unavailable.retryable, true, 'a database outage is transient (READ_CONTRACT_CANDIDATE_1_1.md)');
});

// ---------------------------------------------------------------------------
// The real bridge Worker in front of a fake gateway
// ---------------------------------------------------------------------------

const APP = 'https://app.test';
const BRIDGE_ENV = {
  APP_ORIGIN: APP,
  READ_BRIDGE_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://gateway.test',
  ENABLED_READS: ROUTES.join(','),
  ACCESS_CLIENT_ID: 'test-client',
  ACCESS_CLIENT_SECRET: 'test-secret',
};

/**
 * bridge/src/worker.mjs, unmodified, answering the adapter's requests. The
 * gateway behind it serves package fixtures; `answer` can replace any reply.
 */
/** The beta cookie plus Path=/ session and preauth cookies, as session-v1's bridge sets them. */
const BROWSER_COOKIES = '__Host-domino-beta=v1.beta; __Host-domino-session=sessiontoken; __Host-domino-preauth=preauthtoken';

function realBridge({ env = BRIDGE_ENV, answer } = {}) {
  const browser = [];
  const upstream = [];
  const worker = createWorker({
    getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => {
      const route = new URL(url).pathname.replace('/internal/read/v1/', '');
      const body = JSON.parse(init.body);
      upstream.push({ route, body, headers: new Headers(init.headers) });
      const custom = answer?.(route, body);
      const reply = custom ?? { status: 200, text: text(gateway(`${route === 'wallet-assets' ? 'wallet-assets.fallback' : route === 'pool-market' ? 'pool-market.success' : `${route}.success`}`)) };
      return new Response(reply.text, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...(reply.contract === null ? {} : { 'X-Domino-Read-Contract': reply.contract ?? RC3 }), ...(reply.headers ?? {}) },
      });
    },
  });
  const fetch = async (path, init) => {
    browser.push({ path, init });
    // What a browser adds on its own to a same-origin fetch.
    const headers = new Headers(init.headers);
    headers.set('Origin', APP);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('Sec-Fetch-Mode', 'cors');
    headers.set('Sec-Fetch-Dest', 'empty');
    // Every same-origin cookie whose Path covers the route, as a signed-in #14 session would have.
    headers.set('Cookie', BROWSER_COOKIES);
    return worker.fetch(new Request(new URL(path, APP), { method: init.method, headers, body: init.body, redirect: 'manual' }), env);
  };
  return { fetch, browser, upstream };
}

test('through the real bridge: a read is ok, with the bridge’s request id and contract', async () => {
  const bridge = realBridge();
  const source = createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock: fakeClock() });
  const outcome = await source.read('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: true });
  assert.equal(outcome.state, 'ok');
  assert.equal(outcome.provenance.transport, 'bridge');
  assert.equal(outcome.provenance.contract, RC3);
  // The Worker's own crypto.randomUUID(), exactly that shape.
  assert.match(outcome.provenance.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(bridge.browser.map((r) => [r.init.method, r.path]), [['GET', '/api/read/v1/capabilities'], ['POST', '/api/read/v1/pool-market']]);
  await source.read('token', tokenRequest);
  assert.equal(bridge.browser.filter((r) => r.init.method === 'GET').length, 1, 'capabilities are asked once');
});

test('a request id is kept in both shapes Domino writes: the gateway’s 32 hex through local-live, the Worker’s UUID', async () => {
  const GATEWAY_ID = 'c549ebea4bfca053878e1646dfe6cf7d';
  const WORKER_ID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  // Answers exactly as the local-live proxy passes a reply on: the contract header, and the id only when one is given.
  const answer = (id) => async (path) =>
    new Response(text(gateway(path.endsWith('/capabilities') ? 'capabilities.live_read_only' : 'token.success')), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Read-Contract': RC3, ...(id === null ? {} : { 'X-Domino-Request-Id': id }) },
    });
  for (const [id, kept] of [
    [GATEWAY_ID, GATEWAY_ID],
    [WORKER_ID, WORKER_ID],
    [GATEWAY_ID.toUpperCase(), undefined],
    [GATEWAY_ID.slice(1), undefined],
    [`${GATEWAY_ID}0`, undefined],
    ['-'.repeat(36), undefined],
    [WORKER_ID.toUpperCase(), undefined],
    ['arbitrary-upstream-value', undefined],
    [null, undefined],
  ]) {
    const outcome = await createBridgeSource({ enabled: true, validators: runtime, fetch: answer(id), clock: fakeClock() }).read('token', tokenRequest);
    assert.equal(outcome.state, 'ok', String(id));
    assert.equal(outcome.provenance.requestId, kept, String(id));
  }
  // A reply built by hand, as a fixture source or a test builds one, meets the same filter in the pipeline.
  const { runRead } = built('pipeline');
  const byHand = (requestIdHeader) =>
    runRead({
      route: 'token',
      request: tokenRequest,
      transport: async () => raw(200, 'application/json', text(gateway('token.success')), RC3, { requestIdHeader }),
      validators: runtime,
      policy: BRIDGE_RETRY,
      clock: fakeClock(),
      label: { transport: 'fixture' },
    });
  assert.equal((await byHand(GATEWAY_ID)).provenance.requestId, GATEWAY_ID);
  assert.equal((await byHand('x'.repeat(32))).provenance.requestId, undefined);
  const { requestIdOf } = built('requestId');
  assert.deepEqual([GATEWAY_ID, WORKER_ID, '-'.repeat(36), 'x'.repeat(32), '', null, undefined].map((value) => requestIdOf(value)), [GATEWAY_ID, WORKER_ID, null, null, null, null, null]);
});

test('request hygiene: same-origin JSON, three headers, no credentials of our own, and nothing sent for a bad request', async () => {
  const bridge = realBridge();
  const source = createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock: fakeClock() });
  await source.read('token', tokenRequest);
  const post = bridge.browser.find((r) => r.init.method === 'POST');
  assert.equal(post.path, '/api/read/v1/token', 'a relative, same-origin path from a fixed prefix');
  assert.deepEqual(Object.keys(post.init.headers).map((h) => h.toLowerCase()).sort(), ['accept', 'content-type', 'x-domino-read-contract']);
  assert.deepEqual(READ_HEADERS, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-Read-Contract': RC3 });
  for (const [key, value] of Object.entries(READ_INIT)) assert.equal(post.init[key], value, key);
  assert.deepEqual(READ_INIT, { mode: 'same-origin', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', referrerPolicy: 'same-origin' });
  assert.deepEqual(JSON.parse(post.init.body), tokenRequest);
  // The browser attached the session and preauth cookies; the gateway sees none of the browser's headers.
  assert.match(BROWSER_COOKIES, /__Host-domino-session=/);
  for (const name of ['cookie', 'authorization', 'origin', 'x-domino-csrf']) assert.equal(bridge.upstream[0].headers.has(name), false, name);
  for (const [name, value] of bridge.upstream[0].headers) assert.doesNotMatch(value, /sessiontoken|preauthtoken/, `the session credential reached the gateway in ${name}`);

  const before = bridge.browser.length;
  const bad = await source.read('token', { token: 'not-an-address' });
  assert.deepEqual([bad.state, bad.reason], ['invalid', 'request_contract']);
  assert.equal(bridge.browser.length, before, 'an invalid request is never sent');
});

test('through the real bridge: a gateway without the contract header surfaces as incompatible', async () => {
  const bridge = realBridge({ answer: () => ({ status: 200, text: text(gateway('token.success')), contract: null }) });
  const outcome = await createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock: fakeClock() }).read('token', tokenRequest);
  assert.deepEqual([outcome.state, outcome.reason], ['incompatible', 'upstream_contract_mismatch']);
});

test('through the real bridge: a 429 is asked again after its Retry-After; a 503 is shown and never asked again', async () => {
  const busy429 = { status: 429, text: '{"error":"read_capacity_busy"}', headers: { 'Retry-After': '9' } };
  let first = true;
  const once = realBridge({
    answer: (route) => {
      if (route !== 'token' || !first) return undefined;
      first = false;
      return busy429;
    },
  });
  const clock = fakeClock();
  const recovered = await createBridgeSource({ enabled: true, validators: runtime, fetch: once.fetch, clock }).read('token', tokenRequest);
  assert.deepEqual([recovered.state, recovered.provenance.attempts], ['ok', 2]);
  assert.deepEqual(clock.delays, [9000], 'the Retry-After the Worker passed on');
  assert.equal(once.upstream.length, 2);

  const always = realBridge({ answer: (route) => (route === 'token' ? busy429 : undefined) });
  const shown = await createBridgeSource({ enabled: true, validators: runtime, fetch: always.fetch, clock: fakeClock() }).read('token', tokenRequest);
  assert.deepEqual([shown.state, shown.retryAfterSeconds, shown.provenance.attempts], ['busy', 9, 3]);
  assert.equal(always.upstream.length, 3, 'three attempts in all');

  const down = realBridge({ answer: (route) => (route === 'token' ? { status: 503, text: '{"error":"upstream_unavailable"}' } : undefined) });
  const unavailable = await createBridgeSource({ enabled: true, validators: runtime, fetch: down.fetch, clock: fakeClock() }).read('token', tokenRequest);
  assert.deepEqual([unavailable.state, unavailable.cause.code, unavailable.retryable, unavailable.provenance.attempts], ['unavailable', 'upstream_unavailable', true, 1]);
  assert.equal(down.upstream.length, 1, 'the 503 reached the gateway once');
});

test('the bridge’s capabilities gate every POST: disabled data mode and unlisted routes send nothing', async () => {
  const off = realBridge({ env: { ...BRIDGE_ENV, READ_BRIDGE_ENABLED: 'false' } });
  const source = createBridgeSource({ enabled: true, validators: runtime, fetch: off.fetch, clock: fakeClock() });
  const disabled = await source.read('token', tokenRequest);
  assert.deepEqual([disabled.state, disabled.reason], ['disabled', 'bridge_data_mode_disabled']);
  assert.equal(off.browser.filter((r) => r.init.method === 'POST').length, 0);

  const partial = realBridge({ env: { ...BRIDGE_ENV, ENABLED_READS: 'token,pools' } });
  const limited = createBridgeSource({ enabled: true, validators: runtime, fetch: partial.fetch, clock: fakeClock() });
  const unlisted = await limited.read('pool-metrics', { poolId: FIXTURE_POOL });
  assert.deepEqual([unlisted.state, unlisted.reason], ['disabled', 'route_not_enabled']);
  assert.equal(partial.browser.filter((r) => r.init.method === 'POST').length, 0);
});

test('a disabled bridge source makes no request at all', async () => {
  let calls = 0;
  const source = createBridgeSource({ enabled: false, validators: runtime, fetch: async () => (calls++, new Response('{}')) });
  for (const route of ROUTES) {
    const outcome = await source.read(route, requestFor(catalog, route));
    assert.deepEqual([outcome.state, outcome.reason], ['disabled', 'live_data_disabled'], route);
  }
  assert.equal(calls, 0);
});

test('through the real bridge: the wallet cursor goes back byte for byte and never into a view', async () => {
  const pageOne = JSON.stringify(scenarios.withCursor(MUTATED_CURSOR)(JSON.parse(text(gateway('wallet-assets.opaque-page')))));
  const bridge = realBridge({
    answer: (route, body) => {
      if (route !== 'wallet-assets') return undefined;
      return { status: 200, text: body.cursor ? text(gateway('wallet-assets.last-page')) : pageOne };
    },
  });
  const source = createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock: fakeClock() });
  const pager = pagers.createWalletPager(source, requestFor(catalog, 'wallet-assets'));
  const first = await pager.first();
  assert.equal(first.view.hasMore, true);
  assert.doesNotMatch(JSON.stringify(first.view), /c0ffee/, 'the handle is not in the view model');
  const second = await pager.more();
  assert.equal(second.failure, null);
  assert.equal(bridge.upstream.at(-1).body.cursor, MUTATED_CURSOR, 'the gateway received the exact handle');
  assert.deepEqual(Object.keys(second.view).sort(), ['freshness', 'hasMore', 'inventoryAvailable', 'notes', 'pages', 'probed', 'restarted', 'rows', 'skipped', 'skippedReason', 'unavailable']);
  assert.equal(second.view.hasMore, false);
  assert.doesNotMatch(JSON.stringify(second.view), /c0ffee/);
});

// ---------------------------------------------------------------------------
// R3: raw amounts, identity, opaque pagination, provenance
// ---------------------------------------------------------------------------

test('raw amounts survive as the same strings, and units are exact', async () => {
  const amount = '57896044618658097711785492504343953926634992332820282019728792003956564820091';
  const outcome = await one('wallet-assets', gateway('wallet-assets.fallback')).read('wallet-assets', requestFor(catalog, 'wallet-assets'));
  assert.equal(outcome.data.items[1].amountRaw, amount);
  assert.equal(typeof outcome.data.items[1].amountRaw, 'string');
  const scale = 10n ** 6n;
  const whole = (BigInt(amount) / scale).toLocaleString('en-US');
  const fraction = (BigInt(amount) % scale).toString().padStart(6, '0').replace(/0+$/, '');
  assert.deepEqual(decimal.formatUnits(amount, 6), { kind: 'units', text: `${whole}.${fraction}` });
  assert.deepEqual(decimal.formatUnits(amount, null), { kind: 'raw', text: BigInt(amount).toLocaleString('en-US') });
  assert.deepEqual(decimal.formatUnits('42', 0), { kind: 'units', text: '42' });
  assert.deepEqual(decimal.formatUnits('0', 18), { kind: 'units', text: '0' });
  assert.deepEqual(decimal.formatUnits('1000000', 6), { kind: 'units', text: '1' });
  assert.equal(decimal.formatUnits('-1', 6), null);
  assert.equal(decimal.formatUnits('1e3', 6), null);

  const step = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.partial-metadata')), requestFor(catalog, 'wallet-assets')).first();
  const token = step.view.rows.find((row) => row.key === `4663:${FIXTURE_TOKEN}`);
  assert.equal(token.amount.state, 'raw', 'decimals unknown: shown raw, labelled raw');
  assert.match(token.amount.text, /raw units, decimals unknown/);
  const zero = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.zero')), requestFor(catalog, 'wallet-assets')).first();
  assert.deepEqual(zero.view.rows.map((row) => [row.amount.text, row.amount.state]), [['0', 'zero'], ['0', 'zero']]);
});

test('decimal strings format without Number: compact USD, sub-cent, half-even, exact ratios', () => {
  assert.equal(decimal.formatUsdCompact('12345.670000000000000001'), '$12.3K');
  assert.equal(decimal.formatUsdCompact('0.000020026865830513'), '$0.000020', 'a positive sub-cent amount keeps six places, as format.ts does');
  assert.equal(decimal.formatUsdCompact('0'), '$0.00');
  assert.equal(decimal.formatUsdCompact('0.000000086712877937'), '<$0.000001', 'a real fee too small for six places is not zero');
  assert.equal(decimal.formatUsdCompact('10.00'), '$10.00');
  assert.equal(decimal.formatUsdCompact('1234.56'), '$1.2K');
  assert.equal(decimal.formatUsdCompact('999.999'), '$1,000.00');
  // Changed on purpose 2026-10-01 (audit E8): rounded first, then sized, so a unit's edge reads as the next unit.
  assert.equal(decimal.formatUsdCompact('999950'), '$1.0M', 'not $1000.0K');
  assert.equal(decimal.formatUsdCompact('999949'), '$999.9K');
  assert.equal(decimal.formatUsdCompact('999950000'), '$1.00B', 'not $1000.0M');
  assert.equal(decimal.formatUsdCompact('10450000'), '$10.4M', 'half to even at the tie');
  assert.equal(decimal.formatUsdCompact('10550000'), '$10.6M');
  assert.equal(decimal.formatUsdCompact('1e6'), null);
  assert.equal(decimal.toFixed('158.060469175186043958', 2), '158.06');
  assert.equal(decimal.ratio('1', '3', 4), '0.3333');
  assert.equal(decimal.ratio('1', '0', 4), null);
  assert.equal(decimal.ratio('2', '0.000000000000000001', 0), '2000000000000000000');
  const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  assert.equal(decimal.compare(big, `${big.slice(0, -1)}4`), 1, 'uint256 compares exactly');
});

test('no Number, parseFloat or parseInt on the amount paths', () => {
  for (const file of ['lib/read/decimal.ts', 'lib/read/project.ts', 'lib/read/pagers.ts', 'lib/markets.ts']) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.doesNotMatch(source, /\bNumber\(|parseFloat|parseInt/, `${file} converts a value to a JS number`);
  }
});

test('identity is chain plus address or pool id, never a symbol', async () => {
  // Two different tokens that both call themselves TOKEN stay two rows.
  const twins = one('wallet-assets', gateway('wallet-assets.fallback'), { mutate: (b) => ((b.items[0].symbol = 'TOKEN'), b) });
  const step = await pagers.createWalletPager(twins, requestFor(catalog, 'wallet-assets')).first();
  assert.deepEqual(step.view.rows.map((row) => row.key), [`4663:${NATIVE}`, `4663:${FIXTURE_TOKEN}`]);
  assert.deepEqual(step.view.rows.map((row) => row.token.symbol), ['TOKEN', 'TOKEN']);

  const loaded = await loadSelectedPools(fixtures(scenarios.MARKET_CASES.find((c) => c.id === 'provider').script), [FIXTURE_POOL]);
  const [row] = loaded.rows;
  assert.equal(row.key, `4663:${FIXTURE_POOL}`);
  assert.equal(row.tokens.base.address, NATIVE);
  assert.equal(row.tokens.base.artwork, 'ETH', 'artwork chosen by address');
  assert.equal(row.tokens.quote.artwork, null, 'a symbol never selects artwork');
  const hostile = await loadSelectedPools(fixtures(scenarios.MARKET_CASES.find((c) => c.id === 'untrusted-symbol').script), [FIXTURE_POOL]);
  assert.equal(hostile.rows[0].tokens.quote.symbol, '<img src=x onerror=alert(1)>', 'kept as text, verbatim');
  assert.equal(hostile.rows[0].tokens.quote.artwork, null);
});

test('bundled token artwork follows documented addresses, not claimed symbols', () => {
  for (const [address, artwork] of [
    ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH'],
    ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG'],
    ['0xab35d04e1ee39c789c4a65d522417b3c7f2e4723', 'MARLIN'],
  ]) {
    assert.equal(project.unreadToken(address.toUpperCase()).artwork, artwork);
    assert.equal(project.tokenDisplay({ address, symbol: 'A DIFFERENT NAME', decimals: null, readStatus: 'unavailable' }).artwork, artwork);
  }
  assert.equal(project.tokenDisplay({ address: FIXTURE_TOKEN, symbol: 'MARLIN', decimals: null, readStatus: 'unavailable' }).artwork, null);
});

test('pagination: the handle is minted from the page and passed back verbatim; restart happens once', async () => {
  const cases = scenarios.familyCases(catalog);
  const pagesCase = cases.find((c) => c.id === 'wallet-assets.pages');
  const source = fixtures(pagesCase.script);
  const pager = pagers.createWalletPager(source, pagesCase.request);
  const first = await pager.first();
  assert.equal(first.view.hasMore, true);
  const second = await pager.more();
  assert.equal(second.failure, null, 'page two answered: the cursor matched the fixture’s expectation exactly');
  assert.equal(source.requests[1].request.cursor, MUTATED_CURSOR);
  assert.equal(second.view.pages, 2);
  assert.equal(second.view.hasMore, false);
  assert.ok(second.view.rows.every((row) => typeof row.pageRetrievedAt === 'number'), 'each row keeps its page time');

  const expired = cases.find((c) => c.id === 'wallet-assets.cursor-expired');
  const restartSource = fixtures(expired.script);
  const restarting = pagers.createWalletPager(restartSource, expired.request);
  await restarting.first();
  const restarted = await restarting.more();
  assert.equal(restarted.failure, null);
  assert.equal(restarted.view.restarted, true);
  assert.equal(restarted.view.pages, 1);
  assert.deepEqual(restartSource.requests.map((r) => r.request.cursor), [undefined, MUTATED_CURSOR, undefined]);
  const again = await restarting.more();
  assert.equal(again.failure?.state, 'restart_required', 'a second expiry is shown, not restarted again');

  const cataloguePages = cases.find((c) => c.id === 'catalogue.pages');
  const catSource = fixtures(cataloguePages.script);
  const catalogue = pagers.createCataloguePager(catSource, cataloguePages.request);
  assert.equal((await catalogue.first()).view.hasMore, true);
  const next = await catalogue.more();
  assert.equal(next.failure, null);
  assert.deepEqual([catSource.requests[1].request.afterPoolId, catSource.requests[1].request.revision], [FIXTURE_POOL, 2]);

  const changed = cases.find((c) => c.id === 'catalogue.revision-changed');
  const changedSource = fixtures(changed.script);
  const changedPager = pagers.createCataloguePager(changedSource, changed.request);
  await changedPager.first();
  const afterChange = await changedPager.more();
  assert.equal(afterChange.view.restarted, true);
  const restartRequest = changedSource.requests[2].request;
  assert.equal('afterPoolId' in restartRequest || 'revision' in restartRequest, false, 'restart drops the old position and revision');

  const pools = cases.find((c) => c.id === 'pools.revision-changed');
  const poolsResult = await pagers.readRestartingOnce(fixtures(pools.script), 'pools', pools.request);
  assert.deepEqual([poolsResult.outcome.state, poolsResult.restarted], ['ok', true]);
});

// ---------------------------------------------------------------------------
// wallet-assets partial pages (2cb559e): candidatesProbed, candidatesSkipped, skippedReason
// ---------------------------------------------------------------------------

/** An InventoryPage that probed some provider candidates and skipped others. */
const skippedPage = (skipped, probed = 13, reason = 'request_budget_exhausted') => (body) => ({
  ...body,
  inventory: { ...body.inventory, candidatesProbed: probed, candidatesSkipped: skipped, skippedReason: skipped > 0 ? reason : null },
});
const WALLET_REQUEST = () => requestFor(catalog, 'wallet-assets');
const ALL_LOADED = 'All pages loaded.';

test('a page that skipped candidates is counted, never called complete; an older producer counts as none', async () => {
  const partial = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.last-page'), { mutate: skippedPage(7) }), WALLET_REQUEST()).first();
  assert.equal(partial.failure, null);
  assert.deepEqual([partial.view.skipped, partial.view.skippedReason, partial.view.probed, partial.view.hasMore], [7, 'request_budget_exhausted', 13, false]);
  assert.ok(!partial.view.notes.includes(ALL_LOADED), 'a list that skipped candidates is not complete, and no sentence says it is');
  assert.deepEqual(partial.view.notes, ['Balances read from the chain at one block. Anyone can see them; they don’t prove who controls the wallet.'], 'and nothing is said in its place');

  const whole = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.last-page')), WALLET_REQUEST()).first();
  assert.deepEqual([whole.view.skipped, whole.view.skippedReason, whole.view.probed], [0, null, 0]);
  // Changed on purpose (review of 2026-09-14, live step e): a provider page covers only what the provider indexes, so even a last page that skipped nothing is not called complete.
  assert.ok(!whole.view.notes.includes(ALL_LOADED), 'a last page ends the pages, never the holdings');

  const older = await pagers.createWalletPager(
    one('wallet-assets', gateway('wallet-assets.last-page'), {
      mutate: (body) => {
        const { candidatesProbed: _p, candidatesSkipped: _s, skippedReason: _r, ...inventory } = body.inventory;
        return { ...body, inventory };
      },
    }),
    WALLET_REQUEST(),
  ).first();
  assert.equal(older.failure, null, 'the fields are optional in the contract');
  assert.deepEqual([older.view.skipped, older.view.skippedReason, older.view.probed], [0, null, null], 'absent: none skipped, and nothing claimed about how many were checked');
  const nulls = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.last-page'), { mutate: (b) => ({ ...b, inventory: { ...b.inventory, candidatesProbed: null, candidatesSkipped: null, skippedReason: null } }) }), WALLET_REQUEST()).first();
  assert.deepEqual([nulls.view.skipped, nulls.view.probed], [0, null]);

  // The contract bounds the count at a provider page's 20: more is a reply that fails validation, and nothing is listed.
  const beyond = await one('wallet-assets', gateway('wallet-assets.last-page'), { mutate: skippedPage(21) }).read('wallet-assets', WALLET_REQUEST());
  assert.deepEqual([beyond.state, beyond.reason], ['invalid', 'response_contract']);
  // A page with more to come never said it was complete anyway.
  const more = await pagers.createWalletPager(one('wallet-assets', gateway('wallet-assets.opaque-page'), { mutate: skippedPage(3) }), WALLET_REQUEST()).first();
  assert.deepEqual([more.view.skipped, more.view.hasMore], [3, true]);
  assert.ok(more.view.notes.includes('One page of the provider’s inventory. More are available.'));
});

test('no provider page calls the list complete: not a page of no provider rows, not a last page of rows', async () => {
  const FOOTNOTE = 'Balances read from the chain at one block. Anyone can see them; they don’t prove who controls the wallet.';
  // The live review's address (a PoolManager holding a pool's reserves): the provider returned no rows, and the reply listed native ETH at 0.
  const nothing = await pagers.createWalletPager(
    one('wallet-assets', gateway('wallet-assets.last-page'), {
      mutate: (body) => ({ ...body, items: [{ ...body.items[0], amountRaw: '0' }], inventory: { ...body.inventory, hasMore: false, nextCursor: null, rowsReceived: 0, candidatesProbed: 0, candidatesSkipped: 0, skippedReason: null } }),
    }),
    { wallet: `0x${'83'.repeat(20)}`, autoDiscover: true },
  ).first();
  assert.equal(nothing.failure, null);
  assert.deepEqual(nothing.view.rows.map((row) => [row.key, row.amount.state]), [[`4663:${NATIVE}`, 'zero']]);
  assert.deepEqual(nothing.view.notes, [FOOTNOTE], 'a page of no provider rows says nothing about what the address holds, and nothing says the list is whole');
  const rows = await pagers.createWalletPager(
    one('wallet-assets', gateway('wallet-assets.last-page'), { mutate: (body) => ({ ...body, inventory: { ...body.inventory, rowsReceived: 1, candidatesProbed: 1 } }) }),
    WALLET_REQUEST(),
  ).first();
  assert.deepEqual([rows.view.hasMore, rows.view.skipped], [false, 0]);
  assert.deepEqual(rows.view.notes, [FOOTNOTE], 'a last page of rows ends the pages, and that is all it ends');
});

test('skipped candidates add up over a list’s pages, and count again from a restarted first page', async () => {
  const request = WALLET_REQUEST();
  const firstPage = { fixture: gateway('wallet-assets.opaque-page'), mutate: (b) => skippedPage(2, 11)(scenarios.withCursor(MUTATED_CURSOR)(b)), expectRequest: request };
  const source = fixtures({ 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.last-page'), mutate: skippedPage(3, 17), expectRequest: { ...request, cursor: MUTATED_CURSOR } }] });
  const pager = pagers.createWalletPager(source, request);
  assert.equal((await pager.first()).view.skipped, 2);
  const second = await pager.more();
  assert.equal(second.failure, null);
  assert.deepEqual([second.view.skipped, second.view.probed, second.view.pages], [5, 28, 2]);
  assert.ok(!second.view.notes.includes(ALL_LOADED), 'the last page of a list that skipped candidates on any page is not a complete list');

  const restartSource = fixtures({
    'wallet-assets': [firstPage, { fixture: errorFixture('wallet-assets.invalid_or_expired_cursor'), expectRequest: { ...request, cursor: MUTATED_CURSOR } }],
  });
  const restarting = pagers.createWalletPager(restartSource, request);
  assert.equal((await restarting.first()).view.skipped, 2);
  const restarted = await restarting.more();
  assert.equal(restarted.failure, null);
  assert.equal(restarted.view.restarted, true);
  assert.deepEqual([restarted.view.pages, restarted.view.skipped, restarted.view.probed], [1, 2, 11], 'the restart’s first page counts from zero, not on top of the old list');
});

test('adopt() adds only the held balances a by-address check found for what it asked, and changes nothing else of the list', async () => {
  const request = WALLET_REQUEST();
  const HELD = `0x${'ab'.repeat(20)}`;
  const ZERO_HOLD = `0x${'34'.repeat(20)}`;
  const NOT_ASKED = `0x${'56'.repeat(20)}`;
  const listSource = fixtures({
    'wallet-assets': [
      { fixture: gateway('wallet-assets.opaque-page'), mutate: scenarios.withCursor(MUTATED_CURSOR), expectRequest: request },
      // The next page lists the token the check found.
      { fixture: gateway('wallet-assets.last-page'), mutate: (body) => (body.items.push({ ...body.items[1], address: HELD }), body), expectRequest: { ...request, cursor: MUTATED_CURSOR } },
    ],
  });
  const listed = pagers.createWalletPager(listSource, request);
  const before = (await listed.first()).view;
  assert.ok(before.rows.every((row) => row.via === 'page' && row.block === 700), 'a page’s rows say they came from a page, at its block');

  const checkSource = one('wallet-assets', gateway('wallet-assets.not-requested'), {
    mutate: (body) => {
      const held = body.items[1];
      body.snapshot = { ...body.snapshot, number: 705 };
      body.items = [body.items[0], held, { ...held, address: HELD }, { ...held, address: ZERO_HOLD, amountRaw: '0' }, { ...held, address: NOT_ASKED }];
      return body;
    },
  });
  const check = await checkSource.read('wallet-assets', { wallet: request.wallet, tokens: [HELD, ZERO_HOLD], autoDiscover: false });
  assert.equal(check.state, 'ok');
  const after = listed.adopt(check, [`0x${'AB'.repeat(20)}`, ZERO_HOLD]);
  const added = after.rows.filter((row) => !before.rows.some((b) => b.key === row.key));
  assert.deepEqual(added.map((row) => [row.key, row.via, row.block, row.amount.state]), [[`4663:${HELD}`, 'address', 705, 'value']], 'only the held, asked-for token; an address asked in capitals is the same address');
  assert.equal(after.rows.find((row) => row.key === `4663:${NATIVE}`).via, 'page', 'native ETH from the check adds nothing');
  for (const key of ['hasMore', 'notes', 'freshness', 'pages', 'unavailable', 'skipped', 'skippedReason', 'probed', 'restarted']) {
    assert.deepEqual(after[key], before[key], `${key} is the list’s own`);
  }
  // A token a page already listed stays the page's.
  assert.equal(listed.adopt(check, [`0x${'11'.repeat(20)}`]).rows.find((row) => row.key === `4663:0x${'11'.repeat(20)}`).via, 'page');

  // The handle was never touched: the next page follows it, and its row for the same token replaces the adopted one.
  const next = await listed.more();
  assert.equal(next.failure, null, 'the cursor went back exactly as received');
  assert.equal(listSource.requests[1].request.cursor, MUTATED_CURSOR);
  const paged = next.view.rows.find((row) => row.key === `4663:${HELD}`);
  assert.deepEqual([paged.via, paged.page, paged.block], ['page', 2, 700]);
});

// ---------------------------------------------------------------------------
// R4: what each observation may become on screen
// ---------------------------------------------------------------------------

/**
 * A row projected from pool-market, pool-metrics and token reads, the way a
 * table that read metrics would build it. The lean table never does; these
 * keep projectMarketRow's qualification rules under test.
 */
async function row(id) {
  const scenario = scenarios.PROJECTION_CASES.find((c) => c.id === id);
  const source = fixtures({ 'pool-market': [scenario.market], 'pool-metrics': [scenario.metrics], token: scenarios.projectionTokens(scenario.token) }, { clock: fakeClock() });
  const market = await source.read('pool-market', tableMarketRequest(FIXTURE_POOL));
  assert.equal(market.state, 'ok', `${id}: pool-market ${market.state}`);
  const metrics = await source.read('pool-metrics', { poolId: FIXTURE_POOL });
  const tokens = new Map();
  for (const currency of market.data.pool.currencies) tokens.set(currency.toLowerCase(), await source.read('token', { token: currency }));
  return { metrics, market: project.projectMarketRow({ market, metrics, tokens }) };
}
/** A row of the lean table: pool-market and tokens only, through the loader the app uses. */
async function leanRow(id) {
  const scenario = scenarios.MARKET_CASES.find((c) => c.id === id);
  const loaded = await loadSelectedPools(fixtures(scenario.script, { policy: scenario.policy, clock: fakeClock() }), scenario.poolIds ?? [FIXTURE_POOL]);
  return { ...loaded, market: loaded.rows[0] };
}
const states = (m) => [m.tvlUsd.state, m.volume24hUsd.state, m.feeAprPercent.state];

test('the lean table: provider figures named with their age, the APR not provided, and nothing from pool-metrics', async () => {
  const { market, problems } = await leanRow('provider');
  assert.deepEqual(problems, []);
  assert.deepEqual(states(market), ['provider', 'provider', 'unavailable']);
  assert.deepEqual([market.feeAprPercent.value, market.feeAprPercent.reason], [null, 'fee_apr_not_provided']);
  assert.equal(reasonText('fee_apr_not_provided'), 'no qualified fee APR');
  assert.equal(markets.aprLabel(market.feeAprPercent).kind, 'unavailable', 'never 0, never an estimate');
  assert.deepEqual([market.tvlUsd.source, market.tvlUsd.asOf, market.volume24hUsd.source], ['GeckoTerminal', 1010, 'GeckoTerminal']);
  assert.equal(market.provenance.metrics, 'not_requested');
  const { receivedAt, receivedMonotonic, ...observed } = market.provenance.market;
  assert.deepEqual(observed, { status: 'available', reason: null, cacheAgeSeconds: 0, freshForSeconds: 60 });
  assert.equal(typeof receivedAt, 'number', 'dated by when its answer arrived, to count the retrieval age on');
  assert.equal(typeof receivedMonotonic, 'number', 'and on the monotonic clock, which no wall-clock step moves');
  assert.equal('volume30dUsd' in market, false, 'no column for a figure read-v1 does not carry');
  const stale = (await leanRow('stale')).market;
  assert.deepEqual(states(stale), ['stale', 'stale', 'unavailable'], 'stale provider figures, and no stale APR from anywhere');
});

test('#93: a provider figure is dated only by its retrieval age, counted on from the answer, and turns stale past the fresh window', () => {
  const observed = { status: 'available', reason: null, cacheAgeSeconds: 12, freshForSeconds: 60, receivedAt: 1_000_000 };
  assert.equal(markets.retrievedAgeSeconds(observed, 1_000_000), 12);
  assert.equal(markets.retrievedAgeSeconds(observed, 1_005_900), 17);
  assert.equal(markets.retrievedAgeSeconds(observed, 999_000), 12, 'a clock that steps back never makes it younger');
  assert.equal(markets.retrievedAgeSeconds({ ...observed, cacheAgeSeconds: null }, 1_005_900), null, 'an unknown age stays unknown');
  assert.equal(markets.retrievedText(12), 'retrieved 12 s ago');
  assert.equal(markets.retrievedText(150), 'retrieved 2 min ago');
  // 2026-10-01 (audit E8): hours from two hours.
  assert.equal(markets.retrievedText(7_199), 'retrieved 119 min ago');
  assert.equal(markets.retrievedText(82_800), 'retrieved 23 h ago');
  assert.equal(markets.retrievedText(null), 'retrieval time unknown');
  for (const age of [0, 12, 150, null]) assert.doesNotMatch(markets.retrievedText(age), /as of|updated/i);
  assert.equal(markets.providerStale(observed, 1_048_000), false, '60 s after retrieval: still fresh');
  assert.equal(markets.providerStale(observed, 1_049_000), true, '61 s after retrieval: stale on screen');
  assert.equal(markets.providerStale({ ...observed, status: 'stale' }, 1_000_000), true, 'the read service said stale');
  assert.equal(markets.providerStale({ ...observed, status: 'unavailable', cacheAgeSeconds: 301 }, 1_000_000), false, 'no figures, nothing to mark');
  // No reported age: the time since the answer arrived is a lower bound on it. The figures still turn
  // stale once they have been on screen past the fresh window, and their retrieval time stays unknown.
  const unknown = { ...observed, cacheAgeSeconds: null };
  assert.equal(markets.retrievedText(markets.retrievedAgeSeconds(unknown, 1_061_000)), 'retrieval time unknown', 'no age is invented');
  assert.equal(markets.providerStale(unknown, 1_060_000), false, 'on screen for 60 s: not yet past the fresh window');
  assert.equal(markets.providerStale(unknown, 1_061_000), true, 'on screen for 61 s: at least 61 s old, so stale');
  assert.equal(markets.providerStale(unknown, 999_000), false, 'a clock that steps back makes it no younger than when it arrived');
  assert.equal(markets.providerStale({ ...unknown, status: 'stale' }, 1_000_000), true, 'the read service said stale');
});

test('#93: time on screen is counted on the monotonic clock when the answer was stamped on it, whatever the wall clock does', () => {
  const unknown = { status: 'available', reason: null, cacheAgeSeconds: null, freshForSeconds: 60, receivedAt: 1_000_000, receivedMonotonic: 5_000 };
  assert.equal(markets.providerStale(unknown, { wall: 900_000, monotonic: 66_000 }), true, 'the wall clock stepped back: 61 s on screen all the same');
  assert.equal(markets.providerStale(unknown, { wall: 9_000_000, monotonic: 65_000 }), false, 'the wall clock stepped forward: still only 60 s on screen');
  const reported = { ...unknown, cacheAgeSeconds: 12 };
  assert.equal(markets.retrievedAgeSeconds(reported, { wall: 0, monotonic: 10_900 }), 17, 'the reported age, plus the time on screen');
  assert.equal(markets.retrievedAgeSeconds(reported, 1_005_900), 17, 'a wall reading alone counts on the wall clock');
  assert.equal(markets.retrievedAgeSeconds({ ...reported, receivedMonotonic: undefined }, { wall: 1_005_900, monotonic: 10_900 }), 17, 'an answer never stamped on it falls back to the wall clock');
});

test('#93: the pair comes from the pool’s own currencies and their token reads, never the provider’s base/quote, and sourceUrl is never carried', async () => {
  const { readFileSync } = require('node:fs');
  const wire = JSON.parse(readFileSync(new URL('../../api-contracts/read-v1/fixtures/gateway/pool-market.success.json', import.meta.url), 'utf8'));
  // The provider reports this pool the other way round: base is currency1.
  assert.deepEqual([wire.market.data.baseToken, wire.market.data.quoteToken], [wire.pool.currencies[1], wire.pool.currencies[0]]);
  assert.match(wire.market.data.sourceUrl, /^https:\/\/api\.geckoterminal\.com\//);
  const { market } = await leanRow('provider');
  assert.deepEqual([market.tokens.base.address, market.tokens.quote.address], wire.pool.currencies, 'currency0/currency1, as the verified pool has them');
  assert.doesNotMatch(JSON.stringify(market), /geckoterminal\.com|sourceUrl/, 'the provider URL never reaches a row');
});

test('#93: a rejected or unavailable provider observation keeps the verified row, with its figures unavailable, never zero', async () => {
  for (const [id, state] of [['rejected-currencies', 'rejected'], ['rejected-dex', 'rejected'], ['timeout', 'unavailable'], ['rate-limited', 'unavailable'], ['expired', 'unavailable']]) {
    const { rows, problems, market } = await leanRow(id);
    assert.deepEqual([rows.length, problems.length], [1, 0], `${id}: the verified pool keeps its row`);
    assert.deepEqual(states(market), [state, state, 'unavailable'], id);
    for (const metric of [market.tvlUsd, market.volume24hUsd]) {
      assert.equal(metric.value, null, `${id}: no retained value`);
      assert.equal(markets.presentMetric(metric).kind, 'unavailable', id);
    }
    assert.equal(markets.turnover(market).kind, 'unavailable', id);
    assert.equal(market.provenance.market.status, state === 'rejected' ? 'rejected' : 'unavailable', id);
    assert.ok(market.provenance.market.reason, `${id}: the reason travels with the row`);
  }
  // Reported as null inside a usable observation: not reported, not $0.
  const { market } = await leanRow('missing');
  assert.deepEqual([market.tvlUsd.value, market.tvlUsd.state, market.volume24hUsd.value, market.volume24hUsd.state], [null, 'absent', null, 'absent']);
  assert.equal(markets.presentMetric(market.tvlUsd).kind, 'absent');
  assert.equal(markets.turnover(market).kind, 'unavailable');
});

test('qualified pool-metrics is the only current 24h and APR figure', async () => {
  const { market } = await row('qualified');
  assert.deepEqual(states(market), ['qualified', 'qualified', 'qualified']);
  assert.equal(market.tvlUsd.value, '0.000020026865830513', 'point-in-time TVL, not the time-weighted APR basis');
  assert.equal(market.feeAprPercent.value, '158.060469175186043958');

  // Changed on purpose 2026-10-01 (audit E21): one APR rule (lib/format/apr.ts): whole percents from 100%.
  assert.equal(markets.aprLabel(market.feeAprPercent).text, '158% APR');
  assert.equal(markets.presentMetric(market.tvlUsd).text, '$0.000020');
  assert.equal(markets.turnover(market).kind, 'value');
});

test('provider figures are named and never qualified; a provider zero is a zero', async () => {
  const provider = (await row('provider')).market;
  assert.deepEqual(states(provider), ['provider', 'provider', 'unavailable']);
  assert.deepEqual([provider.tvlUsd.value, provider.tvlUsd.source, provider.tvlUsd.asOf], ['12345.670000000000000001', 'GeckoTerminal', 1010]);
  assert.equal(provider.feeAprPercent.reason, 'qualified_usd_prices_required');
  const shown = markets.presentMetric(provider.tvlUsd);
  assert.deepEqual([shown.kind, shown.text, shown.source, shown.stale], ['value', '$12.3K', 'GeckoTerminal', false]);
  const turn = markets.turnover(provider);
  assert.deepEqual([turn.text, turn.calculatedFrom, 'source' in turn], ['0.00', 'GeckoTerminal', false], 'a measured zero volume is 0.00, calculated from GeckoTerminal figures');

  const zero = (await row('zero')).market;
  assert.deepEqual([zero.tvlUsd.value, zero.volume24hUsd.value], ['0', '0']);
  assert.equal(markets.presentMetric(zero.tvlUsd).text, '$0.00');
  assert.equal(markets.turnover(zero).kind, 'unavailable', 'zero TVL has no turnover');

  const missing = (await row('missing')).market;
  assert.deepEqual(states(missing).slice(0, 2), ['absent', 'absent']);
  assert.equal(markets.presentMetric(missing.tvlUsd).kind, 'absent');
  assert.equal(markets.turnover(missing).kind, 'unavailable');
});

test('an expired cache with a retained age is unavailable; age alone proves nothing', async () => {
  const outcome = await one('pool-market', gateway('pool-market.expired')).read('pool-market', requestFor(catalog, 'pool-market'));
  assert.deepEqual([outcome.data.market.status, outcome.data.market.cache.ageSeconds, outcome.data.market.data], ['unavailable', 301, null]);
  const { market } = await row('expired');
  assert.deepEqual([market.tvlUsd.state, market.tvlUsd.value, market.tvlUsd.reason], ['unavailable', null, 'provider_unavailable']);
  const view = project.projectPoolMarket(outcome.data);
  const liquidity = view.facts.find((f) => f.label === 'Liquidity');
  assert.deepEqual([liquidity.text, liquidity.state], ['Unavailable', 'unavailable']);
  assert.match(view.facts.find((f) => f.label === 'Provider cache').text, /301 s \(not a usable observation\)/);
});

test('both identity-rejection paths are never displayed', async () => {
  const service = (await row('rejected-currencies')).market;
  assert.deepEqual([service.tvlUsd.state, service.tvlUsd.value, service.tvlUsd.reason], ['rejected', null, 'provider_currency_or_pool_mismatch']);
  assert.deepEqual(markets.presentMetric(service.tvlUsd), { kind: 'unavailable', reason: 'provider_currency_or_pool_mismatch', rejected: true });
  const dex = (await row('rejected-dex')).market;
  assert.equal(dex.volume24hUsd.state, 'rejected');
  // Inside the provider adapter an identity failure is sanitised to unavailable / provider_unavailable.
  const adapter = (await row('timeout')).market;
  assert.deepEqual([adapter.tvlUsd.state, adapter.tvlUsd.reason], ['unavailable', 'provider_unavailable']);
  const limited = (await row('rate-limited')).market;
  assert.deepEqual([limited.tvlUsd.state, limited.tvlUsd.reason], ['unavailable', 'provider_rate_limited']);
});

test('reference analytics and partial windows are never current, and never a cell value', async () => {
  const reference = (await row('reference')).market;
  assert.deepEqual(states(reference), ['reference', 'reference', 'reference']);
  assert.equal(reference.feeAprPercent.value, '158.060469175186043958', 'the value is kept in the model');
  const shown = markets.presentMetric(reference.feeAprPercent);
  assert.deepEqual(shown, { kind: 'not_current', reason: 'reference_analytics_only', basis: 'reference' });
  assert.equal(markets.aprLabel(reference.feeAprPercent).kind, 'not_current');
  assert.equal(markets.turnover(reference).kind, 'unavailable');

  const partial = (await row('partial')).market;
  assert.deepEqual(states(partial), ['partial', 'partial', 'partial']);
  assert.equal(partial.feeAprPercent.value, null);

  const metricsView = project.projectPoolMetrics(JSON.parse(text(gateway('pool-metrics.reference-analytics'))));
  assert.deepEqual(
    metricsView.facts.find((f) => f.label === 'Fee APR'),
    { label: 'Fee APR', text: 'Reference analytics, not current: 158.06%', state: 'not-current' },
  );
});

test('stale is shown with its original time; stale metrics never read as current', async () => {
  const { market } = await row('stale');
  assert.deepEqual([market.tvlUsd.state, market.tvlUsd.asOf, market.tvlUsd.source], ['stale', 1010, 'GeckoTerminal']);
  const snapshot = JSON.parse(text(gateway('pool-metrics.stale'))).snapshot.timestamp;
  assert.deepEqual([market.feeAprPercent.state, market.feeAprPercent.asOf], ['stale', snapshot], 'dated to the metrics snapshot');
  assert.equal(markets.presentMetric(market.feeAprPercent, (m) => m.value).stale, true);
});

test('stale metrics that would fail qualification when fresh are not current, never a stale number', async () => {
  // Stale means a retained value: a figure that would be current if the snapshot were fresh. Capital
  // reconciled over 1 h only, or not at all, fails qualification however fresh the snapshot is.
  for (const [id, reason] of [['stale-capital-partial', 'capital_window_incomplete'], ['stale-capital-unavailable', 'reconciled_position_tail_required']]) {
    const { market } = await row(id);
    assert.deepEqual(states(market), ['partial', 'partial', 'partial'], id);
    assert.deepEqual([market.feeAprPercent.reason, market.tvlUsd.reason], [reason, reason], id);
    assert.equal(markets.aprLabel(market.feeAprPercent).kind, 'not_current', `${id} APR drawn as a number`);
    assert.equal(markets.presentMetric(market.tvlUsd).kind, 'not_current', `${id} TVL drawn as a number`);
    assert.notEqual(markets.turnover(market).kind, 'value', id);
  }
  const stale = () => JSON.parse(text(gateway('pool-metrics.stale')));
  const facts = (body) => Object.fromEntries(project.projectPoolMetrics(body).facts.map((f) => [f.label, f]));
  assert.deepEqual(facts(scenarios.withCapitalIncomplete(stale()))['Fee APR'], { label: 'Fee APR', text: 'Partial window (3600 s observed): 158.06%', state: 'partial' });
  assert.equal(facts(scenarios.withCapitalIncomplete(stale()))['TVL'].state, 'partial');
  assert.deepEqual(facts(scenarios.withCapitalUnavailable(stale()))['Fee APR'], { label: 'Fee APR', text: 'Not current (capital unavailable): 158.06%', state: 'partial' });
  // Control: the unmutated stale fixture would qualify when fresh, so it stays a dated stale figure.
  assert.deepEqual(facts(stale())['Fee APR'], { label: 'Fee APR', text: '158.06% · stale', state: 'stale' });
});

test('candle coverage is source, age and coverage, never a 24h figure', () => {
  const view = project.projectPoolMarket(JSON.parse(text(gateway('pool-market.success'))));
  const byLabel = Object.fromEntries(view.facts.map((f) => [f.label, f]));
  assert.deepEqual([byLabel['24h coverage'].text, byLabel['24h coverage'].state], ['Not established', 'partial']);
  assert.match(byLabel['Latest hour'].text, /inferred from the backend clock/);
  assert.match(byLabel['Price history (provider-reported)'].text, /cache 0 s/);
  assert.equal(view.facts.some((f) => /24h (volume|figure)/i.test(f.label) && f.label !== '24h volume'), false);
  const stale = project.projectPoolMarket(JSON.parse(text(gateway('pool-market.stale'))));
  assert.equal(stale.facts.find((f) => f.label === 'Price history (provider-reported)').state, 'stale');
  const notRequested = project.projectPoolMarket(JSON.parse(text(gateway('pool-market.not-requested'))));
  assert.deepEqual(notRequested.facts.find((f) => f.label === 'Price history'), { label: 'Price history', text: 'Not requested', state: 'absent' });
});

test('token metadata keeps zero decimals, unknown decimals, no contract and unavailable apart', () => {
  const decimals = (name) => project.projectToken(JSON.parse(text(gateway(`token.${name}`)))).facts.find((f) => f.label === 'Decimals');
  assert.deepEqual(decimals('zero-decimals'), { label: 'Decimals', text: '0', state: 'zero' });
  assert.deepEqual(decimals('missing-decimals'), { label: 'Decimals', text: 'Units unknown: RPC error', state: 'partial' });
  assert.deepEqual(decimals('metadata-reverted'), { label: 'Decimals', text: 'Units unknown: RPC call reverted', state: 'partial' });
  assert.deepEqual(decimals('missing-contract'), { label: 'Decimals', text: 'No contract at this address', state: 'absent' });
  assert.deepEqual(decimals('call-gas-limit'), { label: 'Decimals', text: 'Unavailable: RPC call hit the gas limit', state: 'unavailable' });
  assert.deepEqual(decimals('native'), { label: 'Decimals', text: '18', state: 'value' });
});

test('every family view distinguishes its own partial, stale and unavailable states', () => {
  const view = (route, name) => project.projectFamily({ state: 'ok', route, data: JSON.parse(text(gateway(name))), observation: { block: null, providers: [] }, provenance: {} });
  const fact = (v, label) => v.facts.find((f) => f.label === label);
  assert.equal(fact(view('pool-activity', 'pool-activity.partial'), '24h window').state, 'partial');
  assert.equal(fact(view('pool-activity', 'pool-activity.stale'), '24h window').state, 'stale');
  assert.equal(fact(view('pool-activity', 'pool-activity.unavailable'), 'LP fees').state, 'unavailable');
  assert.equal(fact(view('pool-activity', 'pool-activity.success'), 'USD volume').state, 'unavailable', 'volumeUsd is always null');
  assert.equal(fact(view('pool-positions', 'pool-positions.unavailable'), 'Position accounting').state, 'unavailable');
  assert.equal(view('pool-positions', 'pool-positions.success').items[0].facts.find((f) => f.label === 'NFT owner').text, 'Owner not resolved');
  assert.equal(view('nft-positions', 'nft-positions.empty').items[0].facts[0].text, 'Position empty at snapshot');
  assert.match(view('nft-positions', 'nft-positions.success').items[0].facts[0].text, /not proof of wallet control/);
  assert.equal(fact(view('nft-positions', 'nft-positions.stale'), 'Snapshot').state, 'stale');
  assert.deepEqual(view('nft-positions', 'nft-positions.zero').items[0].facts.find((f) => f.label === 'Liquidity'), { label: 'Liquidity', text: '0 (raw units)', state: 'zero' });
  assert.equal(fact(view('pools', 'pools.provider-unavailable'), 'Discovery (provider)').state, 'partial');
  assert.deepEqual(view('pools', 'pools.missing').notes, ['No verified pools found. That is not proof none exist.']);
  assert.ok(view('pools', 'pools.rejected-candidate').notes.some((note) => /1 candidate rejected and not listed/.test(note)));
  const zeroMetrics = view('pools', 'pools.zero-and-missing-metrics').items[0].facts;
  assert.deepEqual(zeroMetrics.find((f) => f.label.startsWith('Liquidity')).state, 'absent');
  assert.deepEqual(zeroMetrics.find((f) => f.label.startsWith('24h volume')).text, '$0.00');
  assert.equal(fact(view('pool-metrics', 'pool-metrics.capital-unavailable'), 'Capital').state, 'unavailable');
  assert.equal(fact(view('pool-metrics', 'pool-metrics.partial'), 'Capital').state, 'partial');
  assert.equal(view('catalogue', 'catalogue.empty').notes[0], 'No candidates in the configured interval. That is not proof none exist.');
});

// ---------------------------------------------------------------------------
// The markets provider: blocking states, problems, retention
// ---------------------------------------------------------------------------

test('a blocking answer stops the table; a per-pool failure only takes that pool out', async () => {
  for (const id of ['gate401', 'gate503', 'access', 'header-missing', 'header-rc2', 'not-connected', 'not-found', 'no-forwarder', 'route-disabled']) {
    const loaded = await leanRow(id);
    assert.equal(loaded.rows.length, 0, id);
    assert.ok(loaded.blocking, `${id} blocks`);
  }
  for (const id of ['invalid', 'busy', 'transient', 'edge502']) {
    const loaded = await leanRow(id);
    assert.deepEqual([loaded.rows.length, loaded.blocking, loaded.problems.length], [0, null, 1], id);
  }
  const recovered = await leanRow('retry-recovers');
  assert.equal(recovered.rows.length, 1);
  // Given metrics that fail validation, or answer for another pool, nothing of them reaches this pool's row.
  const partial = await row('metrics-invalid');
  assert.deepEqual([partial.metrics.route, partial.metrics.state], ['pool-metrics', 'invalid']);
  assert.deepEqual([partial.market.feeAprPercent.state, partial.market.feeAprPercent.reason], ['unavailable', 'invalid']);
  const elsewhere = await row('metrics-other-pool');
  assert.deepEqual([elsewhere.metrics.route, elsewhere.metrics.state, elsewhere.metrics.reason], ['pool-metrics', 'invalid', 'identity_mismatch']);
  assert.deepEqual([elsewhere.market.feeAprPercent.state, elsewhere.market.feeAprPercent.reason], ['unavailable', 'invalid']);
  for (const key of ['tvlUsd', 'volume24hUsd']) assert.notEqual(elsewhere.market[key].state, 'qualified', key);
});

/** Resolves with the provider's next settled state after `action`. */
function settled(provider, action) {
  return new Promise((resolve) => {
    let unsubscribe = () => undefined;
    const check = () => {
      const state = provider.getSnapshot();
      if (state.phase !== 'loading') {
        unsubscribe();
        resolve(state);
      }
    };
    unsubscribe = provider.subscribe(check);
    action();
  });
}

test('a failed refresh keeps the last good rows, dated and marked stale, beside the reason', async () => {
  const lean = scenarios.MARKET_CASES.find((c) => c.id === 'provider').script;
  const script = { ...lean, 'pool-market': [lean['pool-market'][0], { transport: 'gate401' }] };
  let now = 5_000_000;
  const provider = createReadMarketsProvider({ source: fixtures(script), poolIds: [FIXTURE_POOL], kind: 'fixture', now: () => now });
  const first = await settled(provider, () => provider.ensure());
  assert.equal(first.phase, 'ready');
  assert.equal(first.result.markets[0].tvlUsd.state, 'provider');
  now = 6_000_000;
  const second = await settled(provider, () => provider.refresh());
  assert.equal(second.phase, 'failed');
  assert.equal(second.failure.state, 'gate_required');
  const kept = second.retained.result.markets[0];
  assert.deepEqual([kept.tvlUsd.state, kept.tvlUsd.asOf], ['stale', 1010], 'retained, stale, dated to its own provider observation');
  assert.equal(kept.feeAprPercent.state, 'unavailable', 'an APR that was never provided stays unavailable, never a stale figure');
  assert.equal(second.retained.receivedAt, 5_000_000);
  // A current figure with no time of its own is dated to the read that produced it.
  const { retainAsStale } = built('marketsProvider');
  const bare = {
    ...second.retained.result,
    markets: [{ ...kept, tvlUsd: { value: '5', state: 'qualified' }, volume24hUsd: { value: '1', state: 'provider', source: 'GeckoTerminal', asOf: 900 }, feeAprPercent: { value: '2', state: 'qualified' } }],
  };
  const aged = retainAsStale(bare, 5_000_000).markets[0];
  assert.deepEqual(
    [aged.tvlUsd.state, aged.tvlUsd.asOf, aged.volume24hUsd.state, aged.volume24hUsd.asOf, aged.feeAprPercent.state, aged.feeAprPercent.asOf],
    ['stale', 5000, 'stale', 900, 'stale', 5000],
  );
});

/** A source that answers from fixtures, or holds every read until it is aborted. */
function holdable(script) {
  const base = fixtures(script);
  let holding = false;
  return {
    hold: () => {
      holding = true;
    },
    source: {
      transport: base.transport,
      read: (route, request, opts = {}) =>
        holding
          ? new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve({ route, state: 'aborted', provenance: {} }), { once: true }))
          : base.read(route, request, opts),
    },
  };
}

/** No figure may read as current, and every provider figure that was current is stale, dated to its provider time. */
function assertProviderRowsStale(result, label) {
  assert.ok(result, `${label}: rows kept`);
  const row = result.markets[0];
  const shown = ['tvlUsd', 'volume24hUsd'].map((key) => [key, row[key].state, row[key].asOf, row[key].source]);
  assert.deepEqual(shown, [['tvlUsd', 'stale', 1010, 'GeckoTerminal'], ['volume24hUsd', 'stale', 1010, 'GeckoTerminal']], `${label}: provider figures kept stale`);
  const states = result.markets.flatMap((r) => Object.values(r).filter((v) => v && typeof v === 'object' && 'state' in v).map((v) => v.state));
  assert.deepEqual(states.filter((state) => state === 'qualified' || state === 'provider'), [], `${label}: retained rows read as current`);
  for (const key of ['tvlUsd', 'volume24hUsd']) assert.equal(markets.presentMetric(row[key]).stale, true, `${label}: ${key} is drawn stale`);
  const turn = markets.turnover(row);
  assert.deepEqual([turn.kind, turn.text, turn.stale, turn.asOf], ['value', '0.00', true, 1010], `${label}: turnover is drawn stale, dated to its operands`);
  assert.equal(row.feeAprPercent.state, 'unavailable', `${label}: the APR was never current and stays unavailable`);
}

test('provider figures kept after a failed refresh, during Retry and after an abandoned read are stale, never provider', async () => {
  const providerCase = scenarios.MARKET_CASES.find((c) => c.id === 'provider').script;
  const fresh = await leanRow('provider');
  assert.deepEqual(states(fresh.market), ['provider', 'provider', 'unavailable'], 'the scenario starts from current provider figures');

  // A failed refresh.
  const { source, hold } = holdable({ ...providerCase, 'pool-market': [providerCase['pool-market'][0], { transport: 'gate401' }] });
  let now = 5_000_000;
  const provider = createReadMarketsProvider({ source, poolIds: [FIXTURE_POOL], kind: 'fixture', now: () => now });
  const viewer = provider.subscribe(() => undefined);
  const first = await settled(provider, () => provider.ensure());
  assert.equal(first.phase, 'ready');
  assert.equal(first.result.markets[0].tvlUsd.state, 'provider');
  now = 6_000_000;
  const failed = await settled(provider, () => provider.refresh());
  assert.deepEqual([failed.phase, failed.failure.state], ['failed', 'gate_required']);
  assertProviderRowsStale(failed.retained.result, 'failed refresh');

  // Retry in flight, pressed twice.
  hold();
  provider.refresh();
  const retrying = provider.getSnapshot();
  assert.deepEqual([retrying.phase, retrying.retrying?.state], ['loading', 'gate_required']);
  assertProviderRowsStale(retrying.previous, 'Retry');
  provider.refresh();
  assertProviderRowsStale(provider.getSnapshot().previous, 'Retry pressed again');
  viewer();

  // An abandoned read, restarted by the next viewer: abandoned once the last viewer has been gone past the grace period.
  const again = holdable(providerCase);
  const timers = fakeClock();
  const restarted = createReadMarketsProvider({ source: again.source, poolIds: [FIXTURE_POOL], kind: 'fixture', now: () => 5_000_000, clock: timers });
  assert.equal((await settled(restarted, () => restarted.ensure())).phase, 'ready');
  again.hold();
  const leaving = restarted.subscribe(() => undefined);
  restarted.refresh();
  assert.equal(restarted.getSnapshot().previous.markets[0].tvlUsd.state, 'provider', 'a refresh of current rows keeps them as they are');
  leaving();
  timers.advance(LEAVE_GRACE_MS);
  const back = restarted.subscribe(() => undefined);
  restarted.ensure();
  assert.equal(restarted.getSnapshot().phase, 'loading');
  assertProviderRowsStale(restarted.getSnapshot().previous, 'remount');
  back();
});

/** A fixture source whose reads can be held until aborted; reads, held reads and aborts are counted. */
function gated(script) {
  const base = fixtures(script);
  const counts = { reads: 0, held: 0, aborted: 0 };
  let holding = false;
  return {
    counts,
    hold: (on = true) => {
      holding = on;
    },
    source: {
      transport: base.transport,
      read: (route, request, opts = {}) => {
        counts.reads += 1;
        if (!holding) return base.read(route, request, opts);
        counts.held += 1;
        return new Promise((resolve) =>
          opts.signal?.addEventListener('abort', () => ((counts.aborted += 1), resolve({ route, state: 'aborted', provenance: {} })), { once: true }),
        );
      },
    },
  };
}

test('#123: returning viewers do not reload a completed success or failure through ensure', async () => {
  const providerCase = scenarios.MARKET_CASES.find((c) => c.id === 'provider').script;
  for (const [expected, script] of [['ready', providerCase], ['failed', { 'pool-market': [{ transport: 'gate401' }] }]]) {
    const reads = gated(script);
    const provider = createReadMarketsProvider({ source: reads.source, poolIds: [FIXTURE_POOL], kind: 'fixture' });
    const leaving = provider.subscribe(() => undefined);
    assert.equal((await settled(provider, () => provider.ensure())).phase, expected);
    const completedReads = reads.counts.reads;
    leaving();
    const back = provider.subscribe(() => undefined);
    provider.ensure();
    provider.ensure();
    await later();
    assert.equal(reads.counts.reads, completedReads, `${expected}: completion remains remembered after the last viewer leaves`);
    assert.equal(provider.getSnapshot().phase, expected);
    back();
  }
});

/** A provider whose subscriptions are counted while they are held. */
function counted(provider) {
  let active = 0;
  return {
    active: () => active,
    provider: {
      ...provider,
      subscribe: (listener) => {
        active += 1;
        const off = provider.subscribe(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    },
  };
}

test('D4: the last viewer leaving the deferred provider releases its inner subscription, which cancels the read after the grace period; a viewer who returns reads again', async () => {
  const { deferredMarkets } = built('deferredMarkets');
  const reads = gated(scenarios.MARKET_CASES.find((c) => c.id === 'provider').script);
  const timers = fakeClock();
  const inner = counted(createReadMarketsProvider({ source: reads.source, poolIds: [FIXTURE_POOL], kind: 'fixture', clock: timers }));
  let loads = 0;
  const provider = deferredMarkets('fixture', async () => ((loads += 1), inner.provider));

  reads.hold();
  const viewer = provider.subscribe(() => undefined);
  provider.ensure();
  await until(() => reads.counts.held === 1, 'the first read, held');
  assert.equal(inner.active(), 1, 'one inner subscription while someone looks');
  viewer();
  assert.equal(inner.active(), 0, 'the last viewer leaving released the inner subscription');
  assert.equal(reads.counts.aborted, 0, 'not cancelled at once: a screen that follows straight away would join it');
  timers.advance(LEAVE_GRACE_MS - 1);
  assert.equal(reads.counts.aborted, 0, 'still inside the grace period');
  timers.advance(1);
  assert.equal(reads.counts.aborted, 1, 'and the read nobody came back for was cancelled');

  // Someone comes back: subscribed again, read again, and told.
  reads.hold(false);
  let told = 0;
  const back = provider.subscribe(() => (told += 1));
  provider.ensure();
  assert.equal(inner.active(), 1);
  await until(() => provider.getSnapshot().phase === 'ready', 'the new read');
  assert.ok(told > 0, 'the returning viewer was told');
  back();
  assert.equal(inner.active(), 0);

  // Mounting and unmounting again never piles up inner subscriptions.
  for (let round = 1; round <= 3; round++) {
    const again = provider.subscribe(() => undefined);
    provider.ensure();
    assert.equal(inner.active(), 1, `mount ${round}`);
    again();
    assert.equal(inner.active(), 0, `unmount ${round}`);
  }
  assert.equal(loads, 1, 'the chunk is loaded once');
});

test('D4: a viewer who leaves before the chunk arrives starts nothing; the next one to come does', async () => {
  const { deferredMarkets } = built('deferredMarkets');
  const reads = gated(scenarios.MARKET_CASES.find((c) => c.id === 'provider').script);
  const inner = counted(createReadMarketsProvider({ source: reads.source, poolIds: [FIXTURE_POOL], kind: 'fixture' }));
  let arrive = () => undefined;
  const provider = deferredMarkets('fixture', () => new Promise((done) => (arrive = () => done(inner.provider))));

  const viewer = provider.subscribe(() => undefined);
  provider.ensure();
  viewer();
  arrive();
  await later();
  await later();
  assert.equal(reads.counts.reads, 0, 'nothing was read for nobody');
  assert.equal(inner.active(), 0, 'nor subscribed');
  assert.equal(provider.getSnapshot().phase, 'loading');

  const back = provider.subscribe(() => undefined);
  provider.ensure();
  assert.equal(inner.active(), 1);
  await until(() => provider.getSnapshot().phase === 'ready', 'the read for the viewer who came');
  back();
  assert.equal(inner.active(), 0);
});

// ---------------------------------------------------------------------------
// The read budget (rugged97 on #45): per selected pool one pool-market read
// without price history, and each distinct token once. A bare load uses no
// optional route and keeps nothing; one capabilities GET per source, and
// strictly one read at a time. Every row is out after its own pool-market
// read, and the tokens it still needs are read right after it, so the rows
// complete one by one (#138 §5).
// ---------------------------------------------------------------------------

const POOL_A = `0x${'a1'.repeat(32)}`;
const POOL_Z = `0x${'b2'.repeat(32)}`;
const TOKEN_Y = `0x${'22'.repeat(20)}`;
const TOKEN_Z = `0x${'33'.repeat(20)}`;
/** Two pools that share one currency: A/Y and Y/Z, where A is the native currency. Test data only. */
const BUDGET_POOLS = { [POOL_A]: [NATIVE, TOKEN_Y], [POOL_Z]: [TOKEN_Y, TOKEN_Z] };
/** Each pool's market, then the tokens its row still needs: A's native and Y, then Z's Z alone, since Y is read. */
const WIRE_ORDER = ['pool-market', 'token', 'token', 'pool-market', 'token'];

/** The package's pool-market reply without history, rewritten to answer for another pool id and pair. */
function marketFor(poolId, currencies) {
  const body = scenarios.withoutHistory(JSON.parse(text(gateway('pool-market.not-requested'))));
  body.poolId = poolId;
  body.pool.poolId = poolId;
  body.pool.currencies = currencies;
  body.pool.poolKey.currency0 = currencies[0];
  body.pool.poolKey.currency1 = currencies[1];
  body.market.data.poolId = poolId;
  body.market.data.currencies = currencies;
  body.market.data.baseToken = currencies[1];
  body.market.data.quoteToken = currencies[0];
  return body;
}

/** The package's token reply for another address. */
function tokenFor(address, symbol) {
  if (address === NATIVE) return JSON.parse(text(gateway('token.native')));
  const body = JSON.parse(text(gateway('token.success')));
  body.asset.address = address;
  body.asset.symbol = symbol;
  return body;
}

/** A same-origin bridge stand-in: capabilities from the package fixture, each POST answered by `answer`, every reply with the contract header. */
function stubBridge(answer, { capabilities = JSON.parse(text(gateway('capabilities.live_read_only'))) } = {}) {
  const wire = [];
  const fetch = async (path, init) => {
    wire.push({ method: init.method, path, body: init.body === undefined ? null : JSON.parse(init.body) });
    const reply = init.method === 'GET' ? { status: 200, text: JSON.stringify(capabilities) } : answer(path.replace('/api/read/v1/', ''), JSON.parse(init.body));
    return new Response(reply.text, { status: reply.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Read-Contract': RC3 } });
  };
  return { fetch, wire };
}

const budgetAnswer = (route, body) => {
  if (route === 'pool-market') return { status: 200, text: JSON.stringify(marketFor(body.poolId, BUDGET_POOLS[body.poolId])) };
  if (route === 'token') return { status: 200, text: JSON.stringify(tokenFor(body.token, 'TKN')) };
  throw new Error(`the table asked ${route}`);
};

test('a bare load is N pool-market reads without price history, each followed by the token reads its row still needs, U distinct in all, one at a time, and never pool-metrics', async () => {
  const script = {
    'pool-market': Object.entries(BUDGET_POOLS).map(([poolId, currencies]) => ({ fixture: gateway('pool-market.not-requested'), mutate: () => marketFor(poolId, currencies), expectRequest: { poolId, includePriceHistory: false } })),
    token: [NATIVE, TOKEN_Y, TOKEN_Z].map((address) => ({ fixture: gateway(address === NATIVE ? 'token.native' : 'token.success'), mutate: () => tokenFor(address, 'TKN'), expectRequest: { token: address } })),
  };
  const base = fixtures(script);
  const calls = [];
  let inFlight = 0;
  let overlapped = false;
  const source = {
    transport: base.transport,
    read: async (route, request, opts) => {
      if (inFlight > 0) overlapped = true;
      inFlight += 1;
      calls.push({ route, request });
      try {
        return await base.read(route, request, opts);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const loaded = await loadSelectedPools(source, Object.keys(BUDGET_POOLS));
  assert.deepEqual(calls.map((c) => c.route), WIRE_ORDER, 'N + U = 2 + 3 reads');
  assert.equal(overlapped, false, 'each read starts after the one before it has settled');
  assert.deepEqual([loaded.rows.length, loaded.problems.length, loaded.blocking], [2, 0, null]);
  for (const call of calls.filter((c) => c.route === 'pool-market')) {
    assert.deepEqual(Object.keys(call.request).sort(), ['includePriceHistory', 'poolId']);
    assert.equal(call.request.includePriceHistory, false, 'price history is explicitly not requested');
  }
  assert.deepEqual(calls.filter((c) => c.route === 'token').map((c) => c.request.token), [NATIVE, TOKEN_Y, TOKEN_Z], 'the shared token is read once');
  assert.deepEqual(loaded.rows.map((r) => r.poolId), Object.keys(BUDGET_POOLS), 'rows keep the configured order');
  assert.deepEqual(loaded.rows.map((r) => r.feeAprPercent.reason), ['fee_apr_not_provided', 'fee_apr_not_provided']);
  // A bare load keeps nothing between loads: the next one reads everything again.
  await loadSelectedPools(source, Object.keys(BUDGET_POOLS));
  assert.deepEqual(calls.map((c) => c.route), [...WIRE_ORDER, ...WIRE_ORDER]);
});

test('through the bridge, two selected pools cost exactly one capabilities GET and five POSTs, in order, and a reload the same again', async () => {
  for (let load = 1; load <= 2; load++) {
    const bridge = stubBridge(budgetAnswer);
    const clock = fakeClock();
    const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock });
    const loaded = await loadSelectedPools(source, Object.keys(BUDGET_POOLS));
    assert.equal(loaded.rows.length, 2, `load ${load}`);
    assert.deepEqual(bridge.wire.map((r) => `${r.method} ${r.path}`), ['GET /api/read/v1/capabilities', ...WIRE_ORDER.map((route) => `POST /api/read/v1/${route}`)], `load ${load}`);
    assert.deepEqual(
      bridge.wire.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body),
      Object.keys(BUDGET_POOLS).map((poolId) => ({ poolId, includePriceHistory: false })),
    );
    // The GET is the bridge's own and unpaced; each POST after the first waits its turn.
    assert.equal(clock.delays.length, 4, `four gaps between five POSTs, one read at a time: ${clock.delays}`);
    assert.ok(clock.delays.every((ms) => ms > 0 && ms <= 1100), `${clock.delays}`);
  }
});

test('the real bridge Worker accepts the table’s lean pool-market request exactly as sent', async () => {
  const bridge = realBridge({ answer: (route) => (route === 'pool-market' ? { status: 200, text: text(gateway('pool-market.not-requested')) } : undefined) });
  const outcome = await createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock: fakeClock() }).read('pool-market', tableMarketRequest(FIXTURE_POOL));
  assert.equal(outcome.state, 'ok');
  assert.equal(outcome.data.priceHistory.status, 'not_requested');
  assert.deepEqual(bridge.upstream.map((c) => [c.route, c.body]), [['pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false }]]);
});

test('with live data not connected, or switched off, two selected pools cost one capabilities GET and no POST', async () => {
  for (const [status, body, reason] of FORWARDER) {
    const wire = [];
    const fetch = async (path, init) => (wire.push(`${init.method} ${path}`), new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    const clock = fakeClock();
    const loaded = await loadSelectedPools(createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch, clock }), { clock }), Object.keys(BUDGET_POOLS));
    assert.deepEqual([loaded.blocking.state, loaded.blocking.reason, loaded.rows.length], ['not_connected', reason, 0]);
    assert.deepEqual(wire, ['GET /api/read/v1/capabilities'], reason);
  }
  const listed = (enabledReads) => ({ ...JSON.parse(text(gateway('capabilities.live_read_only'))), enabledReads });
  for (const [capabilities, reason] of [
    [JSON.parse(text(gateway('capabilities.disabled'))), 'bridge_data_mode_disabled'],
    [listed([]), 'bridge_data_mode_disabled'],
    [listed(['token']), 'route_not_enabled'],
  ]) {
    const bridge = stubBridge(budgetAnswer, { capabilities });
    const clock = fakeClock();
    const loaded = await loadSelectedPools(createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock }), Object.keys(BUDGET_POOLS));
    assert.deepEqual([loaded.blocking.state, loaded.blocking.reason, loaded.rows.length], ['disabled', reason, 0], reason);
    assert.deepEqual(bridge.wire.map((r) => r.method), ['GET'], `${reason}: nothing posted`);
    assert.equal(describeFailure(loaded.blocking).title, 'Live data is switched off for now');
  }
});

test('a pool-market route switched off on the server stops the table at its first answer', async () => {
  const calls = [];
  const base = fixtures({ 'pool-market': [{ transport: 'routeNotAvailable404' }] });
  const source = { transport: base.transport, read: (route, request, opts) => (calls.push(route), base.read(route, request, opts)) };
  const loaded = await loadSelectedPools(source, Object.keys(BUDGET_POOLS));
  assert.deepEqual([loaded.blocking?.state, loaded.blocking?.reason], ['disabled', 'route_not_enabled']);
  assert.deepEqual(calls, ['pool-market'], 'the second pool is not asked');
  assert.equal(describeFailure(loaded.blocking).title, 'Live data is switched off for now');
});

test('an empty selection reads nothing at all, not even the capabilities GET, and the table is ready with no rows', async () => {
  let reads = 0;
  const idle = { transport: 'bridge', read: async () => ((reads += 1), { state: 'aborted' }) };
  const loaded = await loadSelectedPools(idle, []);
  assert.deepEqual([loaded.rows.length, loaded.problems.length, loaded.blocking], [0, 0, null]);
  const provider = createReadMarketsProvider({ source: idle, poolIds: [], kind: 'bridge' });
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.result.markets.length, state.problems.length, state.result.source], ['ready', 0, 0, 'live']);
  assert.equal(reads, 0);
  const bridge = stubBridge(budgetAnswer);
  const clock = fakeClock();
  await loadSelectedPools(createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock }), []);
  assert.deepEqual(bridge.wire, []);
  // Nor does the provider ask which routes are listed for a table with no pools.
  let asked = 0;
  const probing = createReadMarketsProvider({ source: { ...idle, routeEnabled: async () => ((asked += 1), { state: 'enabled' }) }, poolIds: [], kind: 'bridge' });
  assert.equal((await settled(probing, () => probing.ensure())).phase, 'ready');
  assert.deepEqual([reads, asked], [0, 0]);
});

// ---------------------------------------------------------------------------
// The provider's load (G0, G1, G2): which optional routes are listed is asked
// without a POST or a place in the queue; the stored markets snapshot first,
// when listed; pool-metrics for each row, when listed; token metadata kept
// for the page. Every figure still comes from a validated reply.
// ---------------------------------------------------------------------------

const { createSnapshotMemo, planSnapshot, SNAPSHOT_RETRY_MS } = built('marketsSnapshot');
const { marketPoolPrice } = built('marketPrice');
const { OTHER_POOL } = scenarios;

/** What production's capabilities list today: the seven public reads and no optional route. */
const PRODUCTION_READS = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity'];
const capabilitiesListing = (enabledReads) => ({ ...JSON.parse(text(gateway('capabilities.live_read_only'))), enabledReads });
const json200 = (body) => ({ status: 200, text: JSON.stringify(body) });
const BUDGET_IDS = Object.keys(BUDGET_POOLS);

/** One budget pool's stored entry, from its rewritten market read. */
function storedEntry(poolId, { observedAt = 1010, cacheAgeSeconds = 0 } = {}) {
  const read = marketFor(poolId, BUDGET_POOLS[poolId]);
  return { poolId, pool: read.pool, market: { ...read.market, cache: { ...read.market.cache, ageSeconds: cacheAgeSeconds } }, observedAt };
}

/** The package's snapshot reply holding these entries, as an answer to `requested`. */
function snapshotOf(pools, { requested = BUDGET_IDS, builtAt = 1010, ageSeconds = 0 } = {}) {
  return { ...JSON.parse(text(gateway('markets-snapshot.subset'))), builtAt, ageSeconds, requested, pools };
}

/** pool-metrics fixture `name`, answering for `poolId`. */
function metricsFor(poolId, name = 'qualified') {
  const body = JSON.parse(text(gateway(`pool-metrics.${name}`)));
  body.poolId = poolId;
  if (body.coverage && 'poolId' in body.coverage) body.coverage.poolId = poolId;
  return body;
}

/** The budget pools' bridge, with a stored snapshot of both and pool-metrics for the pool asked; any answer can be replaced. */
function storeAnswer({ snapshot, metrics, market, token } = {}) {
  return (route, body) => {
    if (route === 'markets-snapshot') return snapshot?.(body) ?? json200(snapshotOf(BUDGET_IDS.map((id) => storedEntry(id))));
    if (route === 'pool-metrics') return metrics?.(body.poolId) ?? json200(metricsFor(body.poolId));
    if (route === 'pool-market') return market?.(body.poolId) ?? budgetAnswer(route, body);
    if (route === 'token') return token?.(body.token) ?? budgetAnswer(route, body);
    throw new Error(`the table asked ${route}`);
  };
}

/** The app's provider over the app's source shape (the scheduler over a bridge source), with a fake clock for pacing and the snapshot's wait. */
function bridgeProvider(answer, enabledReads) {
  const bridge = stubBridge(answer, { capabilities: capabilitiesListing(enabledReads) });
  const clock = fakeClock();
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock });
  const provider = createReadMarketsProvider({ source, poolIds: BUDGET_IDS, kind: 'bridge', monotonic: clock.monotonic });
  return { provider, bridge, clock, wire: () => bridge.wire.map((r) => `${r.method} ${r.path.replace('/api/read/v1/', '')}`) };
}
const LEAN_WIRE = WIRE_ORDER.map((route) => `POST ${route}`);

test('markets-snapshot identity: a subset or an unbuilt store is an answer; an echo of another question, an entry twice, not asked for, or about another pool is not', () => {
  const asked = { poolIds: [FIXTURE_POOL] };
  const subset = () => JSON.parse(text(gateway('markets-snapshot.subset')));
  const judge = (request, body) => {
    assert.equal(runtime.validateResponse('markets-snapshot', body), true, 'the package runtime accepts the mutation');
    const outcome = interpretReply('markets-snapshot', request, raw(200, 'application/json', JSON.stringify(body)), runtime, provenance);
    return outcome.state === 'ok' ? 'ok' : `${outcome.state} ${outcome.reason}`;
  };
  const cases = [
    ['the subset fixture, asked for its pool', asked, subset(), 'ok'],
    ['asked for two, one stored: the other is absent', { poolIds: [FIXTURE_POOL, OTHER_POOL] }, { ...subset(), requested: [FIXTURE_POOL, OTHER_POOL] }, 'ok'],
    ['an unbuilt store holds nothing', asked, { ...subset(), status: 'not_built', pools: [], builtAt: null, ageSeconds: null }, 'ok'],
    ['asked in capitals', { poolIds: [`0x${FIXTURE_POOL.slice(2).toUpperCase()}`] }, subset(), 'ok'],
    ['an unfiltered question, answered by the package’s own fixture', {}, JSON.parse(text(gateway('markets-snapshot.success'))), 'ok'],
    ['an echo that is not the question', asked, { ...subset(), requested: [OTHER_POOL] }, 'invalid identity_mismatch'],
    ['an echo of a filter nobody sent', {}, subset(), 'invalid identity_mismatch'],
    ['no echo for a filtered question: the answer to an unfiltered one', asked, { ...subset(), requested: [] }, 'invalid identity_mismatch'],
    ['the package’s unfiltered fixture, asked with the empty filter it answers', { poolIds: [] }, JSON.parse(text(gateway('markets-snapshot.success'))), 'ok'],
    ['an unbuilt store with an entry', asked, { ...subset(), status: 'not_built', builtAt: null, ageSeconds: null }, 'invalid identity_mismatch'],
    ['an entry twice', { poolIds: [FIXTURE_POOL, OTHER_POOL] }, (() => { const d = { ...subset(), requested: [FIXTURE_POOL, OTHER_POOL] }; d.pools = [d.pools[0], structuredClone(d.pools[0])]; return d; })(), 'invalid identity_mismatch'],
    ['an entry not asked for', asked, (() => { const d = subset(); const e = d.pools[0]; e.poolId = OTHER_POOL; e.pool.poolId = OTHER_POOL; e.market.data.poolId = OTHER_POOL; return d; })(), 'invalid identity_mismatch'],
    ['a verified pool that is another pool', asked, (() => { const d = subset(); d.pools[0].pool.poolId = OTHER_POOL; return d; })(), 'invalid identity_mismatch'],
    ['a market about another pool', asked, (() => { const d = subset(); d.pools[0].market.data.poolId = OTHER_POOL; return d; })(), 'invalid identity_mismatch'],
    ['a market with the currencies the other way round', asked, (() => { const d = subset(); d.pools[0].market.data.currencies.reverse(); return d; })(), 'invalid identity_mismatch'],
  ];
  for (const [label, request, body, expected] of cases) assert.equal(judge(request, body), expected, label);
});

test('G0: with no optional route listed, the provider sends exactly what a bare load sends, with not one pacing gap more', async () => {
  const bare = stubBridge(budgetAnswer, { capabilities: capabilitiesListing(PRODUCTION_READS) });
  const bareClock = fakeClock();
  await loadSelectedPools(createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bare.fetch, clock: bareClock }), { clock: bareClock }), BUDGET_IDS);

  const { provider, bridge, clock, wire } = bridgeProvider(budgetAnswer, PRODUCTION_READS);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.result.markets.length, state.problems.length], ['ready', 2, 0]);
  assert.deepEqual(wire(), ['GET capabilities', ...LEAN_WIRE], 'one capabilities GET and the lean POSTs: no snapshot, no pool-metrics');
  assert.deepEqual(bridge.wire, bare.wire, 'byte for byte what a bare load sends');
  assert.deepEqual(clock.delays, bareClock.delays, 'and not one pacing gap more: asking costs no place in the queue');
  assert.deepEqual(state.result.markets.map((m) => [m.provenance.origin, m.provenance.metrics]), [['pool-market', 'not_requested'], ['pool-market', 'not_requested']]);
});

test('G0: through the provider, a refused capabilities answer still ends the load at its one GET, in the state a bare load ends in', async () => {
  for (const [status, body, reason] of FORWARDER) {
    const wire = [];
    const fetch = async (path, init) => (wire.push(`${init.method} ${path}`), new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    const clock = fakeClock();
    const provider = createReadMarketsProvider({ source: createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch, clock }), { clock }), poolIds: BUDGET_IDS, kind: 'bridge' });
    const state = await settled(provider, () => provider.ensure());
    assert.deepEqual([state.phase, state.failure.state, state.failure.reason, state.failure.route], ['failed', 'not_connected', reason, 'pool-market'], reason);
    assert.deepEqual(wire, ['GET /api/read/v1/capabilities'], reason);
  }
  for (const [capabilities, reason] of [
    [JSON.parse(text(gateway('capabilities.disabled'))), 'bridge_data_mode_disabled'],
    [capabilitiesListing([]), 'bridge_data_mode_disabled'],
    [capabilitiesListing(['token']), 'route_not_enabled'],
  ]) {
    const bridge = stubBridge(budgetAnswer, { capabilities });
    const clock = fakeClock();
    const provider = createReadMarketsProvider({ source: createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock }), poolIds: BUDGET_IDS, kind: 'bridge' });
    const state = await settled(provider, () => provider.ensure());
    assert.deepEqual([state.phase, state.failure.state, state.failure.reason], ['failed', 'disabled', reason], reason);
    assert.equal(describeFailure(state.failure).title, 'Live data is switched off for now');
    assert.deepEqual(bridge.wire.map((r) => r.method), ['GET'], `${reason}: nothing posted`);
  }
  // The snapshot listed and answering from an unbuilt store, with the pools' own reads not listed: those stop the table as they always did.
  const unbuilt = storeAnswer({ snapshot: () => json200({ ...snapshotOf([]), status: 'not_built', builtAt: null, ageSeconds: null }) });
  const { provider, wire } = bridgeProvider(unbuilt, ['token', 'markets-snapshot']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.failure.state, state.failure.reason], ['failed', 'disabled', 'route_not_enabled']);
  assert.deepEqual(wire(), ['GET capabilities', 'POST markets-snapshot']);
});

test('G0: routeEnabled is the one capabilities GET a read would make, kept for that read; it never posts, and asks nothing when it cannot be answered', async () => {
  const clock = fakeClock();
  const bridge = stubBridge(budgetAnswer, { capabilities: capabilitiesListing([...PRODUCTION_READS, 'markets-snapshot']) });
  const source = createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock });
  assert.deepEqual(await source.routeEnabled('markets-snapshot'), { state: 'enabled' });
  assert.deepEqual(await source.routeEnabled('pool-metrics'), { state: 'not_enabled' });
  assert.equal((await source.read('token', { token: NATIVE })).state, 'ok');
  assert.deepEqual(bridge.wire.map((r) => r.method), ['GET', 'POST'], 'one GET for both questions and the read after them');

  const off = await createBridgeSource({ enabled: false, validators: runtime, fetch: () => assert.fail('a source with live data off fetched'), clock }).routeEnabled('pool-market');
  assert.deepEqual([off.state, off.outcome.route, off.outcome.state, off.outcome.reason], ['failed', 'pool-market', 'disabled', 'live_data_disabled']);
  const unasked = stubBridge(budgetAnswer);
  const quiet = createBridgeSource({ enabled: true, validators: runtime, fetch: unasked.fetch, clock });
  const controller = new AbortController();
  controller.abort();
  const aborted = await quiet.routeEnabled('markets-snapshot', { signal: controller.signal });
  assert.deepEqual([aborted.state, aborted.outcome.state], ['failed', 'aborted']);
  const late = await quiet.routeEnabled('markets-snapshot', { deadlineAt: clock.monotonic() });
  assert.deepEqual([late.state, late.outcome.state, late.outcome.cause.kind], ['failed', 'unavailable', 'read_deadline']);
  assert.deepEqual(unasked.wire, [], 'an aborted or late question sends nothing');
  const disabled = stubBridge(budgetAnswer, { capabilities: JSON.parse(text(gateway('capabilities.disabled'))) });
  const mode = await createBridgeSource({ enabled: true, validators: runtime, fetch: disabled.fetch, clock }).routeEnabled('markets-snapshot');
  assert.deepEqual([mode.state, mode.outcome.route, mode.outcome.state, mode.outcome.reason], ['failed', 'markets-snapshot', 'disabled', 'bridge_data_mode_disabled']);
});

test('G0: the scheduler passes routeEnabled straight through: answered while a read runs, and the next read is paced from that read alone', async () => {
  const clock = fakeClock();
  const starts = [];
  const release = [];
  let asked = 0;
  const inner = {
    transport: 'bridge',
    read: (route) => new Promise((resolve) => {
      starts.push([clock.now(), route]);
      release.push(() => resolve({ route, state: 'ok', data: {}, provenance: {} }));
    }),
    routeEnabled: async (route) => ((asked += 1), { state: route === 'pool-metrics' ? 'enabled' : 'not_enabled' }),
  };
  const source = createScheduledSource(inner, { clock });
  const first = source.read('token', { token: NATIVE });
  await later();
  assert.deepEqual(await source.routeEnabled('pool-metrics'), { state: 'enabled' }, 'answered with a read in flight: no queue');
  assert.equal(asked, 1);
  release.shift()();
  await first;
  const second = source.read('token', { token: FIXTURE_TOKEN });
  await later();
  release.shift()();
  await second;
  assert.deepEqual(starts, [[0, 'token'], [1100, 'token']], 'the question moved no pacing');
  assert.equal('routeEnabled' in createScheduledSource({ transport: 'bridge', read: inner.read }, { clock }), false, 'a source that cannot answer gives the queue nothing to answer with');
});

test('G2: with markets-snapshot listed, one read puts every stored pool on screen before any token read, and fresh entries need no market read', async () => {
  const { provider, bridge, clock, wire } = bridgeProvider(storeAnswer(), [...PRODUCTION_READS, 'markets-snapshot']);
  const seen = [];
  const watching = provider.subscribe(() => {
    const now = provider.getSnapshot();
    if (now.phase === 'loading' && now.previous) seen.push({ posts: bridge.wire.filter((r) => r.method === 'POST').length, rows: now.previous.markets.map((m) => [m.poolId, m.provenance.origin, m.tokens.quote.symbol]) });
  });
  const state = await settled(provider, () => provider.ensure());
  watching();
  assert.equal(state.phase, 'ready');
  assert.deepEqual(wire(), ['GET capabilities', 'POST markets-snapshot', 'POST token', 'POST token', 'POST token'], 'no pool-market read, and no estimate namespace');
  assert.deepEqual(bridge.wire[1].body, { poolIds: BUDGET_IDS }, 'the selected pools, and only them');
  assert.deepEqual(seen[0], { posts: 1, rows: BUDGET_IDS.map((id) => [id, 'markets-snapshot', null]) }, 'both rows after the one snapshot read, before any token read');
  assert.equal(clock.delays.length, 3, 'four POSTs, three gaps');
  const rows = state.result.markets;
  assert.deepEqual(rows.map((m) => [m.provenance.origin, m.tvlUsd.state, m.tvlUsd.source, m.tvlUsd.asOf, m.provenance.block, m.provenance.market.cacheAgeSeconds]), BUDGET_IDS.map(() => ['markets-snapshot', 'provider', 'GeckoTerminal', 1010, 700, 0]));
  assert.deepEqual(rows.map((m) => [m.feeAprEstimate.data, m.feeAprEstimate.reason]), BUDGET_IDS.map(() => [null, 'estimate_not_in_snapshot']), 'the store keeps no estimate, and none is made from its inputs');
  assert.deepEqual(rows.map((m) => [m.tokens.base.symbol, m.tokens.quote.symbol]), [['ETH', 'TKN'], ['TKN', 'TKN']], 'named from the token reads once they land');
});

test('G2: the plan maps every stored entry at once and reads again only absent, unbuilt, stale or unavailable pools; a rejected one waits out the window', () => {
  const subset = () => JSON.parse(text(gateway('markets-snapshot.subset')));
  const cases = [
    ['current', (d) => d, true, false],
    ['served 290 s after it was stored', (d) => ({ ...d, ageSeconds: 290 }), true, false],
    ['served 400 s after it was stored', (d) => ({ ...d, ageSeconds: 400 }), true, true],
    ['a stale store', (d) => ({ ...d, status: 'stale', stale: true, reason: 'snapshot_refresh_pending', ageSeconds: 400 }), true, true],
    ['a store marked stale, whatever its entries say', (d) => ({ ...d, status: 'stale', stale: true, reason: 'snapshot_refresh_pending' }), true, true],
    ['provider figures stored past the limit', (d) => { d.pools[0].market.cache.ageSeconds = 301; return d; }, true, true],
    ['provider figures past the limit once served', (d) => { d.pools[0].market.cache.ageSeconds = 250; return { ...d, ageSeconds: 51 }; }, true, true],
    ['stored without provider figures', (d) => { d.pools[0].market = { status: 'unavailable', reason: 'provider_unavailable', data: null, cache: { ...d.pools[0].market.cache, ageSeconds: null } }; return d; }, true, true],
    ['stored with rejected provider figures', (d) => { d.pools[0].market = { status: 'rejected', reason: 'provider_currency_or_pool_mismatch', data: null, cache: d.pools[0].market.cache }; return d; }, true, false],
    ['not stored', (d) => ({ ...d, pools: [] }), false, true],
    ['not built', (d) => ({ ...d, status: 'not_built', pools: [], builtAt: null, ageSeconds: null }), false, true],
  ];
  for (const [label, mutate, mapped, refreshed] of cases) {
    const body = mutate(subset());
    assert.equal(runtime.validateResponse('markets-snapshot', body), true, `${label}: the package runtime accepts the mutation`);
    const plan = planSnapshot(body, [FIXTURE_POOL]);
    assert.equal(plan.entries.has(FIXTURE_POOL), mapped, `${label}: on screen at once`);
    assert.deepEqual(plan.refresh, refreshed ? [FIXTURE_POOL] : [], `${label}: read on demand`);
  }
});

/** A fixture source that says which routes its script lists, as a bridge source's capabilities would. */
function listing(script, options) {
  const base = fixtures(script, options);
  return { transport: base.transport, requests: base.requests, read: (route, request, opts) => base.read(route, request, opts), routeEnabled: async (route) => ({ state: script[route]?.length ? 'enabled' : 'not_enabled' }) };
}
const storeOptions = () => ({ snapshot: createSnapshotMemo(() => 0), tokens: new Map(), metrics: true });

test('G2: a stale or unavailable stored pool stays on screen while its own lean market read runs; an absent or unbuilt one is read before its tokens', async () => {
  const leanMarket = { ...scenarios.MARKET_CASES.find((c) => c.id === 'provider').script['pool-market'][0] };
  const cases = [
    ['current', (d) => d, ['markets-snapshot', 'token', 'token']],
    ['served 400 s after it was stored', (d) => ({ ...d, ageSeconds: 400 }), ['markets-snapshot', 'token', 'token', 'pool-market']],
    ['a stale store', (d) => ({ ...d, status: 'stale', stale: true, reason: 'snapshot_refresh_pending', ageSeconds: 400 }), ['markets-snapshot', 'token', 'token', 'pool-market']],
    ['provider figures stored past the limit', (d) => { d.pools[0].market.cache.ageSeconds = 301; return d; }, ['markets-snapshot', 'token', 'token', 'pool-market']],
    ['stored without provider figures', (d) => { d.pools[0].market = { status: 'unavailable', reason: 'provider_unavailable', data: null, cache: { ...d.pools[0].market.cache, ageSeconds: null } }; return d; }, ['markets-snapshot', 'token', 'token', 'pool-market']],
    ['not stored', (d) => ({ ...d, pools: [] }), ['markets-snapshot', 'pool-market', 'token', 'token']],
    ['not built', (d) => ({ ...d, status: 'not_built', pools: [], builtAt: null, ageSeconds: null }), ['markets-snapshot', 'pool-market', 'token', 'token']],
  ];
  for (const [label, mutate, log] of cases) {
    const script = {
      'markets-snapshot': [{ fixture: gateway('markets-snapshot.subset'), mutate, expectRequest: { poolIds: [FIXTURE_POOL] } }],
      'pool-market': [leanMarket],
      token: scenarios.projectionTokens(),
    };
    const source = listing(script, { clock: fakeClock() });
    const origins = [];
    const loaded = await loadSelectedPools(source, [FIXTURE_POOL], undefined, (rows) => origins.push(rows.map((m) => m.provenance.origin)), storeOptions());
    assert.deepEqual(source.requests.map((r) => r.route), log, label);
    assert.deepEqual(source.requests.filter((r) => r.route === 'pool-market').map((r) => r.request), log.includes('pool-market') ? [{ poolId: FIXTURE_POOL, includePriceHistory: false }] : [], `${label}: the lean request`);
    assert.deepEqual([loaded.rows.length, loaded.problems.length, loaded.blocking], [1, 0, null], label);
    const stored = log[1] === 'token';
    assert.deepEqual(origins[0], [stored ? 'markets-snapshot' : 'pool-market'], `${label}: the first row on screen`);
    assert.equal(loaded.rows[0].provenance.origin, log.includes('pool-market') ? 'pool-market' : 'markets-snapshot', `${label}: the row ends on its freshest read`);
  }
});

test('the read lab’s snapshot cases read what they say, through the provider’s own load: a current store alone, a store that is not enough then the pool’s own read, a failing one the lean load', async () => {
  const STORED = ['markets-snapshot', 'token', 'token'];
  const REFRESHED = [...STORED, 'pool-market'];
  const LEAN = ['markets-snapshot', 'pool-market', 'token', 'token'];
  const expected = {
    'snapshot-current': [STORED, 'markets-snapshot'],
    'snapshot-stale-entry': [REFRESHED, 'pool-market'],
    'snapshot-stale-envelope': [REFRESHED, 'pool-market'],
    'snapshot-provider-expired': [REFRESHED, 'pool-market'],
    'snapshot-market-unavailable': [REFRESHED, 'pool-market'],
    'snapshot-absent': [LEAN, 'pool-market'],
    'snapshot-not-built': [LEAN, 'pool-market'],
    'snapshot-identity': [LEAN, 'pool-market'],
    'snapshot-broken': [LEAN, 'pool-market'],
    'snapshot-invalid': [LEAN, 'pool-market'],
  };
  const cases = scenarios.MARKET_CASES.filter((c) => c.id.startsWith('snapshot-'));
  assert.deepEqual(cases.map((c) => c.id), Object.keys(expected));
  for (const scenario of cases) {
    const [log, origin] = expected[scenario.id];
    const source = fixtures(scenario.script, { clock: fakeClock() });
    const loaded = await loadSelectedPools(source, [FIXTURE_POOL], undefined, undefined, storeOptions());
    assert.deepEqual(source.requests.map((r) => r.route), log, scenario.id);
    assert.deepEqual([loaded.rows.length, loaded.problems.length, loaded.blocking, loaded.rows[0].provenance.origin], [1, 0, null, origin], scenario.id);
  }
});

test('G2: stored ages come from the payload alone and count on from the answer: provider age, stale on screen, the price’s age, its block, and no estimate', async () => {
  const body = JSON.parse(text(gateway('markets-snapshot.subset')));
  // Stored at 1000 with figures 5 s old; served at 1060 (built 1010, 50 s before the answer).
  Object.assign(body, { builtAt: 1010, ageSeconds: 50 });
  body.pools[0].observedAt = 1000;
  body.pools[0].market.cache.ageSeconds = 5;
  const source = listing({ 'markets-snapshot': [{ fixture: gateway('markets-snapshot.subset'), mutate: () => structuredClone(body) }], token: scenarios.projectionTokens() }, { clock: fakeClock() });
  const loaded = await loadSelectedPools(source, [FIXTURE_POOL], undefined, undefined, storeOptions());
  const row = loaded.rows[0];
  assert.deepEqual([row.provenance.market.cacheAgeSeconds, row.poolState.servedAgeSeconds], [65, 60], 'provider age 5 + (1010 + 50 − 1000); served age 60');
  assert.deepEqual([row.provenance.block, row.poolState.block], [700, 700], 'the block the stored pool was verified at');
  assert.deepEqual([row.feeAprEstimate.data, row.feeAprEstimate.reason, row.provenance.origin], [null, 'estimate_not_in_snapshot', 'markets-snapshot']);
  const answered = row.provenance.market;
  const at = (ms) => ({ wall: answered.receivedAt + ms, monotonic: answered.receivedMonotonic + ms });
  assert.equal(markets.retrievedText(markets.retrievedAgeSeconds(answered, at(0))), 'retrieved 65 s ago');
  assert.equal(markets.providerStale(answered, at(0)), true, 'past the 60 s fresh window the moment it arrives');
  assert.deepEqual([markets.agedMarket(row, at(0)).tvlUsd.state, markets.presentMetric(markets.agedMarket(row, at(0)).tvlUsd).text], ['stale', '$12.3K'], 'drawn with its value, stale in its state');
  // The price: its state was 60 s old when served, so it turns stale 240 s on, not 300 s.
  assert.deepEqual([marketPoolPrice(row, at(0)).state, marketPoolPrice(row, at(239_999)).stale, marketPoolPrice(row, at(240_000)).stale], ['usable', false, true]);

  // Stored 10 s before the answer, with figures retrieved as it was stored: fresh for 50 s more on screen.
  const snapshot = await source.read('markets-snapshot', { poolIds: [FIXTURE_POOL] });
  const stored = snapshot.data.pools[0];
  const younger = project.projectSnapshotRow({ snapshot, entry: { ...stored, observedAt: 1050, market: { ...stored.market, cache: { ...stored.market.cache, ageSeconds: 0 } } }, metrics: null, tokens: new Map() });
  const youngAt = (ms) => ({ wall: younger.provenance.market.receivedAt + ms, monotonic: younger.provenance.market.receivedMonotonic + ms });
  assert.deepEqual([younger.provenance.market.cacheAgeSeconds, younger.poolState.servedAgeSeconds], [10, 10]);
  assert.equal(markets.providerStale(younger.provenance.market, youngAt(50_000)), false, '60 s in all: still inside the fresh window');
  assert.equal(markets.providerStale(younger.provenance.market, youngAt(51_000)), true, '61 s in all: stale');
});

test('G2: the snapshot memo allows the snapshot again exactly SNAPSHOT_RETRY_MS after a failure, and a good answer clears it', () => {
  assert.equal(SNAPSHOT_RETRY_MS, 300_000);
  let now = 1_000;
  const memo = createSnapshotMemo(() => now);
  assert.equal(memo.allows(), true);
  memo.failed();
  now += SNAPSHOT_RETRY_MS - 1;
  assert.equal(memo.allows(), false);
  now += 1;
  assert.equal(memo.allows(), true);
  memo.failed();
  assert.equal(memo.allows(), false);
  memo.succeeded();
  assert.equal(memo.allows(), true);
});

test('G2: a failed snapshot is never shown or said: the same load reads the pools itself, and the snapshot is left alone for five minutes', async () => {
  const other = () => {
    const entry = storedEntry(POOL_A);
    entry.poolId = OTHER_POOL;
    entry.pool = { ...entry.pool, poolId: OTHER_POOL };
    entry.market = { ...entry.market, data: { ...entry.market.data, poolId: OTHER_POOL } };
    return json200(snapshotOf([entry]));
  };
  for (const [label, failure] of [
    ['a 503', () => ({ status: 503, text: '{"error":"upstream_unavailable"}' })],
    ['the route switched off on the server', () => ({ status: 404, text: '{"error":"route_not_available"}' })],
    ['an answer about another pool', other],
    ['an answer outside the contract', () => json200({ ...snapshotOf([]), schemaVersion: 999 })],
  ]) {
    let failing = true;
    const answer = storeAnswer({ snapshot: () => (failing ? failure() : json200(snapshotOf(BUDGET_IDS.map((id) => storedEntry(id))))) });
    const { provider, clock, wire } = bridgeProvider(answer, [...PRODUCTION_READS, 'markets-snapshot']);
    const first = await settled(provider, () => provider.ensure());
    assert.deepEqual([first.phase, first.problems.length, first.result.markets.map((m) => m.provenance.origin)], ['ready', 0, ['pool-market', 'pool-market']], `${label}: nothing is said of it`);
    assert.deepEqual(wire(), ['GET capabilities', 'POST markets-snapshot', ...LEAN_WIRE], `${label}: the pools are read in the same load`);

    failing = false;
    let mark = wire().length;
    clock.advance(60_000);
    await settled(provider, () => provider.refresh());
    assert.deepEqual(wire().slice(mark), ['GET capabilities', 'POST pool-market', 'POST pool-market'], `${label}: a minute on, availability is revalidated, but no snapshot or token is asked`);

    mark = wire().length;
    clock.advance(SNAPSHOT_RETRY_MS);
    const back = await settled(provider, () => provider.refresh());
    assert.deepEqual(wire().slice(mark), ['GET capabilities', 'POST markets-snapshot', 'POST token', 'POST token', 'POST token'], `${label}: five minutes on availability, the snapshot and token metadata past its own TTL are revalidated`);
    assert.deepEqual(back.result.markets.map((m) => m.provenance.origin), ['markets-snapshot', 'markets-snapshot'], label);
  }
});

test('G2: a stored row whose own read fails stays on screen, stale in its state, beside that one problem', async () => {
  // Stored 410 s before the answer: past the limit, so read again; that read fails.
  const answer = storeAnswer({
    snapshot: () => json200(snapshotOf([storedEntry(POOL_A, { observedAt: 600 }), storedEntry(POOL_Z)])),
    market: (poolId) => (poolId === POOL_A ? { status: 503, text: '{"error":"upstream_unavailable"}' } : undefined),
  });
  const { provider, wire } = bridgeProvider(answer, [...PRODUCTION_READS, 'markets-snapshot']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual(wire(), ['GET capabilities', 'POST markets-snapshot', 'POST token', 'POST token', 'POST token', 'POST pool-market']);
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state]), [[POOL_A, 'pool-market', 'unavailable']]);
  const [kept, fresh] = state.result.markets;
  assert.deepEqual([kept.poolId, kept.provenance.origin, kept.provenance.market.cacheAgeSeconds, kept.poolState.servedAgeSeconds], [POOL_A, 'markets-snapshot', 410, 410]);
  const at = { wall: kept.provenance.market.receivedAt, monotonic: kept.provenance.market.receivedMonotonic };
  const shown = markets.agedMarket(kept, at);
  assert.deepEqual([shown.tvlUsd.state, markets.presentMetric(shown.tvlUsd).text, markets.presentMetric(shown.tvlUsd).stale], ['stale', '$12.3K', true], 'its value, marked stale');
  assert.equal(marketPoolPrice(kept, at).stale, true, 'and its price with it');
  assert.equal(markets.providerStale(fresh.provenance.market, { wall: fresh.provenance.market.receivedAt, monotonic: fresh.provenance.market.receivedMonotonic }), false, 'the other row is current');
});

test('#138 §5: each row is out as soon as its own market read answers, and complete once the token reads right after it land, before the next pool is read', async () => {
  const calls = [];
  const bridge = stubBridge((route, body) => (calls.push(route), budgetAnswer(route, body)), { capabilities: capabilitiesListing(PRODUCTION_READS) });
  const clock = fakeClock();
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock });
  const progress = [];
  const loaded = await loadSelectedPools(source, BUDGET_IDS, undefined, (rows) =>
    progress.push({ reads: [...calls], rows: rows.map((m) => [m.poolId, m.tokens.base.symbol, m.tokens.quote.symbol, m.tokens.base.decimals, m.tokensPending ?? false]) }),
  );
  assert.deepEqual(progress, [
    { reads: ['pool-market'], rows: [[POOL_A, null, null, null, true]] },
    { reads: ['pool-market', 'token'], rows: [[POOL_A, 'ETH', null, 18, true]] },
    { reads: ['pool-market', 'token', 'token'], rows: [[POOL_A, 'ETH', 'TKN', 18, false]] },
    // The second pool's row: its shared token is already read, so it waits for its other one only.
    { reads: ['pool-market', 'token', 'token', 'pool-market'], rows: [[POOL_A, 'ETH', 'TKN', 18, false], [POOL_Z, 'TKN', null, 6, true]] },
    { reads: WIRE_ORDER, rows: [[POOL_A, 'ETH', 'TKN', 18, false], [POOL_Z, 'TKN', 'TKN', 6, false]] },
  ], 'one row complete before the next pool is asked');
  assert.deepEqual(loaded.rows.map((m) => m.tokensPending), [undefined, undefined], 'a settled load has nothing pending');
});

test('the price waits while a row’s token reads are pending; decimals unknown only once a token read settled without them', async () => {
  const failing = { [TOKEN_Y]: { status: 503, text: '{"error":"upstream_unavailable"}' } };
  const bridge = stubBridge((route, body) => (route === 'token' && failing[body.token] ? failing[body.token] : budgetAnswer(route, body)), { capabilities: capabilitiesListing(PRODUCTION_READS) });
  const clock = fakeClock();
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bridge.fetch, clock }), { clock });
  const seen = [];
  const loaded = await loadSelectedPools(source, [POOL_A], undefined, (rows) => {
    const [row] = rows;
    const price = marketPoolPrice(row, { wall: row.provenance.market.receivedAt, monotonic: row.provenance.market.receivedMonotonic });
    seen.push([row.tokensPending ?? false, price.state, price.problem ?? null]);
  });
  assert.deepEqual(seen, [
    [true, 'unavailable', 'decimals_unknown'],
    [true, 'unavailable', 'decimals_unknown'],
    [false, 'unavailable', 'decimals_unknown'],
  ], 'pending while a token read is to come, and no longer once the failed one settled');
  assert.deepEqual(loaded.problems.map((p) => [p.poolId, p.token, p.outcome.route, p.outcome.state]), [[POOL_A, TOKEN_Y, 'token', 'unavailable']], 'the token problem names its token');
  assert.equal(loaded.rows[0].tokensPending, undefined);
});

test('token metadata that read as available is kept for the page: a refresh reads no token again, and partial metadata is read again', async () => {
  const partial = JSON.parse(text(gateway('token.missing-decimals')));
  partial.asset.address = TOKEN_Z;
  const { provider, bridge, wire } = bridgeProvider(storeAnswer({ token: (address) => (address === TOKEN_Z ? json200(partial) : undefined) }), PRODUCTION_READS);
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual([first.phase, wire()], ['ready', ['GET capabilities', ...LEAN_WIRE]]);
  const mark = bridge.wire.length;
  const second = await settled(provider, () => provider.refresh());
  assert.deepEqual(wire().slice(mark), ['POST pool-market', 'POST pool-market', 'POST token'], 'the markets again, and only the token whose metadata was partial');
  assert.deepEqual(bridge.wire.at(-1).body, { token: TOKEN_Z });
  assert.deepEqual(second.result.markets.map((m) => [m.tokens.base.symbol, m.tokens.base.decimals, m.tokens.quote.decimals]), [['ETH', 18, 6], ['TKN', 6, null]], 'kept metadata still names the rows');
  // Another provider is another page: it keeps nothing of this one.
  const { provider: fresh, wire: freshWire } = bridgeProvider(budgetAnswer, PRODUCTION_READS);
  await settled(fresh, () => fresh.ensure());
  assert.deepEqual(freshWire(), ['GET capabilities', ...LEAN_WIRE]);
});

test('G1: with pool-metrics listed, each row reads it after its market and token reads, and qualified figures take precedence, LP fees and time-weighted TVL included', async () => {
  const { provider, bridge, wire } = bridgeProvider(storeAnswer(), [...PRODUCTION_READS, 'pool-metrics']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.problems.length], ['ready', 0]);
  assert.deepEqual(wire(), ['GET capabilities', ...LEAN_WIRE, 'POST pool-metrics', 'POST pool-metrics']);
  assert.deepEqual(bridge.wire.filter((r) => r.path.endsWith('/pool-metrics')).map((r) => r.body), BUDGET_IDS.map((poolId) => ({ poolId })));
  const valuation = JSON.parse(text(gateway('pool-metrics.qualified'))).valuation;
  for (const row of state.result.markets) {
    assert.deepEqual([row.tvlUsd, row.volume24hUsd, row.feeAprPercent, row.lpFees24hUsd, row.timeWeightedTvlUsd].map((m) => [m.state, m.value]), [
      ['qualified', valuation.tvlUsd],
      ['qualified', valuation.grossInputVolumeUsd],
      ['qualified', valuation.feeAprPercent],
      ['qualified', valuation.tradingLpFeesUsd],
      ['qualified', valuation.timeWeightedAverageTvlUsd],
    ]);
    assert.deepEqual(row.provenance.metrics, { freshness: 'fresh', ageSeconds: 10 });
  }
  // A retained qualified row is stale, every Domino figure with it.
  const retained = built('marketsProvider').retainAsStale(state.result, 5_000_000).markets[0];
  assert.deepEqual([retained.lpFees24hUsd.state, retained.timeWeightedTvlUsd.state, retained.feeAprPercent.state], ['stale', 'stale', 'stale']);
});

test('G1: a pool-metrics read that fails keeps the provider figures and says why in the row only; busy is asked again with the table; switched off is as if not listed', async () => {
  const unavailable = { status: 503, text: '{"error":"upstream_unavailable"}' };
  const { provider, wire } = bridgeProvider(storeAnswer({ metrics: (poolId) => (poolId === POOL_A ? unavailable : json200(metricsFor(poolId, 'unqualified'))) }), [...PRODUCTION_READS, 'pool-metrics']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.problems], ['ready', []], 'a failed history read is no problem of the table');
  assert.deepEqual(wire().slice(-2), ['POST pool-metrics', 'POST pool-metrics']);
  const [failed, unqualified] = state.result.markets;
  assert.deepEqual([failed.tvlUsd.state, failed.volume24hUsd.state, failed.feeAprPercent.state, failed.feeAprPercent.reason, failed.lpFees24hUsd.state, failed.provenance.metrics], ['provider', 'provider', 'unavailable', 'unavailable', 'unavailable', null]);
  assert.deepEqual([unqualified.tvlUsd.state, unqualified.feeAprPercent.state, unqualified.feeAprPercent.reason, unqualified.provenance.metrics], ['provider', 'unavailable', 'qualified_usd_prices_required', { freshness: 'fresh', ageSeconds: 10 }]);

  const busy = bridgeProvider(storeAnswer({ metrics: (poolId) => (poolId === POOL_A ? { status: 429, text: '{"error":"read_capacity_busy"}' } : undefined) }), [...PRODUCTION_READS, 'pool-metrics']);
  const busyState = await settled(busy.provider, () => busy.provider.ensure());
  assert.deepEqual(busyState.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state]), [[POOL_A, 'pool-metrics', 'busy']], 'busy after R-1: the one failure the table asks again on its own');

  const off = bridgeProvider(storeAnswer({ metrics: () => ({ status: 404, text: '{"error":"route_not_available"}' }) }), [...PRODUCTION_READS, 'pool-metrics']);
  const offState = await settled(off.provider, () => off.provider.ensure());
  assert.deepEqual(off.wire().filter((line) => line === 'POST pool-metrics'), ['POST pool-metrics'], 'switched off on the server: not asked for the next row');
  assert.deepEqual([offState.problems, offState.result.markets.map((m) => m.provenance.metrics)], [[], ['not_requested', 'not_requested']]);
});

test('G1 and G2 together: stored rows read their pool-metrics too, and a bare load asks for neither even when both are listed', async () => {
  const { provider, wire } = bridgeProvider(storeAnswer(), [...PRODUCTION_READS, 'markets-snapshot', 'pool-metrics']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual(wire(), ['GET capabilities', 'POST markets-snapshot', 'POST token', 'POST token', 'POST token', 'POST pool-metrics', 'POST pool-metrics']);
  assert.deepEqual(state.result.markets.map((m) => [m.provenance.origin, m.tvlUsd.state, m.feeAprPercent.state]), [['markets-snapshot', 'qualified', 'qualified'], ['markets-snapshot', 'qualified', 'qualified']]);
  const bare = stubBridge(budgetAnswer, { capabilities: capabilitiesListing([...PRODUCTION_READS, 'markets-snapshot', 'pool-metrics']) });
  const clock = fakeClock();
  await loadSelectedPools(createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: bare.fetch, clock }), { clock }), BUDGET_IDS);
  assert.deepEqual(bare.wire.map((r) => `${r.method} ${r.path.replace('/api/read/v1/', '')}`), ['GET capabilities', ...LEAN_WIRE]);
});

// ---------------------------------------------------------------------------
// What one read may take down: only an answer about the page stops a load, a
// read never shortens the table, and a load nobody waits for is cancelled
// only after a grace period (review 2026-09-14, read layer).
// ---------------------------------------------------------------------------

/** The read service's 429, with no Retry-After: a wait of 1 s. */
const BUSY_429 = { status: 429, text: '{"error":"read_capacity_busy"}' };

test('G1: a pool-metrics answer that is incompatible, or anything else not about the page, stays on its row; only a page-wide answer stops the load', async () => {
  // The Worker's or the gateway's refusal of one route's payload (bridge/src/worker.mjs, backend/read_gateway.py).
  const mismatch = { status: 502, text: '{"error":"upstream_contract_mismatch"}' };
  const { provider, wire } = bridgeProvider(storeAnswer({ metrics: (poolId) => (poolId === POOL_A ? mismatch : undefined) }), [...PRODUCTION_READS, 'pool-metrics']);
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.problems], ['ready', []], 'one row’s history refused is no problem of the table');
  assert.deepEqual(wire().slice(-2), ['POST pool-metrics', 'POST pool-metrics'], 'and the next row’s history is still read');
  const [refused, qualified] = state.result.markets;
  assert.deepEqual(
    [refused.poolId, refused.tvlUsd.state, refused.feeAprPercent.state, refused.feeAprPercent.reason, refused.provenance.metrics],
    [POOL_A, 'provider', 'unavailable', 'incompatible', null],
    'the provider’s figures stay, and the row says why it has no history',
  );
  assert.deepEqual([qualified.poolId, qualified.tvlUsd.state, qualified.feeAprPercent.state], [POOL_Z, 'qualified', 'qualified']);

  // A token whose payload was refused the same way is its rows' problem too, never the table's.
  const tokenRefused = bridgeProvider(storeAnswer({ token: (address) => (address === TOKEN_Z ? mismatch : undefined) }), PRODUCTION_READS);
  const tokenState = await settled(tokenRefused.provider, () => tokenRefused.provider.ensure());
  assert.deepEqual(
    [tokenState.phase, tokenState.result.markets.length, tokenState.problems.map((p) => [p.poolId, p.token, p.outcome.state])],
    ['ready', 2, [[POOL_Z, TOKEN_Z, 'incompatible']]],
  );

  // The gate is about the page: met at any read, it stops the load there.
  const gate = { status: 401, text: '{"error":"beta_access_required"}' };
  const gated = bridgeProvider(storeAnswer({ metrics: (poolId) => (poolId === POOL_Z ? gate : undefined) }), [...PRODUCTION_READS, 'pool-metrics']);
  const gatedState = await settled(gated.provider, () => gated.provider.ensure());
  assert.deepEqual([gatedState.phase, gatedState.failure.route, gatedState.failure.state], ['failed', 'pool-metrics', 'gate_required']);
});

test('one pool whose market payload a hop refuses (502 upstream_contract_mismatch) is that row’s problem; a contract header the page does not accept still stops the table', async () => {
  const mismatch = { status: 502, text: '{"error":"upstream_contract_mismatch"}' };
  const { provider, wire } = bridgeProvider(storeAnswer({ market: (poolId) => (poolId === POOL_A ? mismatch : undefined) }), PRODUCTION_READS);
  const state = await settled(provider, () => provider.ensure());
  assert.equal(state.phase, 'ready', 'the other pool still makes a table');
  assert.deepEqual(state.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state, p.outcome.reason]), [[POOL_A, 'pool-market', 'incompatible', 'upstream_contract_mismatch']]);
  assert.deepEqual(state.result.markets.map((m) => m.poolId), [POOL_Z], 'the refused pool has no row of its own, and the next pool is read');
  assert.equal(wire().filter((line) => line === 'POST pool-market').length, 2, 'the load went on past the refused pool');
  // Only that one reason is the row's: every other incompatible answer, and every page-wide one, still stops the table.
  const { stopsTable } = built('marketsProvider');
  const base = { route: 'pool-market', provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 } };
  assert.equal(stopsTable({ ...base, state: 'incompatible', reason: 'upstream_contract_mismatch' }), false);
  assert.equal(stopsTable({ ...base, state: 'incompatible', reason: 'contract_version_not_accepted' }), true);
  assert.equal(stopsTable({ ...base, state: 'incompatible', reason: 'contract_header_missing' }), true);
  assert.equal(stopsTable({ ...base, state: 'gate_required' }), true);
  assert.equal(stopsTable({ ...base, state: 'busy', retryAfterSeconds: 1 }), false);
});

test('a refresh never shortens the table: a pool whose read fails keeps its last good row in its place, stale and dated, beside the problem', async () => {
  let failing = null;
  const { provider } = bridgeProvider(storeAnswer({ market: (poolId) => (poolId === POOL_A ? (failing ?? undefined) : undefined) }), PRODUCTION_READS);
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual([first.phase, first.result.markets.map((m) => [m.poolId, m.tvlUsd.state])], ['ready', [[POOL_A, 'provider'], [POOL_Z, 'provider']]]);

  failing = BUSY_429;
  const busy = await settled(provider, () => provider.refresh());
  assert.equal(busy.phase, 'ready');
  assert.deepEqual(busy.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state]), [[POOL_A, 'pool-market', 'busy']]);
  const [kept, fresh] = busy.result.markets;
  assert.deepEqual(
    [kept.poolId, kept.tvlUsd.state, kept.tvlUsd.asOf, kept.volume24hUsd.state, kept.feeAprEstimate.retained],
    [POOL_A, 'stale', 1010, 'stale', true],
    'kept in its place, stale, dated to its own observation',
  );
  assert.equal(kept.provenance.market.receivedAt, first.result.markets[0].provenance.market.receivedAt, 'never made younger by being kept');
  assert.deepEqual([fresh.poolId, fresh.tvlUsd.state], [POOL_Z, 'provider']);

  failing = { status: 503, text: '{"error":"upstream_unavailable"}' };
  const unavailable = await settled(provider, () => provider.refresh());
  assert.deepEqual([unavailable.phase, unavailable.result.markets.map((m) => [m.poolId, m.tvlUsd.state])], ['ready', [[POOL_A, 'stale'], [POOL_Z, 'provider']]], 'failing again, for another reason: still there');
  assert.deepEqual(unavailable.problems.map((p) => [p.poolId, p.outcome.state]), [[POOL_A, 'unavailable']]);

  failing = null;
  const back = await settled(provider, () => provider.refresh());
  assert.deepEqual([back.problems, back.result.markets.map((m) => m.tvlUsd.state)], [[], ['provider', 'provider']], 'and current again once it reads');
});

/** A bridge whose POSTs wait until the test answers them, one at a time; `sent` logs each as it goes out. */
function heldBridge(answer) {
  const bridge = stubBridge(answer, { capabilities: capabilitiesListing(PRODUCTION_READS) });
  const waiting = [];
  const sent = [];
  const fetch = async (path, init) => {
    if (init.method === 'POST') {
      sent.push(path.replace('/api/read/v1/', ''));
      await new Promise((go) => waiting.push(go));
    }
    return bridge.fetch(path, init);
  };
  return { fetch, sent, waiting, answerNext: () => waiting.shift()?.() };
}

test('Home to Markets: a viewer who comes within the grace period joins the running load; past it, the load is cancelled and the next viewer starts it again', async () => {
  const clock = fakeClock();
  const held = heldBridge(budgetAnswer);
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: held.fetch, clock }), { clock });
  const provider = createReadMarketsProvider({ source, poolIds: BUDGET_IDS, kind: 'bridge', clock });

  const home = provider.subscribe(() => undefined);
  provider.ensure();
  await until(() => held.waiting.length === 1, 'pool A’s market read on the wire');
  held.answerNext();
  await until(() => provider.getSnapshot().previous?.markets.length === 1 && held.waiting.length === 1, 'pool A’s row on screen, its first token on the wire');
  // React runs Home's cleanup before Markets subscribes.
  home();
  clock.advance(LEAVE_GRACE_MS - 1);
  const markets = provider.subscribe(() => undefined);
  provider.ensure();
  clock.advance(10_000);
  assert.equal(provider.getSnapshot().previous?.markets.length, 1, 'Markets shows the row Home had');
  await until(() => (held.answerNext(), provider.getSnapshot().phase !== 'loading'), 'the joined load settles');
  const state = provider.getSnapshot();
  assert.deepEqual([state.phase, state.result.markets.length], ['ready', 2]);
  assert.deepEqual(held.sent, WIRE_ORDER, 'one load, joined, not started over');
  markets();

  // Past the grace period nobody came: cancelled, and the next viewer reads from the start.
  const second = heldBridge(budgetAnswer);
  const clock2 = fakeClock();
  const source2 = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: second.fetch, clock: clock2 }), { clock: clock2 });
  const provider2 = createReadMarketsProvider({ source: source2, poolIds: BUDGET_IDS, kind: 'bridge', clock: clock2 });
  const first = provider2.subscribe(() => undefined);
  provider2.ensure();
  await until(() => second.waiting.length === 1, 'the first read on the wire');
  first();
  clock2.advance(LEAVE_GRACE_MS);
  const next = provider2.subscribe(() => undefined);
  provider2.ensure();
  await until(() => second.sent.length === 2, 'asked again from the start');
  assert.deepEqual(second.sent, ['pool-market', 'pool-market']);
  await until(() => (second.answerNext(), provider2.getSnapshot().phase !== 'loading'), 'the new load settles');
  assert.equal(provider2.getSnapshot().result.markets.length, 2);
  next();
});

// ---------------------------------------------------------------------------
// Quiet re-asks (Home and Markets have no Retry): what a busy service refused,
// alone; a row whose provider was busy, after the fresh window. Bounded, with
// jitter, only while the page can be seen.
// ---------------------------------------------------------------------------

/** Lets reads the fake clock has made instant run to their end. */
async function drain() {
  for (let i = 0; i < 25; i++) await later();
}

/** The app's provider over the bridge on a fake clock, on a page whose visibility the test sets, holding quiet re-asks as Home does. */
function quietProvider(answer, enabledReads = PRODUCTION_READS, { wrap = (fetch) => fetch, refreshMs = 0 } = {}) {
  const bridge = stubBridge(answer, { capabilities: capabilitiesListing(enabledReads) });
  const clock = fakeClock();
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: wrap(bridge.fetch), clock }), { clock });
  const page = { hidden: false, listeners: new Set() };
  const visibility = { hidden: () => page.hidden, onChange: (listener) => (page.listeners.add(listener), () => page.listeners.delete(listener)) };
  const provider = createReadMarketsProvider({ source, poolIds: BUDGET_IDS, kind: 'bridge', clock, visibility, refreshMs });
  const phases = [];
  const viewer = provider.subscribe(() => phases.push(provider.getSnapshot().phase));
  const setHidden = (hidden) => {
    page.hidden = hidden;
    for (const listener of [...page.listeners]) listener();
  };
  const posts = () => bridge.wire.filter((r) => r.method === 'POST').map((r) => [r.path.replace('/api/read/v1/', ''), r.body.poolId ?? r.body.token]);
  return { provider, clock, posts, phases, setHidden, viewer };
}

test('visible successful rows refresh in place, pause while hidden or unmounted, and revalidate on the next visible visit', async () => {
  const { provider, clock, posts, phases, setHidden, viewer } = quietProvider(budgetAnswer, PRODUCTION_READS, { refreshMs: 60_000 });
  let release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  const mark = posts().length;
  phases.length = 0;
  clock.advance(59_999); await drain();
  assert.equal(posts().length, mark);
  clock.advance(1); await drain();
  assert.deepEqual(posts().slice(mark), [['pool-market', POOL_A], ['pool-market', POOL_Z]], 'fresh metadata is reused and only pool figures are revalidated');
  assert.equal(phases.includes('loading'), false, 'background revalidation keeps usable rows visible');
  assert.notEqual(provider.getSnapshot().result.markets[0].provenance.market.receivedAt, first.result.markets[0].provenance.market.receivedAt);
  setHidden(true);
  const hiddenMark = posts().length;
  clock.advance(60_000); await drain();
  assert.equal(posts().length, hiddenMark, 'hidden pages do not ask');
  setHidden(false); clock.advance(0); await drain();
  assert.equal(posts().length, hiddenMark + 2, 'one refresh after becoming visible, without catching up missed intervals');
  release(); viewer();
  const awayMark = posts().length;
  clock.advance(600_000); await drain();
  assert.equal(posts().length, awayMark, 'no mounted holder means no polling');
  const back = provider.subscribe(() => undefined);
  provider.ensure(); release = provider.recoverQuietly();
  clock.advance(0); await drain();
  assert.deepEqual(posts().slice(awayMark).map(([route]) => route), WIRE_ORDER, 'expired metadata is read again on the next visit');
  release(); back();
});

test('leaving or hiding during successful refresh aborts it and the next visible visit still revalidates', async () => {
  for (const reason of ['hidden', 'unmounted']) {
    let hang = false;
    const attempted = [];
    const wrap = (fetch) => async (path, init) => {
      if (hang && init.method === 'POST') {
        attempted.push(init.signal);
        await new Promise(() => undefined);
      }
      return fetch(path, init);
    };
    const { provider, clock, posts, setHidden, viewer } = quietProvider(budgetAnswer, PRODUCTION_READS, { refreshMs: 60_000, wrap });
    let release = provider.recoverQuietly();
    const first = await settled(provider, () => provider.ensure());
    const mark = posts().length;
    hang = true; clock.advance(60_000); await drain();
    assert.equal(attempted.length, 1);
    if (reason === 'hidden') setHidden(true);
    else { release(); viewer(); clock.advance(LEAVE_GRACE_MS); }
    await drain();
    assert.equal(attempted[0].aborted, true, reason);
    assert.equal(provider.getSnapshot(), first, 'an abandoned refresh does not renew the old observations');
    hang = false;
    let back = viewer;
    if (reason === 'hidden') setHidden(false);
    else { back = provider.subscribe(() => undefined); provider.ensure(); release = provider.recoverQuietly(); }
    clock.advance(0); await drain();
    assert.equal(posts().length, mark + 2, 'revalidation was not lost with the cancelled read');
    release(); back();
  }
});

test('public metadata cache coalesces canonical addresses, preserves observation age, expires, and isolates source instances', async () => {
  const clock = fakeClock();
  const address = `0x${'ab'.repeat(20)}`;
  const fixture = fixtures({ token: [{ fixture: gateway('token.success'), mutate: (data) => ({ ...data, asset: { ...data.asset, address } }) }] }, { clock });
  const source = createPublicMetadataCache(createScheduledSource(fixture, { clock }), clock);
  const [first, joined] = await Promise.all([source.read('token', { token: address.toUpperCase().replace('0X', '0x') }), source.read('token', { token: address })]);
  assert.equal(first.state, 'ok'); assert.equal(joined.state, 'ok');
  assert.equal(fixture.requests.length, 1, 'canonical equivalent requests share the scheduled flight');
  clock.advance(10_000);
  const cached = await source.read('token', { token: address }, { deadlineAt: clock.monotonic() + 1000 });
  assert.equal(fixture.requests.length, 1);
  assert.equal(cached.provenance.receivedAt, first.provenance.receivedAt);
  assert.equal(cached.provenance.receivedMonotonic, first.provenance.receivedMonotonic);
  assert.equal(cached.provenance.attempts, 0);
  assert.equal(cached.provenance.deadlineAt, clock.monotonic() + 1000);
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await source.read('token', { token: address }, { signal: stopped.signal })).state, 'aborted');
  assert.equal((await source.read('token', { token: address }, { deadlineAt: clock.monotonic() })).state, 'unavailable');
  const other = createPublicMetadataCache(fixture, clock);
  await other.read('token', { token: address });
  assert.equal(fixture.requests.length, 2, 'another origin/source has a separate cache');
  clock.advance(TOKEN_METADATA_CACHE_MS - 10_000);
  const refreshed = await source.read('token', { token: address });
  assert.equal(fixture.requests.length, 3);
  assert.ok(refreshed.provenance.receivedMonotonic > first.provenance.receivedMonotonic);
});

test('public metadata cache never caches partial metadata or private reads, and clears public entries after a gate failure', async () => {
  const clock = fakeClock();
  const fixture = fixtures({
    token: [{ fixture: gateway('token.missing-decimals') }, { fixture: gateway('token.success') }],
    'pool-market': [{ transport: 'gate401' }],
    'wallet-assets': [{ fixture: gateway('wallet-assets.success') }],
  }, { clock });
  const source = createPublicMetadataCache(fixture, clock);
  const first = await source.read('token', tokenRequest);
  assert.notEqual(first.data.asset.readStatus, 'available');
  assert.equal((await source.read('token', tokenRequest)).data.asset.readStatus, 'available');
  await source.read('token', tokenRequest);
  assert.equal(fixture.requests.filter((r) => r.route === 'token').length, 2);
  assert.equal((await source.read('pool-market', requestFor(catalog, 'pool-market'))).state, 'gate_required');
  await source.read('token', tokenRequest);
  assert.equal(fixture.requests.filter((r) => r.route === 'token').length, 3, 'the gate invalidated earlier public cache entries');
  await source.read('wallet-assets', requestFor(catalog, 'wallet-assets'));
  await source.read('wallet-assets', requestFor(catalog, 'wallet-assets'));
  assert.equal(fixture.requests.filter((r) => r.route === 'wallet-assets').length, 2);
});

test('quiet re-ask: a token still busy after R-1 is asked again on its own once its wait has passed, that token alone, and the rows complete in place', async () => {
  let busy = true;
  const { provider, clock, posts, phases, viewer } = quietProvider(storeAnswer({ token: (address) => (address === TOKEN_Z && busy ? BUSY_429 : undefined) }));
  const release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual(first.problems.map((p) => [p.poolId, p.token, p.outcome.route, p.outcome.state]), [[POOL_Z, TOKEN_Z, 'token', 'busy']]);
  assert.equal(first.result.markets[1].tokens.quote.decimals, null, 'the row is there, without the busy token’s decimals');
  await drain();
  const mark = posts().length;
  phases.length = 0;
  busy = false;
  // The service asked for 1 s; the table waits 4 s at the least, drawn within ±25%: here the low end, 3 s.
  clock.advance(busyRecoveryDelayMs(1, 0, () => 0) - 1);
  await drain();
  assert.equal(posts().length, mark, 'not a moment before its wait');
  clock.advance(1);
  await until(() => provider.getSnapshot().phase === 'ready' && provider.getSnapshot().problems.length === 0, 'the re-ask settles');
  assert.deepEqual(posts().slice(mark), [['token', TOKEN_Z]], 'that token alone: no market read, no other token');
  assert.deepEqual(provider.getSnapshot().result.markets.map((m) => [m.poolId, m.tokens.quote.symbol, m.tokens.quote.decimals]), [[POOL_A, 'TKN', 6], [POOL_Z, 'TKN', 6]]);
  assert.equal(phases.includes('loading'), false, 'the rows on screen never went back to loading');
  clock.advance(3_600_000);
  await drain();
  assert.deepEqual(posts().slice(mark), [['token', TOKEN_Z]], 'and nothing more once nothing is busy');
  release();
  viewer();
});

test('quiet re-ask: a busy pool-metrics read is asked again alone and never refreshes the table; a busy market read brings its row, its token and its history', async () => {
  let metricsBusy = true;
  const history = quietProvider(storeAnswer({ metrics: (poolId) => (poolId === POOL_A && metricsBusy ? BUSY_429 : undefined) }), [...PRODUCTION_READS, 'pool-metrics']);
  const holdHistory = history.provider.recoverQuietly();
  const first = await settled(history.provider, () => history.provider.ensure());
  assert.deepEqual(first.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state]), [[POOL_A, 'pool-metrics', 'busy']]);
  assert.deepEqual([first.result.markets[0].tvlUsd.state, first.result.markets[0].feeAprPercent.reason], ['provider', 'busy']);
  await drain();
  const mark = history.posts().length;
  metricsBusy = false;
  history.clock.advance(busyRecoveryDelayMs(1, 0, () => 0));
  await until(() => history.provider.getSnapshot().problems?.length === 0, 'the history read settles');
  assert.deepEqual(history.posts().slice(mark), [['pool-metrics', POOL_A]], 'that read alone: no market read, no other history');
  assert.deepEqual(history.provider.getSnapshot().result.markets.map((m) => [m.tvlUsd.state, m.feeAprPercent.state]), [['qualified', 'qualified'], ['qualified', 'qualified']]);
  holdHistory();
  history.viewer();

  let marketBusy = true;
  const market = quietProvider(storeAnswer({ market: (poolId) => (poolId === POOL_Z && marketBusy ? BUSY_429 : undefined) }), [...PRODUCTION_READS, 'pool-metrics']);
  const holdMarket = market.provider.recoverQuietly();
  const lean = await settled(market.provider, () => market.provider.ensure());
  assert.deepEqual([lean.result.markets.map((m) => m.poolId), lean.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state])], [[POOL_A], [[POOL_Z, 'pool-market', 'busy']]]);
  assert.deepEqual(market.posts().map(([route]) => route), ['pool-market', 'token', 'token', 'pool-market', 'pool-market', 'pool-market', 'pool-metrics'], 'the busy pool has no tokens read and no history');
  await drain();
  const before = market.posts().length;
  marketBusy = false;
  market.clock.advance(busyRecoveryDelayMs(1, 0, () => 0));
  await until(() => market.provider.getSnapshot().problems?.length === 0 && market.provider.getSnapshot().result.markets.length === 2, 'the row comes back');
  assert.deepEqual(market.posts().slice(before), [['pool-market', POOL_Z], ['token', TOKEN_Z], ['pool-metrics', POOL_Z]], 'that pool’s market, the token it still needs, and its history');
  holdMarket();
  market.viewer();
});

test('a quiet re-ask nobody waits for any more is cancelled after the grace period, as if it had not run; the next visit asks again and loads nothing else', async () => {
  let hang = false;
  const sent = [];
  const hold = (fetch) => async (path, init) => {
    if (init.method === 'POST') sent.push(path.replace('/api/read/v1/', ''));
    if (hang && init.method === 'POST' && path.endsWith('/token')) await new Promise(() => undefined);
    return fetch(path, init);
  };
  let busy = true;
  const { provider, clock, posts, viewer } = quietProvider(storeAnswer({ token: (address) => (address === TOKEN_Z && busy ? BUSY_429 : undefined) }), PRODUCTION_READS, { wrap: hold });
  let release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  await drain();
  const mark = posts().length;
  const sentMark = sent.length;
  hang = true;
  busy = false;
  clock.advance(busyRecoveryDelayMs(1, 0, () => 0));
  await drain();
  // The re-ask's token read is on its way, and the visitor leaves: Home's table unmounts.
  assert.deepEqual(sent.slice(sentMark), ['token'], 'the re-ask is on the wire');
  assert.equal(provider.getSnapshot(), first, 'in place: nothing on screen moved while it ran');
  release();
  viewer();
  clock.advance(LEAVE_GRACE_MS);
  await drain();
  assert.equal(provider.getSnapshot(), first, 'cancelled, the settled rows and their problem stand as they were');

  // Back on Home: no load starts again, and the busy token is asked again on its own.
  hang = false;
  const back = provider.subscribe(() => undefined);
  provider.ensure();
  release = provider.recoverQuietly();
  clock.advance(busyRecoveryDelayMs(1, 0, () => 0));
  await until(() => provider.getSnapshot().problems?.length === 0, 'the re-ask of the next visit settles');
  assert.deepEqual(sent.slice(sentMark), ['token', 'token'], 'one re-ask a visit, and no load started over');
  assert.deepEqual(posts().slice(mark), [['token', TOKEN_Z]], 'the cancelled one never reached the bridge; the next visit’s is that token alone');
  assert.equal(provider.getSnapshot().result.markets[1].tokens.quote.decimals, 6);
  release();
  back();
});

test('quiet re-asks are bounded: four, at doubling waits within ±25% and never sooner than asked, none while the page is hidden, and a new visit has its own', async () => {
  assert.deepEqual([0, 1, 2, 3].map((attempt) => busyRecoveryDelayMs(1, attempt, () => 0)), [3_000, 6_000, 12_000, 24_000]);
  assert.deepEqual([0, 1, 2, 3].map((attempt) => busyRecoveryDelayMs(1, attempt, () => 1)), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(busyRecoveryDelayMs(7, 0, () => 0.5), 7_000, 'the service’s own wait when longer than 4 s');
  assert.equal(busyRecoveryDelayMs(60, 0, () => 0), 60_000, 'never sooner than the service asked');
  assert.equal(BUSY_RECOVERY_ATTEMPTS, 4);

  const { provider, clock, posts, setHidden, viewer } = quietProvider(storeAnswer({ market: (poolId) => (poolId === POOL_Z ? BUSY_429 : undefined) }));
  let release = provider.recoverQuietly();
  await settled(provider, () => provider.ensure());
  await drain();
  const reads = () => posts().filter(([route, id]) => route === 'pool-market' && id === POOL_Z).length;
  assert.equal(reads(), 3, 'R-1: three attempts on the load');
  const reask = async (label) => {
    await until(() => reads() % 3 === 0 && reads() > 0 && provider.getSnapshot().phase === 'ready', label);
    await drain();
  };

  clock.advance(2_999);
  await drain();
  assert.equal(reads(), 3, 'the first not before 3 s');
  clock.advance(1);
  await until(() => reads() === 6, 're-ask 1');
  await reask('re-ask 1 settles');

  setHidden(true);
  clock.advance(600_000);
  await drain();
  assert.equal(reads(), 6, 'nothing while the page is hidden');
  setHidden(false);
  await until(() => reads() === 9, 're-ask 2, as soon as the page is seen');
  await reask('re-ask 2 settles');

  clock.advance(11_999);
  await drain();
  assert.equal(reads(), 9, 'the third not before 12 s');
  clock.advance(1);
  await until(() => reads() === 12, 're-ask 3');
  await reask('re-ask 3 settles');
  clock.advance(24_000);
  await until(() => reads() === 15, 're-ask 4');
  await reask('re-ask 4 settles');
  clock.advance(3_600_000);
  await drain();
  assert.equal(reads(), 15, 'four re-asks a visit, and no more');
  assert.equal(provider.getSnapshot().result.markets.length, 1, 'the rows on screen all along');

  release();
  release = provider.recoverQuietly();
  clock.advance(3_000);
  await until(() => reads() === 18, 'a new visit asks again');
  await reask('the new visit’s re-ask settles');
  release();
  viewer();
});

test('a row whose provider figures were unavailable because the provider was busy is read again after the 60 s fresh window: that pool alone, three times a visit, only while visible', async () => {
  assert.deepEqual([providerBusyDelayMs(() => 0), providerBusyDelayMs(() => 1)], [60_000, 75_000]);
  assert.equal(PROVIDER_BUSY_ATTEMPTS, 3);
  let providerBusy = true;
  const busyMarket = (poolId) => {
    const body = marketFor(poolId, BUDGET_POOLS[poolId]);
    body.market = { status: 'unavailable', reason: 'provider_capacity_busy', data: null, cache: { ...body.market.cache, status: 'rate_limited', ageSeconds: null } };
    return json200(body);
  };
  const { provider, clock, posts, phases, setHidden, viewer } = quietProvider(storeAnswer({ market: (poolId) => (poolId === POOL_Z && providerBusy ? busyMarket(poolId) : undefined) }));
  let release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual([first.problems, first.result.markets[1].tvlUsd.state, first.result.markets[1].tvlUsd.reason], [[], 'unavailable', 'provider_capacity_busy']);
  await drain();
  const reads = () => posts().filter(([route, id]) => route === 'pool-market' && id === POOL_Z).length;
  const mark = posts().length;
  phases.length = 0;

  clock.advance(59_999);
  await drain();
  assert.equal(posts().length, mark, 'not inside the read service’s fresh window');
  clock.advance(1);
  await until(() => reads() === 2, 're-read 1');
  await drain();
  assert.deepEqual(posts().slice(mark), [['pool-market', POOL_Z]], 'that pool’s market read alone: its tokens are kept');
  assert.equal(phases.includes('loading'), false, 'in place: the rows never went back to loading');

  setHidden(true);
  clock.advance(600_000);
  await drain();
  assert.equal(reads(), 2, 'not while the page is hidden');
  setHidden(false);
  await until(() => reads() === 3, 're-read 2, once the page is seen');
  await drain();
  clock.advance(60_000);
  await until(() => reads() === 4, 're-read 3');
  await drain();
  clock.advance(3_600_000);
  await drain();
  assert.equal(reads(), 4, 'three re-reads a visit, and no more');

  // A new visit asks again; figures that come back end it.
  release();
  release = provider.recoverQuietly();
  providerBusy = false;
  clock.advance(60_000);
  await until(() => provider.getSnapshot().result?.markets[1].tvlUsd.state === 'provider', 'the figures come back');
  await drain();
  clock.advance(3_600_000);
  await drain();
  assert.equal(reads(), 5);
  release();
  viewer();
});

// ---------------------------------------------------------------------------
// A hop's refusal (502 upstream_contract_mismatch). The dev and production
// gateways on 85e7511 do not stamp their mid-hop failures, so a hop that is
// only flapping reaches the app this way: at the capabilities GET a read waits
// for as at the read itself (qa-final, 2026-09-15). It stops no table and is
// asked again quietly, bounded, like a busy answer.
// ---------------------------------------------------------------------------

const HOP_REFUSAL = '{"error":"upstream_contract_mismatch"}';

/** The bridge's capabilities GET, refused by a hop whenever `refused()` says so; `gets` has each GET's status, in order. */
const refusingCapabilities = (refused, gets) => (fetch) => async (path, init) => {
  if (init.method !== 'GET') return fetch(path, init);
  const refusing = refused();
  gets.push(refusing ? 502 : 200);
  return refusing ? bridgeResponse(502, HOP_REFUSAL) : fetch(path, init);
};

test('a hop refusing the capabilities GET the snapshot’s check makes is the snapshot not listed: the pools’ own reads ask the capabilities again, and the table fills in the same load', async () => {
  let refusals = 1;
  const gets = [];
  const { provider, posts, viewer } = quietProvider(budgetAnswer, PRODUCTION_READS, { wrap: refusingCapabilities(() => refusals-- > 0, gets) });
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.result.markets.map((m) => m.poolId), state.problems], ['ready', BUDGET_IDS, []], 'no failure, and no reload');
  assert.deepEqual(gets, [502, 200], 'the check met the refusal; the first pool’s read asked again, and that answer is kept for every read after it');
  assert.deepEqual(posts().map(([route]) => route), WIRE_ORDER, 'then the lean load, as if nothing had been refused');
  // A contract header this page does not accept is still about the page: at the same check, it ends the load there.
  const wire = [];
  const rc2 = (fetch) => async (path, init) => (wire.push(init.method), init.method === 'GET' ? bridgeResponse(200, JSON.stringify(capabilitiesListing(PRODUCTION_READS)), { 'X-Domino-Read-Contract': '1.1.0-rc.2' }) : fetch(path, init));
  const stopped = quietProvider(budgetAnswer, PRODUCTION_READS, { wrap: rc2 });
  const failed = await settled(stopped.provider, () => stopped.provider.ensure());
  assert.deepEqual([failed.phase, failed.failure.route, failed.failure.state, failed.failure.reason], ['failed', 'pool-market', 'incompatible', 'contract_version_not_accepted']);
  assert.deepEqual(wire, ['GET'], 'one GET, and no read after it');
  viewer();
  stopped.viewer();
});

test('a first load that met nothing but a hop refusing the capabilities GET is asked again on its own once the wait has passed, and the table fills without a reload', async () => {
  let refusing = true;
  const gets = [];
  const { provider, clock, posts, viewer } = quietProvider(budgetAnswer, PRODUCTION_READS, { wrap: refusingCapabilities(() => refusing, gets) });
  const release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual([first.phase, first.failure.route, first.failure.state, first.failure.reason, first.retained], ['failed', 'pool-market', 'incompatible', 'upstream_contract_mismatch', null]);
  assert.deepEqual(gets, [502, 502, 502], 'the snapshot’s check, then each pool’s own read, asked the capabilities afresh');
  assert.deepEqual(posts(), [], 'nothing was posted');
  await drain();
  refusing = false;
  // A hop names no wait: 4 s at the least, drawn within ±25%: here the low end, 3 s.
  clock.advance(busyRecoveryDelayMs(0, 0, () => 0) - 1);
  await drain();
  assert.equal(gets.length, 3, 'not a moment before its wait');
  clock.advance(1);
  await until(() => provider.getSnapshot().phase === 'ready', 'the pools are asked again, and answer');
  const state = provider.getSnapshot();
  assert.deepEqual([state.result.markets.map((m) => m.poolId), state.problems], [BUDGET_IDS, []]);
  assert.deepEqual(gets, [502, 502, 502, 200], 'one capabilities GET more, kept for the reads after it');
  assert.deepEqual(posts().map(([route]) => route), WIRE_ORDER, 'the lean reads of both pools, each row’s tokens right after it');
  clock.advance(3_600_000);
  await drain();
  assert.deepEqual([gets.length, posts().length], [4, WIRE_ORDER.length], 'and nothing more once the rows are there');
  release();
  viewer();
});

test('a hop that keeps refusing the capabilities GET is asked again four times a visit, at doubling waits, none while the page is hidden, and then no more; a new visit has its own', async () => {
  const gets = [];
  const { provider, clock, posts, setHidden, viewer } = quietProvider(budgetAnswer, PRODUCTION_READS, { wrap: refusingCapabilities(() => true, gets) });
  let release = provider.recoverQuietly();
  await settled(provider, () => provider.ensure());
  await drain();
  assert.equal(gets.length, 3, 'the load: the snapshot’s check and each pool’s read');
  // Each re-ask reads both pools again, and each read asks the capabilities again.
  const reask = async (count, label) => {
    await until(() => gets.length === count && provider.getSnapshot().phase === 'failed', label);
    await drain();
  };

  clock.advance(2_999);
  await drain();
  assert.equal(gets.length, 3, 'the first not before 3 s');
  clock.advance(1);
  await reask(5, 're-ask 1');

  setHidden(true);
  clock.advance(600_000);
  await drain();
  assert.equal(gets.length, 5, 'nothing while the page is hidden');
  setHidden(false);
  await reask(7, 're-ask 2, as soon as the page is seen');

  clock.advance(11_999);
  await drain();
  assert.equal(gets.length, 7, 'the third not before 12 s');
  clock.advance(1);
  await reask(9, 're-ask 3');
  clock.advance(24_000);
  await reask(11, 're-ask 4');
  clock.advance(3_600_000);
  await drain();
  assert.equal(gets.length, 11, 'four re-asks a visit, and no more');
  assert.deepEqual(posts(), [], 'nothing was ever posted');
  assert.deepEqual([provider.getSnapshot().phase, provider.getSnapshot().retained], ['failed', null], 'the table stood on the catalogue all along');

  release();
  release = provider.recoverQuietly();
  clock.advance(3_000);
  await reask(13, 'a new visit asks again');
  release();
  viewer();
});

test('one pool’s market read a hop refused is asked again on its own, that pool alone, and its row lands in place; a refusal is asked again, other failures are not', async () => {
  let refused = true;
  const { provider, clock, posts, phases, viewer } = quietProvider(storeAnswer({ market: (poolId) => (poolId === POOL_Z && refused ? { status: 502, text: HOP_REFUSAL } : undefined) }));
  const release = provider.recoverQuietly();
  const first = await settled(provider, () => provider.ensure());
  assert.deepEqual(
    [first.phase, first.result.markets.map((m) => m.poolId), first.problems.map((p) => [p.poolId, p.outcome.route, p.outcome.state, p.outcome.reason])],
    ['ready', [POOL_A], [[POOL_Z, 'pool-market', 'incompatible', 'upstream_contract_mismatch']]],
  );
  await drain();
  const mark = posts().length;
  phases.length = 0;
  refused = false;
  clock.advance(busyRecoveryDelayMs(0, 0, () => 0));
  await until(() => provider.getSnapshot().problems?.length === 0 && provider.getSnapshot().result.markets.length === 2, 'the refused pool’s row lands');
  assert.deepEqual(posts().slice(mark), [['pool-market', POOL_Z], ['token', TOKEN_Z]], 'that pool’s market read and the token its row still needs, nothing else');
  assert.equal(phases.includes('loading'), false, 'in place: the rows on screen never went back to loading');
  release();
  viewer();

  const { asksAgainQuietly } = built('marketsProvider');
  const base = { route: 'pool-market', provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 } };
  const asked = (outcome) => asksAgainQuietly({ ...base, ...outcome });
  assert.deepEqual(
    [
      asked({ state: 'busy', retryAfterSeconds: 1 }),
      asked({ state: 'incompatible', reason: 'upstream_contract_mismatch' }),
      asked({ state: 'incompatible', reason: 'contract_version_not_accepted' }),
      asked({ state: 'incompatible', reason: 'contract_header_missing' }),
      asked({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true }),
      asked({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_timeout', status: 504 }, retryable: true }),
      asked({ state: 'gate_unavailable' }),
    ],
    [true, true, false, false, false, false, false],
    'the table asks again what a busy service or a hop refused, and nothing a reload is for (release.browser (f), (k))',
  );
});

test('a first Home load of the six selected pools: 13 POSTs, each row’s tokens right after its market, none refused by a gateway keeping its own start interval and client budget', async () => {
  const { SELECTED_POOLS } = require('../.test-build/app/src/config/selectedPools.js');
  const { SELECTED_POOL_CATALOGUE, SELECTED_POOLS_COMMON_TOKEN: USDG } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');
  // Each pool in its currency order; the ETH/USDG row's catalogue entry carries no addresses: native ETH and USDG.
  const currencies = Object.fromEntries(SELECTED_POOL_CATALOGUE.map((entry) => [entry.poolId, entry.addresses ? [...entry.addresses].map((a) => a.toLowerCase()).sort() : [NATIVE, USDG]]));
  const clock = fakeClock();
  // The gateway (backend read_gateway.py and ClientBudgets): 1 s between accepted starts, then five at once and 30 a minute.
  let lastStart = -Infinity;
  let bucket = { tokens: 5, at: 0 };
  const wire = [];
  const fetch = async (path, init) => {
    if (init.method === 'GET') return bridgeResponse(200, JSON.stringify(capabilitiesListing(PRODUCTION_READS)));
    const route = path.replace('/api/read/v1/', '');
    const body = JSON.parse(init.body);
    const at = clock.monotonic();
    const tokens = Math.min(5, bucket.tokens + ((at - bucket.at) / 1000) * 0.5);
    const refused = at - lastStart < 1000 || tokens < 1;
    wire.push({ at, route, asked: body.poolId ?? body.token, status: refused ? 429 : 200 });
    if (refused) return bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': '2' });
    lastStart = at;
    bucket = { tokens: tokens - 1, at };
    return bridgeResponse(200, JSON.stringify(route === 'pool-market' ? marketFor(body.poolId, currencies[body.poolId]) : tokenFor(body.token, 'TKN')));
  };
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch, clock }), { clock });
  const provider = createReadMarketsProvider({ source, poolIds: SELECTED_POOLS, kind: 'bridge', clock });
  const state = await settled(provider, () => provider.ensure());
  assert.deepEqual([state.phase, state.result.markets.length, state.problems], ['ready', 6, []]);
  assert.deepEqual(wire.filter((request) => request.status === 429), [], 'not one 429');
  const seen = new Set();
  const expected = SELECTED_POOLS.flatMap((poolId) => [['pool-market', poolId], ...currencies[poolId].filter((token) => !seen.has(token) && seen.add(token)).map((token) => ['token', token])]);
  assert.deepEqual(wire.map((request) => [request.route, request.asked]), expected);
  assert.equal(wire.length, 13, 'six pools and the seven tokens between them, each once');
  const inAnyMinute = Math.max(...wire.map(({ at }) => wire.filter((other) => other.at >= at && other.at < at + 60_000).length));
  assert.ok(inAnyMinute <= 35, `${inAnyMinute} in a minute`);
});

// Changed on purpose 2026-10-04 (the owner's new embedded list): the original two of #45 (WETH/USDG 0.02% and
// USDG/MARLIN 5%) left the list with cbBTC/USDG and U/USDG. The six are the owner's, in the owner's order, ids only; the
// labels the file now carries are comments, and the check below names the new list's tokens too.
test('the six selected chain-4663 pools are the owner’s list of 2026-10-04, in its order, ids only, and exclude stock candidates', () => {
  const { SELECTED_POOLS } = require('../.test-build/app/src/config/selectedPools.js');
  assert.deepEqual(SELECTED_POOLS, [
    '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
    '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef',
    '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b',
    '0x6d56f66e52e63e8be558d708a987426314bb4de92bc9b43a44effee1f2abf317',
    '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c',
  ]);
  for (const id of SELECTED_POOLS) assert.match(id, /^0x[0-9a-f]{64}$/);
  const code = readFileSync(join(SRC, 'config/selectedPools.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /symbol|label|name|eth|usdg|marlin|pons|orbio|cashcat|ubik|virtual|tvl|volume|apr|price/i, 'no labels, symbols or figures');
  assert.deepEqual(code.match(/0x[0-9a-f]+/g), SELECTED_POOLS, 'nothing but pool ids');
});

// Changed on purpose (2026-09-26, featured pools v1 §11.1): poolListings takes the list on screen (the embedded list
// here, lib/read/featuredSource.ts in the app) instead of a flag, and null where a screen lists read rows alone.
test('the display catalogue has six immediate rows and no invented financial observations', () => {
  const { poolListings, SELECTED_POOL_CATALOGUE } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');
  const first = poolListings([], SELECTED_POOL_CATALOGUE);
  assert.equal(first.length, 6);
  assert.ok(first.every((row) => row.market === undefined));
  assert.ok(SELECTED_POOL_CATALOGUE.every((entry) => !/AAPL|SPY|GOOGL|NVDA|stock/i.test(entry.labels.join('/'))));
  for (const entry of SELECTED_POOL_CATALOGUE) {
    assert.deepEqual(Object.keys(entry).sort(), [...(entry.addresses ? ['addresses'] : []), 'artwork', 'fee', 'labels', 'poolId', 'sourceUrl']);
    if (entry.addresses) for (const address of entry.addresses) assert.match(address, /^0x[0-9a-f]{40}$/);
    assert.match(entry.sourceUrl, /^https:\/\/app\.uniswap\.org\/explore\/pools\/robinhood\/0x[0-9a-f]{64}$/);
  }
  // A read row names its tokens: its link names one of them (2026-09-26, `#/pool/<id>/<token>`).
  const observed = { poolId: first[2].poolId, tvlUsd: { value: '0', state: 'provider' }, tokens: { base: { address: `0x${'cc'.repeat(20)}` }, quote: { address: `0x${'5f'.repeat(20)}` } } };
  const merged = poolListings([observed], SELECTED_POOL_CATALOGUE);
  assert.equal(merged[2].market, observed);
  assert.equal(merged[2].token, `0x${'cc'.repeat(20)}`);
  assert.ok(first.every((row) => row.token === '0x5fc5360d0400a0fd4f2af552add042d716f1d168'), 'every embedded row links with USDG');
  assert.equal(merged.length, 6);
  assert.deepEqual(poolListings([], null), [], 'fixtures and unconfigured readers do not get catalogue rows');
});

// Changed on purpose 2026-10-01 (audit E21): a pair is named as its price is written, "TOKEN/USDG" beside "1 TOKEN = X
// USDG" (lib/read/orientation.ts), whatever the pool's own order; the catalogue row and the read row still agree.
test('a catalogue row names its pair as its price is written, so the name does not flip when its read lands', async () => {
  const { poolListings, inPoolOrder, catalogueTokenLabel, SELECTED_POOL_CATALOGUE } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');
  const { pricePair } = require('../.test-build/app/src/lib/read/orientation.js');
  const rows = poolListings([], SELECTED_POOL_CATALOGUE);
  // Changed on purpose 2026-10-04 (the owner's new embedded list): the six rows' names, and the third row (cbBTC/USDG
  // then, USDG/ORBIO now, inspected USDG first) is still the one whose read lands below.
  assert.deepEqual(rows.map(({ catalogue }) => catalogue.labels.join('/')), ['ETH/USDG', 'PONS/USDG', 'ORBIO/USDG', 'CASHCAT/USDG', 'UBIK/USDG', 'VIRTUAL/USDG']);
  for (const { poolId, catalogue } of rows) {
    if (!catalogue.addresses) continue;
    assert.equal(catalogue.addresses[1], '0x5fc5360d0400a0fd4f2af552add042d716f1d168', `${poolId}: USDG, the token prices are written in, comes second`);
    assert.deepEqual(catalogue.addresses.map((address) => catalogueTokenLabel(project.unreadToken(address))), [...catalogue.labels], `${poolId}: each label stays on its address`);
  }
  assert.deepEqual(rows[2].catalogue.artwork, [null, 'USDG'], 'artwork moves with its token');
  assert.deepEqual(SELECTED_POOL_CATALOGUE[2].labels, ['USDG', 'ORBIO'], 'the catalogue itself keeps the order it was inspected in');

  // The same pool once its market read lands: the row names currency0 first, exactly as the catalogue row did.
  const entry = SELECTED_POOL_CATALOGUE[2];
  const currencies = [...entry.addresses].sort();
  const rewrite = (body) => {
    body.poolId = entry.poolId;
    body.pool.poolId = entry.poolId;
    body.pool.currencies = currencies;
    body.pool.poolKey.currency0 = currencies[0];
    body.pool.poolKey.currency1 = currencies[1];
    Object.assign(body.market.data, { poolId: entry.poolId, currencies, baseToken: currencies[1], quoteToken: currencies[0] });
    return body;
  };
  const market = await fixtures({ 'pool-market': [{ fixture: gateway('pool-market.not-requested'), mutate: rewrite }] }, { clock: fakeClock() }).read('pool-market', tableMarketRequest(entry.poolId));
  assert.equal(market.state, 'ok');
  const live = project.projectMarketRow({ market, metrics: null, tokens: new Map() });
  const named = pricePair(live.tokens.base, live.tokens.quote);
  assert.equal([named.base, named.quote].map((token) => catalogueTokenLabel(token)).join('/'), rows[2].catalogue.labels.join('/'));
  // Changed on purpose 2026-10-04 (the owner's new embedded list): every row of the new list was inspected in its pool's
  // order, so none is listed the other way round as cbBTC/USDG was for USDG/cbBTC. The same pool listed that way moves
  // into its pool's order and still names its pair as its read does.
  const reversed = { ...entry, labels: [entry.labels[1], entry.labels[0]], artwork: [entry.artwork[1], entry.artwork[0]], addresses: [entry.addresses[1], entry.addresses[0]] };
  const pooled = inPoolOrder(reversed);
  assert.deepEqual([pooled.labels, pooled.artwork, pooled.addresses], [entry.labels, entry.artwork, entry.addresses], 'USDG, the lower address, first');
  assert.equal(poolListings([], [reversed])[0].catalogue.labels.join('/'), rows[2].catalogue.labels.join('/'), 'listed the other way round, the same name');
  assert.deepEqual(reversed.labels, ['ORBIO', 'USDG'], 'the listing itself is left as it was');

  // Native ETH, the zero address, sorts first; without both addresses nothing moves.
  const ZERO = `0x${'0'.repeat(40)}`;
  const usdg = entry.addresses[entry.labels.indexOf('USDG')];
  const native = inPoolOrder({ poolId: entry.poolId, labels: ['USDG', 'ETH'], artwork: ['USDG', 'ETH'], addresses: [usdg, ZERO], fee: '0.01%', sourceUrl: entry.sourceUrl });
  assert.deepEqual([native.labels, native.artwork, native.addresses], [['ETH', 'USDG'], ['ETH', 'USDG'], [ZERO, usdg]]);
  const unbound = SELECTED_POOL_CATALOGUE.find((item) => !item.addresses);
  assert.equal(inPoolOrder(unbound), unbound);
});

test('catalogue labels survive failed metadata without changing token identity or decimals', () => {
  const { catalogueTokenLabel } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');
  const pons = project.unreadToken('0x39dBED3a2bd333467115dE45665cC57F813C4571');
  assert.equal(catalogueTokenLabel(pons), 'PONS');
  assert.equal(pons.symbol, null);
  assert.equal(pons.decimals, null);
  assert.equal(catalogueTokenLabel({ ...pons, chainId: 1 }), null);
  assert.equal(catalogueTokenLabel({ ...pons, readStatus: 'no_contract' }), null);
  assert.equal(catalogueTokenLabel({ ...pons, symbol: 'Live metadata' }), null);
  assert.equal(catalogueTokenLabel(project.unreadToken(FIXTURE_TOKEN)), null);
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

test('one screen’s reads start at least 1.1 s apart, coalesce, and cap the queue', async () => {
  const clock = fakeClock();
  const starts = [];
  const release = [];
  const inner = {
    transport: 'bridge',
    read: (route, request, { signal }) =>
      new Promise((resolve) => {
        starts.push([clock.now(), route]);
        signal.addEventListener('abort', () => resolve({ route, state: 'aborted', provenance: {} }), { once: true });
        release.push(() => resolve({ route, state: 'ok', data: { n: starts.length }, provenance: {} }));
      }),
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));
  const source = createScheduledSource(inner, { clock, maxPending: 3 });
  const a = source.read('token', { token: NATIVE });
  const again = source.read('token', { token: NATIVE });
  const b = source.read('token', { token: FIXTURE_TOKEN });
  const c = source.read('pool-metrics', { poolId: FIXTURE_POOL });
  const refused = await source.read('pool-activity', { poolId: FIXTURE_POOL });
  assert.deepEqual([refused.state, refused.cause.kind], ['unavailable', 'queue_full'], 'a read past the cap is refused, not queued');
  await tick();
  release.shift()();
  const [first, joined] = await Promise.all([a, again]);
  assert.equal(first.state, 'ok');
  assert.equal(joined, first, 'an identical read joins the one in flight');
  await tick();
  release.shift()();
  await b;
  await tick();
  release.shift()();
  await c;
  assert.deepEqual(starts, [[0, 'token'], [1100, 'token'], [2200, 'pool-metrics']], 'one start per 1.1 s, one request for the two identical reads');

  const controller = new AbortController();
  const lonely = source.read('pools', { token: FIXTURE_TOKEN }, { signal: controller.signal });
  await tick();
  controller.abort();
  assert.equal((await lonely).state, 'aborted', 'the last one to stop waiting cancels the read');
});

/** A bridge reply as fetch would hand it over. */
const bridgeResponse = (status, body, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3, ...headers } });

test('R-1 keeps the pacing: the read after an automatic retry starts 1.1 s after that retry', async () => {
  const clock = fakeClock();
  const starts = [];
  let busy = true;
  const fetch = async (path, init) => {
    if (init.method === 'GET') return bridgeResponse(200, text(gateway('capabilities.live_read_only')));
    const route = path.slice('/api/read/v1/'.length);
    starts.push([clock.now(), route]);
    if (route === 'token' && busy) {
      busy = false;
      return bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': '1' });
    }
    return bridgeResponse(200, text(gateway(route === 'token' ? 'token.success' : 'pool-metrics.qualified')));
  };
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch, clock }), { clock, budget: null });
  const [token, metrics] = await Promise.all([source.read('token', tokenRequest), source.read('pool-metrics', { poolId: FIXTURE_POOL })]);
  assert.deepEqual([token.state, token.provenance.attempts, metrics.state], ['ok', 2, 'ok']);
  // The retry waits the bridge's Retry-After; the next read waits the queue's 1.1 s from that retry.
  assert.deepEqual(starts, [[0, 'token'], [1000, 'token'], [2100, 'pool-metrics']]);

  // Changed on purpose 2026-09-28 (speed wave, item 5): with the gateway's budget kept, a retry means the gateway
  // refused, so the budget is at one when the retry goes and spends it: the next read waits for a read and a quarter
  // to come back, 2.5 s, which covers the 1.1 s. It used to go at 2.1 s into a gateway that had just said it was full.
  const budgeted = fakeClock();
  const again = [];
  let refusing = true;
  const refusedOnce = async (path, init) => {
    if (init.method === 'GET') return bridgeResponse(200, text(gateway('capabilities.live_read_only')));
    const route = path.slice('/api/read/v1/'.length);
    again.push([budgeted.now(), route]);
    if (route === 'token' && refusing) {
      refusing = false;
      return bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': '1' });
    }
    return bridgeResponse(200, text(gateway(route === 'token' ? 'token.success' : 'pool-metrics.qualified')));
  };
  const counted = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch: refusedOnce, clock: budgeted }), { clock: budgeted });
  await Promise.all([counted.read('token', tokenRequest), counted.read('pool-metrics', { poolId: FIXTURE_POOL })]);
  assert.deepEqual(again, [[0, 'token'], [1000, 'token'], [3500, 'pool-metrics']]);
});

/** A source that answers at once, telling the queue of `attempts(request)` attempts on the wire, and logs when each read started. */
function instantSource(clock, { attempts = () => 1, answer = (route) => ({ route, state: 'ok', data: {}, provenance: {} }) } = {}) {
  const starts = [];
  return {
    starts,
    source: {
      transport: 'bridge',
      read: async (route, request, opts = {}) => {
        starts.push(clock.monotonic());
        for (let n = 0; n < attempts(request); n++) opts.onAttempt?.();
        return answer(route, request);
      },
    },
  };
}
const tokenAt = (i) => ({ token: `0x${(i + 1).toString(16).padStart(40, '0')}` });

test('the queue keeps the gateway’s budget for the tab: five at the 1.1 s pace, then 30 a minute, every attempt counted', async () => {
  const clock = fakeClock();
  const plain = instantSource(clock);
  const queue = createScheduledSource(plain.source, { clock });
  for (let i = 0; i < 14; i++) await queue.read('token', tokenAt(i));
  // Five spent at once and half a read back every second, a quarter of one kept in hand: nine at the 1.1 s pace,
  // then one every 2 s.
  assert.deepEqual(plain.starts, [0, 1100, 2200, 3300, 4400, 5500, 6600, 7700, 8800, 10_500, 12_500, 14_500, 16_500, 18_500]);
  const inAnyMinute = Math.max(...plain.starts.map((start) => plain.starts.filter((at) => at >= start && at < start + 60_000).length));
  assert.ok(inAnyMinute <= 5 + 30, `${inAnyMinute} in a minute`);
  assert.deepEqual([GATEWAY_BUDGET, BUDGET_RESERVE], [{ burst: 5, perMinute: 30 }, 0.25], 'the gateway’s own ClientBudgets, and 500 ms in hand');

  // A retry is an attempt too: a read that took three leaves less for the reads after it.
  // Changed on purpose 2026-09-28 (speed wave, item 5): a retry also means the gateway refused the attempt before it,
  // so the budget is at one when each retry goes: after a read that took three it stands at minus one, and the next
  // read waits 4.5 s for a read and a quarter. It used to count on the four it thought were left.
  const retryClock = fakeClock();
  const retried = instantSource(retryClock, { attempts: (request) => (request.token === tokenAt(0).token ? 3 : 1) });
  const retryQueue = createScheduledSource(retried.source, { clock: retryClock });
  for (let i = 0; i < 6; i++) await retryQueue.read('token', tokenAt(i));
  assert.deepEqual(retried.starts, [0, 4500, 6500, 8500, 10_500, 12_500]);

  // Without a budget, the spacing alone.
  const bareClock = fakeClock();
  const bare = instantSource(bareClock);
  const bareQueue = createScheduledSource(bare.source, { clock: bareClock, budget: null });
  for (let i = 0; i < 12; i++) await bareQueue.read('token', tokenAt(i));
  assert.deepEqual(bare.starts, Array.from({ length: 12 }, (_, i) => i * 1100));
});

test('after a read comes back busy the whole queue holds for its Retry-After, plus R-1’s jitter, before whichever read is next', async () => {
  const clock = fakeClock({ random: () => 0.5 });
  const { starts, source } = instantSource(clock, {
    answer: (route, request) => (request.token === NATIVE ? { route, state: 'busy', retryAfterSeconds: 3, provenance: {} } : { route, state: 'ok', data: {}, provenance: {} }),
  });
  const queue = createScheduledSource(source, { clock });
  const [busy, next, after] = await Promise.all([queue.read('token', { token: NATIVE }), queue.read('token', tokenRequest), queue.read('pool-metrics', { poolId: FIXTURE_POOL })]);
  assert.deepEqual([busy.state, next.state, after.state], ['busy', 'ok', 'ok']);
  // 3 s asked, plus half of R-1's 250 ms of jitter; then the budget.
  // Changed on purpose 2026-09-28 (speed wave, item 5): a busy answer leaves the budget at nothing, so after the first
  // read the third waits for a read and a quarter to come back (4.5 s), past the usual 1.1 s (4.225 s).
  assert.deepEqual(starts, [0, 3125, 4500]);
});

test('the speed wave: two reads on the wire, a slow provider read beside the queue, 0 ms apart until a refusal brings 1.1 s back', async () => {
  // Added 2026-09-28 (speed wave, item 1): the pool page's reads, with the deployed options. The v2 pool-market read
  // (about 4.9 s live) used to hold the overview, the chart's history and the chain reads behind it.
  const tick = () => new Promise((done) => setTimeout(done, 0));
  const clock = fakeClock();
  const log = [];
  const pending = new Map();
  const source = {
    transport: 'bridge',
    read: (route, request, opts = {}) => new Promise((resolve) => {
      log.push([route, clock.monotonic()]);
      opts.onAttempt?.();
      pending.set(route, () => resolve({ route, state: 'ok', data: {}, provenance: {} }));
    }),
  };
  const queue = createScheduledSource(source, { clock, minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2, budget: null });
  const market = queue.read('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false });
  const overview = queue.read('overview', { poolIds: [FIXTURE_POOL] });
  const history = queue.read('history', { poolId: FIXTURE_POOL, currency: NATIVE, windowSeconds: 86400, resolutionSeconds: 3600 });
  await tick();
  assert.deepEqual(log, [['pool-market', 0], ['overview', 0]], 'two at once, the slow one beside the queue');
  pending.get('overview')();
  await tick();
  assert.deepEqual(log.at(-1), ['history', 0], 'the overview answered: the history takes its slot while the market read runs');
  const activity = queue.read('pool-activity', { poolId: FIXTURE_POOL });
  await tick();
  assert.equal(log.length, 3, 'the width is two: the chain read waits for a slot');
  pending.get('history')();
  await tick();
  assert.deepEqual(log.at(-1), ['pool-activity', 0], 'a second provider read beside the first, 0 ms apart');
  pending.get('pool-market')();
  pending.get('pool-activity')();
  assert.deepEqual((await Promise.all([market, overview, history, activity])).map((outcome) => outcome.state), ['ok', 'ok', 'ok', 'ok']);

  // A provider read that meets a refusal (its retry) brings the 1.1 s back, one provider read at a time; a stored read
  // that joins the line while a provider read waits for its spacing goes first.
  let steady = 0;
  const sleepers = new Set();
  const stepped = { now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const sleeper = { at: steady + ms, resolve };
      sleepers.add(sleeper);
      signal?.addEventListener('abort', () => { sleepers.delete(sleeper); reject(signal.reason); }, { once: true });
    }) };
  const advance = async (ms) => { steady += ms; for (const sleeper of [...sleepers]) if (sleeper.at <= steady) { sleepers.delete(sleeper); sleeper.resolve(); } await tick(); };
  const refusedStarts = [];
  const retrying = {
    transport: 'bridge',
    read: async (route, request, opts = {}) => {
      refusedStarts.push([route, steady]);
      opts.onAttempt?.();
      if (request.token === NATIVE) opts.onAttempt?.();
      return { route, state: 'ok', data: {}, provenance: {} };
    },
  };
  const spaced = createScheduledSource(retrying, { clock: stepped, minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2, budget: null });
  await spaced.read('token', { token: NATIVE });
  const second = spaced.read('token', tokenAt(1));
  await tick();
  const stored = spaced.read('overview', { poolIds: [FIXTURE_POOL] });
  await tick();
  assert.deepEqual(refusedStarts, [['token', 0], ['overview', 0]], 'the stored read goes while the provider read waits for its 1.1 s');
  const third = spaced.read('token', tokenAt(2));
  await advance(1100);
  assert.deepEqual(refusedStarts.at(-1), ['token', 1100]);
  await advance(1100);
  assert.deepEqual(refusedStarts.at(-1), ['token', 2200], 'one provider read at a time, 1.1 s apart');
  assert.deepEqual((await Promise.all([second, stored, third])).map((outcome) => outcome.state), ['ok', 'ok', 'ok']);
});

test('the speed wave: a source that throws settles its read as a network failure at once, and the queue goes on', async () => {
  // Added 2026-09-28 (speed wave, item 34): it held every reader, and the queue behind it, until the read's 60 s.
  const clock = fakeClock();
  const source = { transport: 'bridge', read: async (route) => { if (route === 'token') throw new TypeError('boom'); return { route, state: 'ok', data: {}, provenance: {} }; } };
  const queue = createScheduledSource(source, { clock, budget: null, minIntervalMs: 0 });
  const [thrown, next] = await Promise.all([queue.read('token', tokenRequest), queue.read('pool-metrics', { poolId: FIXTURE_POOL })]);
  assert.deepEqual([thrown.state, thrown.cause?.kind, thrown.retryable, next.state], ['unavailable', 'network', false, 'ok']);
  assert.equal(clock.monotonic(), 0);
});

test('the speed wave: one budget for the browser, shared by its documents on the wall clock, counted again after a wait', async () => {
  // Added 2026-09-28 (speed wave, item 5): a reload, a pasted link or a second tab started with a full budget.
  let kept = null;
  const store = { load: () => kept, save: (state) => { kept = state; } };
  // Answers that met the read service (a contract header): only a document whose reads met it keeps the budget.
  const met = { answer: (route) => ({ route, state: 'ok', data: {}, provenance: { contract: '1.0.0' } }) };
  const lonely = instantSource(fakeClock());
  await createScheduledSource(lonely.source, { clock: fakeClock(), budgetStore: store, minIntervalMs: 0 }).read('token', tokenAt(0));
  assert.equal(kept, null, 'reads that met no read service keep nothing in the browser');
  const firstClock = fakeClock();
  const first = instantSource(firstClock, met);
  const one = createScheduledSource(first.source, { clock: firstClock, budgetStore: store, minIntervalMs: 0 });
  for (let i = 0; i < 4; i++) await one.read('token', tokenAt(i));
  assert.deepEqual(first.starts, [0, 0, 0, 0]);
  assert.deepEqual(kept, { tokens: 1, at: 0 }, 'what is left, counted on the wall clock');
  // A second document of the same browser, its own monotonic clock at 0: it starts from what the first left.
  const secondClock = fakeClock();
  const second = instantSource(secondClock);
  const two = createScheduledSource(second.source, { clock: secondClock, budgetStore: store, minIntervalMs: 0 });
  await two.read('token', tokenAt(9));
  assert.deepEqual(second.starts, [500], 'a read and a quarter: half a second more');
  // Something kept that makes no sense is not believed; storage that throws leaves each document its own count.
  kept = { tokens: 'lots', at: 0 };
  const thirdClock = fakeClock();
  const third = instantSource(thirdClock);
  await createScheduledSource(third.source, { clock: thirdClock, budgetStore: store, minIntervalMs: 0 }).read('token', tokenAt(8));
  assert.deepEqual(third.starts, [0]);
  const blocked = { load: () => { throw new Error('denied'); }, save: () => { throw new Error('denied'); } };
  const fourthClock = fakeClock();
  const fourth = instantSource(fourthClock);
  const alone = createScheduledSource(fourth.source, { clock: fourthClock, budgetStore: blocked, minIntervalMs: 0 });
  for (let i = 0; i < 5; i++) await alone.read('token', tokenAt(i));
  assert.deepEqual(fourth.starts, [0, 0, 0, 0, 500]);
  // A read that waited for the budget looks again before it goes: here another document spent it meanwhile.
  let spentElsewhere = false;
  const racing = { load: () => kept, save: (state) => { kept = state; } };
  kept = { tokens: 0.25, at: 0 };
  const raceClock = fakeClock();
  const raced = { starts: [], source: { transport: 'bridge', read: async (route, request, opts = {}) => { raced.starts.push(raceClock.monotonic()); opts.onAttempt?.(); return { route, state: 'ok', data: {}, provenance: {} }; } } };
  const origSleep = raceClock.sleep;
  raceClock.sleep = async (ms, signal) => {
    await origSleep(ms, signal);
    if (!spentElsewhere) { spentElsewhere = true; kept = { tokens: kept.tokens - 1 + (raceClock.now() - kept.at) * 0.0005, at: raceClock.now() }; }
  };
  await createScheduledSource(raced.source, { clock: raceClock, budgetStore: racing, minIntervalMs: 0 }).read('token', tokenAt(7));
  assert.deepEqual(raced.starts, [4000], 'it waited 2 s, found the budget spent meanwhile, and waited 2 s more');
  // A read that took the budget at its start and never sent anything (its document went away while it waited for the
  // capabilities, say) is not kept for the others: only what went out is.
  kept = null;
  const goneClock = fakeClock();
  const stuck = createScheduledSource({ transport: 'bridge', read: (route, request, opts = {}) => {
    if (request.token !== tokenAt(0).token) return new Promise(() => {});
    opts.onAttempt?.();
    return Promise.resolve(met.answer(route));
  } }, { clock: goneClock, budgetStore: store, minIntervalMs: 0 });
  await stuck.read('token', tokenAt(0));
  void stuck.read('token', tokenAt(1));
  void stuck.read('token', tokenAt(2));
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(kept, { tokens: 4, at: 0 }, 'one read sent; two holding the budget, nothing sent: the others see only the one');
});

/**
 * A clock whose timers fire in time order, each after the code it woke has run: the sleeps of the queue and the answers
 * `at` schedules. `settle` runs them all.
 */
function eventClock() {
  let steady = 0;
  const timers = new Set();
  const at = (ms, fire) => {
    const timer = { at: steady + ms, fire };
    timers.add(timer);
    return timer;
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));
  return {
    at,
    now: () => steady,
    monotonic: () => steady,
    random: () => 0,
    timer: (ms, fire) => {
      const timer = at(ms, fire);
      return () => timers.delete(timer);
    },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = at(ms, resolve);
      signal?.addEventListener('abort', () => { timers.delete(timer); reject(signal.reason); }, { once: true });
    }),
    async settle() {
      for (;;) {
        for (let i = 0; i < 5; i++) await tick();
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next) return;
        timers.delete(next);
        steady = next.at;
        next.fire();
      }
    },
  };
}

// Added 2026-09-28 after review (speed wave, item 5): before a read of it met the read service, a document took the
// budget kept in this browser afresh at every look, and forgot what it had just spent: a pool opened by a link or a
// reload, whose list missed the edge, sent reads the gateway refused (kept 1.3: its second read at once; kept 2.3: its
// third at 409 ms; kept 3: its fourth at 510 ms).
test('the speed wave: a document counts its own spends against the budget it found kept, before any read of it met the read service', async () => {
  const run = async (kept, { contract = '1.0.0', reads = 4, elsewhere = [] } = {}) => {
    const clock = eventClock();
    // The gateway: the same budget, burst 5 and one read every 2 s, counting each attempt as it arrives.
    let gateway = Math.min(5, kept.tokens + (0 - kept.at) / 2000);
    let countedAt = 0;
    let refusals = 0;
    const count = () => {
      gateway = Math.min(5, gateway + (clock.monotonic() - countedAt) / 2000);
      countedAt = clock.monotonic();
      if (gateway >= 1) gateway -= 1;
      else refusals += 1;
    };
    const starts = [];
    const source = { transport: 'bridge', read: (route, request, opts = {}) => {
      starts.push(clock.monotonic());
      opts.onAttempt?.();
      count();
      // Answers 400 ms away; without a contract header, a read that met no read service (a dropped connection).
      return new Promise((resolve) => clock.at(400, () => resolve(contract
        ? { route, state: 'ok', data: {}, provenance: { contract } }
        : { route, state: 'unavailable', cause: { kind: 'network' }, retryable: true, provenance: { contract: null } })));
    } };
    let state = kept;
    const store = { load: () => state, save: (next) => { state = next; } };
    // Another document of the browser, whose reads met the read service, spends a read at each of these times and keeps
    // what it counts: never this document's spends, which it has not seen.
    for (const at of elsewhere) clock.at(at, () => {
      count();
      state = { tokens: Math.min(5, state.tokens + (at - state.at) / 2000) - 1, at };
    });
    const queue = createScheduledSource(source, { clock, budgetStore: store, minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2 });
    const pending = Array.from({ length: reads }, (_, i) => queue.read('token', tokenAt(i)));
    await clock.settle();
    await Promise.all(pending);
    return { starts, refusals };
  };
  assert.deepEqual(await run({ tokens: 2.3, at: 0 }), { starts: [0, 0, 1900, 3900], refusals: 0 }, 'kept 2.3: two at once, then the budget’s pace');
  assert.deepEqual(await run({ tokens: 1.3, at: 0 }), { starts: [0, 1900, 3900, 5900], refusals: 0 }, 'kept 1.3');
  assert.deepEqual(await run({ tokens: 3, at: 0 }), { starts: [0, 0, 500, 2500], refusals: 0 }, 'kept 3');
  // Another document spends and keeps a read meanwhile: this document's two unkept spends come off what it kept.
  assert.deepEqual(await run({ tokens: 4, at: 0 }, { elsewhere: [100] }), { starts: [0, 0, 500, 2500], refusals: 0 }, 'kept 4, and one spent elsewhere at 100 ms');
  // Kept ten minutes ago: a full burst again, and no more, while none of its reads meets the read service.
  assert.deepEqual(await run({ tokens: 0, at: -600_000 }, { contract: null, reads: 7 }), { starts: [0, 0, 400, 400, 800, 2500, 4500], refusals: 0 },
    'filled to the burst, then this document’s own spends come off it');
});

/** Monotonic ms moved by `advance` alone (each advance then lets the woken code run); a sleep waits for it or its signal. */
function steppedClock() {
  let steady = 0;
  const sleepers = new Set();
  const tick = () => new Promise((done) => setTimeout(done, 0));
  return {
    now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const sleeper = { at: steady + ms, resolve };
      sleepers.add(sleeper);
      signal?.addEventListener('abort', () => { sleepers.delete(sleeper); reject(signal.reason); }, { once: true });
    }),
    async advance(ms) {
      steady += ms;
      for (const sleeper of [...sleepers]) if (sleeper.at <= steady) { sleepers.delete(sleeper); sleeper.resolve(); }
      await tick();
      await tick();
    },
  };
}
/** A source whose reads the test answers (`answer(key)`), each logged with its start as `route:pool or token`. */
function heldSource(clock) {
  const log = [];
  const pending = new Map();
  const keyOf = (route, request) => `${route}:${request.poolId ?? request.poolIds?.[0] ?? request.token ?? ''}`;
  return { log, answer: (key) => pending.get(key)(), source: { transport: 'bridge', read: (route, request, opts = {}) => new Promise((resolve) => {
    const key = keyOf(route, request);
    log.push([key, clock.monotonic()]);
    opts.onAttempt?.();
    // A read the gateway refused once, and sent again at once: a second attempt.
    if (request.token === NATIVE) opts.onAttempt?.();
    pending.set(key, () => resolve({ route, state: 'ok', data: {}, provenance: {} }));
  }) } };
}
const DEPLOYED_PACE = { minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2, budget: null };

// Added 2026-09-28 after review (speed wave, item 4): the featured list, which the edge answers almost always, holds no
// place of the width (commit a29e2157), and a list asked while the width is taken still goes at once.
test('the speed wave: the featured list takes no place of the width, and goes at once while two reads hold it', async () => {
  const clock = steppedClock();
  const { log, answer, source } = heldSource(clock);
  const queue = createScheduledSource(source, { clock, ...DEPLOYED_PACE });
  const list = queue.read('featured-pools', {}, { priority: 'first' });
  const overview = queue.read('overview', { poolIds: [FIXTURE_POOL] });
  const market = queue.read('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false });
  const activity = queue.read('pool-activity', { poolId: FIXTURE_POOL });
  await clock.advance(0);
  assert.deepEqual(log.map(([key]) => key), ['featured-pools:', `overview:${FIXTURE_POOL}`, `pool-market:${FIXTURE_POOL}`], 'the list on the wire, and two gateway reads beside it');
  answer('featured-pools:');
  await clock.advance(0);
  assert.equal(log.length, 3, 'the list gave back no place: the chain read still waits for one');
  const again = queue.read('featured-pools', {}, { priority: 'first' });
  await clock.advance(0);
  assert.deepEqual(log.at(-1), ['featured-pools:', 0], 'the width taken, the list goes at once');
  answer(`overview:${FIXTURE_POOL}`);
  await clock.advance(0);
  assert.deepEqual(log.at(-1), [`pool-activity:${FIXTURE_POOL}`, 0], 'a gateway read’s place frees: the chain read takes it');
  for (const key of ['featured-pools:', `pool-market:${FIXTURE_POOL}`, `pool-activity:${FIXTURE_POOL}`]) answer(key);
  assert.deepEqual((await Promise.all([list, overview, market, activity, again])).map((outcome) => outcome.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

// Added 2026-09-28 after review (speed wave, item 1): once a provider read met a refusal, provider reads go one at a
// time, 1.1 s apart, the way a gateway older than #241 admits them: a second one never goes while one is on the wire.
test('the speed wave: after a refusal a provider read waits for the one on the wire, not only for its 1.1 s', async () => {
  const clock = steppedClock();
  const { log, answer, source } = heldSource(clock);
  const queue = createScheduledSource(source, { clock, ...DEPLOYED_PACE });
  const refused = queue.read('token', { token: NATIVE });
  await clock.advance(0);
  answer(`token:${NATIVE}`);
  assert.equal((await refused).state, 'ok');
  const first = queue.read('token', tokenAt(1));
  const second = queue.read('token', tokenAt(2));
  await clock.advance(0);
  assert.equal(log.length, 1, 'the refusal brought the 1.1 s back');
  await clock.advance(1100);
  assert.deepEqual(log.at(-1), [`token:${tokenAt(1).token}`, 1100]);
  await clock.advance(1100);
  await clock.advance(5000);
  assert.equal(log.length, 2, 'its 1.1 s long past, the second waits for the first to answer');
  const stored = queue.read('overview', { poolIds: [FIXTURE_POOL] });
  await clock.advance(0);
  assert.deepEqual(log.at(-1), [`overview:${FIXTURE_POOL}`, 7200], 'a stored read still goes beside it');
  answer(`token:${tokenAt(1).token}`);
  await clock.advance(0);
  assert.deepEqual(log.at(-1), [`token:${tokenAt(2).token}`, 7200], 'the first answered: the second goes');
  answer(`token:${tokenAt(2).token}`);
  answer(`overview:${FIXTURE_POOL}`);
  assert.deepEqual((await Promise.all([first, second, stored])).map((outcome) => outcome.state), ['ok', 'ok', 'ok']);
});

// ---------------------------------------------------------------------------
// R-1's deadlines: 20 s an attempt, 60 s a read from enqueue (#69 D1)
// ---------------------------------------------------------------------------

const PENDING = Symbol('still pending');
/** The promise's value if it settles within `ms` of real time, PENDING if it does not. */
const within = (promise, ms = 50) => Promise.race([promise, new Promise((done) => setTimeout(() => done(PENDING), ms))]);
/** Waits, in real time, until `check()` holds. */
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const later = () => new Promise((done) => setTimeout(done, 0));

/** A body that sends its first bytes and then nothing more, until it is cancelled. */
function stalledBody() {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls > 1) return new Promise(() => undefined);
      controller.enqueue(new TextEncoder().encode('{"schemaVersion":'));
      return undefined;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const ANSWERS = {
  capabilities: 'capabilities.live_read_only',
  token: 'token.success',
  pools: 'pools.catalogue',
  'pool-market': 'pool-market.not-requested',
  'pool-metrics': 'pool-metrics.qualified',
  'wallet-assets': 'wallet-assets.fallback',
};

/**
 * The browser's fetch for a bridge source, answering from fixtures, while
 * `plan[route]` may answer instead with a promise of a Response. Every call
 * is kept with its signal.
 */
function bridgeFetch(clock, plan = {}) {
  const calls = [];
  const fetch = (path, init) => {
    const route = path.slice('/api/read/v1/'.length);
    calls.push({ route, method: init.method, signal: init.signal, at: clock.monotonic() });
    return plan[route]?.(init) ?? Promise.resolve(bridgeResponse(200, text(gateway(ANSWERS[route]))));
  };
  return { fetch, calls };
}
const live = (clock, fetch) => createBridgeSource({ enabled: true, validators: runtime, fetch, clock });
const deadlineOf = (outcome) => [outcome.state, outcome.cause?.kind, outcome.cause?.limit];
const posts = (calls) => calls.filter((call) => call.method === 'POST');

test('D1: an answer that arrives after the 20 s attempt deadline is discarded, not shown (rugged97’s probe: 21,000 ms)', async () => {
  const clock = fakeClock();
  const { fetch, calls } = bridgeFetch(clock, {
    token: async () => {
      await later();
      clock.advance(21_000);
      return bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const outcome = await within(live(clock, fetch).read('token', tokenRequest), 1000);
  assert.deepEqual(deadlineOf(outcome), ['unavailable', 'read_deadline', 'attempt']);
  assert.equal('data' in outcome, false, 'a late success carries nothing');
  assert.equal(outcome.provenance.attempts, 1, 'a deadline is not asked again');
  assert.equal(posts(calls)[0].signal?.aborted, true, 'the attempt was cancelled');
});

test('D1: a POST that never answers is stopped at 20 s, and its fetch cancelled', async () => {
  const clock = fakeClock();
  const { fetch, calls } = bridgeFetch(clock, { token: () => new Promise(() => undefined) });
  const pending = live(clock, fetch).read('token', tokenRequest);
  await until(() => posts(calls).length === 1, 'the POST');
  clock.advance(19_999);
  assert.equal(await within(pending), PENDING, 'still inside its 20 s');
  clock.advance(1);
  const outcome = await within(pending);
  assert.deepEqual(deadlineOf(outcome), ['unavailable', 'read_deadline', 'attempt']);
  assert.equal(posts(calls)[0].signal?.aborted, true);
});

test('D1: a response body that stops arriving is cancelled at 20 s, and nothing of it is taken for a reply', async () => {
  const clock = fakeClock();
  const body = stalledBody();
  const { fetch, calls } = bridgeFetch(clock, { token: () => Promise.resolve(bridgeResponse(200, body.stream)) });
  const pending = live(clock, fetch).read('token', tokenRequest);
  await until(() => posts(calls).length === 1 && body.state.pulls > 1, 'the body to stall');
  clock.advance(20_000);
  const outcome = await within(pending);
  assert.deepEqual(deadlineOf(outcome), ['unavailable', 'read_deadline', 'attempt']);
  await until(() => body.state.cancelled, 'the body to be cancelled');
});

test('D1: while capabilities stall, a cancelled read settles at once, the others keep waiting, and 20 s bounds the check', async () => {
  const clock = fakeClock();
  let stall = true;
  const { fetch, calls } = bridgeFetch(clock, { capabilities: () => (stall ? new Promise(() => undefined) : undefined) });
  const source = live(clock, fetch);
  const leaving = new AbortController();
  const cancelled = source.read('token', tokenRequest, { signal: leaving.signal });
  const staying = source.read('pool-metrics', { poolId: FIXTURE_POOL });
  await until(() => calls.length === 1, 'the capabilities GET');
  leaving.abort();
  assert.equal((await within(cancelled)).state, 'aborted', 'the cancelled read did not wait for capabilities');
  assert.equal(await within(staying), PENDING, 'the other read still waits');
  assert.equal(calls[0].signal?.aborted, false, 'one reader leaving does not stop the shared check');
  clock.advance(20_000);
  const stopped = await within(staying);
  assert.deepEqual([stopped.route, ...deadlineOf(stopped)], ['pool-metrics', 'unavailable', 'read_deadline', 'attempt']);
  assert.equal(calls[0].signal?.aborted, true, 'the stalled GET was cancelled');
  // A failed check is not kept: the next read asks again, and gets through.
  stall = false;
  assert.equal((await within(source.read('token', tokenRequest), 1000)).state, 'ok');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), ['GET capabilities', 'GET capabilities', 'POST token']);
});

test('D1: a capabilities body that stops arriving is cancelled at 20 s', async () => {
  const clock = fakeClock();
  const body = stalledBody();
  const { fetch, calls } = bridgeFetch(clock, { capabilities: () => Promise.resolve(bridgeResponse(200, body.stream)) });
  const pending = live(clock, fetch).read('token', tokenRequest);
  await until(() => calls.length === 1 && body.state.pulls > 1, 'the capabilities body to stall');
  clock.advance(20_000);
  assert.deepEqual(deadlineOf(await within(pending)), ['unavailable', 'read_deadline', 'attempt']);
  await until(() => body.state.cancelled, 'the body to be cancelled');
  assert.equal(posts(calls).length, 0, 'no POST without capabilities');
});

test('D1: a read cancelled while capabilities stall frees the queue, and the next read runs', async () => {
  const clock = fakeClock();
  let gets = 0;
  const { fetch, calls } = bridgeFetch(clock, { capabilities: () => ((gets += 1) === 1 ? new Promise(() => undefined) : undefined) });
  const source = createScheduledSource(live(clock, fetch), { clock });
  const leaving = new AbortController();
  const stuck = source.read('token', tokenRequest, { signal: leaving.signal });
  await until(() => calls.length === 1, 'the capabilities GET');
  leaving.abort();
  assert.equal((await within(stuck)).state, 'aborted');
  const next = await within(source.read('pool-metrics', { poolId: FIXTURE_POOL }), 1000);
  assert.equal(next.state, 'ok', 'the queue moved on');
  assert.equal(calls[0].signal?.aborted, true, 'the check nobody waited for was cancelled');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), ['GET capabilities', 'GET capabilities', 'POST pool-metrics']);
});

test('D1: 60 s from enqueue cover the queue, the waits and every attempt; a read still queued then is answered and never sent', async () => {
  const clock = fakeClock();
  let tokenAttempts = 0;
  const { fetch, calls } = bridgeFetch(clock, {
    // 10 s to a 429 asking for 30 s, then 10 s to an answer: done at 50 s.
    token: async () => {
      await later();
      clock.advance(10_000);
      tokenAttempts += 1;
      return tokenAttempts === 1 ? bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': '30' }) : bridgeResponse(200, text(gateway('token.success')));
    },
    // Started at 50 s, well inside its own 20 s, but its answer would land at 65 s.
    'pool-metrics': async () => {
      await later();
      clock.advance(15_000);
      return bridgeResponse(200, text(gateway('pool-metrics.qualified')));
    },
  });
  const source = createScheduledSource(live(clock, fetch), { clock });
  const reads = [source.read('token', tokenRequest), source.read('pool-metrics', { poolId: FIXTURE_POOL }), source.read('pool-market', { poolId: FIXTURE_POOL })];
  const [token, metrics, market] = await within(Promise.all(reads), 2000);
  assert.deepEqual([token.state, token.provenance.attempts], ['ok', 2]);
  assert.deepEqual(deadlineOf(metrics), ['unavailable', 'read_deadline', 'read'], 'queued 50 s, then cut at its 60 s');
  assert.deepEqual(deadlineOf(market), ['unavailable', 'read_deadline', 'read'], 'still queued at its 60 s');
  assert.deepEqual(posts(calls).map((call) => [call.route, call.at]), [['token', 0], ['token', 40_000], ['pool-metrics', 50_000]], 'pool-market was never sent');
  assert.equal(posts(calls)[2].signal?.aborted, true, 'the late read was cancelled');
});

test('D1: each reader of a shared read settles at its own deadline without cancelling it for the others', async () => {
  const clock = fakeClock();
  const { fetch, calls } = bridgeFetch(clock, {
    token: async () => {
      await later();
      clock.advance(12_000);
      return bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const source = createScheduledSource(live(clock, fetch), { clock });
  // The second reader carries a deadline 10 s out, as a restart keeps its read's.
  const [first, second] = await within(Promise.all([source.read('token', tokenRequest), source.read('token', tokenRequest, { deadlineAt: 10_000 })]), 1000);
  assert.equal(first.state, 'ok');
  assert.deepEqual(deadlineOf(second), ['unavailable', 'read_deadline', 'read']);
  assert.equal(posts(calls).length, 1, 'one request for both');
  assert.equal(posts(calls)[0].signal?.aborted, false, 'the shared read went on');
});

test('D1: a cursor or revision restart spends what is left of its read’s 60 s, not 60 s more', async () => {
  const busy30 = () => bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': '30' });
  // The next wallet page: 5 s to a 429 asking for 30 s, then 10 s to "the handle expired", at 45 s.
  // The restarted first page then takes 16 s, which would end at 61 s.
  const clock = fakeClock();
  const pageOne = JSON.stringify(scenarios.withCursor(MUTATED_CURSOR)(JSON.parse(text(gateway('wallet-assets.opaque-page')))));
  let firstPages = 0;
  let nextPages = 0;
  const wallet = bridgeFetch(clock, {
    'wallet-assets': async (init) => {
      await later();
      if (JSON.parse(init.body).cursor === undefined) {
        firstPages += 1;
        if (firstPages === 2) clock.advance(16_000);
        return bridgeResponse(200, pageOne);
      }
      nextPages += 1;
      clock.advance(nextPages === 1 ? 5_000 : 10_000);
      return nextPages === 1 ? busy30() : bridgeResponse(400, '{"error":"invalid_or_expired_cursor"}');
    },
  });
  const pager = pagers.createWalletPager(live(clock, wallet.fetch), requestFor(catalog, 'wallet-assets'));
  assert.equal((await pager.first()).failure, null);
  const step = await within(pager.more(), 1000);
  assert.equal(step.view.restarted, true, 'the restart was made, once');
  assert.deepEqual(deadlineOf(step.failure ?? {}), ['unavailable', 'read_deadline', 'read']);

  // The pools route's single restart after a 409, the same way.
  const poolsClock = fakeClock();
  let poolReads = 0;
  const pools = bridgeFetch(poolsClock, {
    pools: async () => {
      await later();
      poolReads += 1;
      poolsClock.advance([5_000, 10_000, 16_000][poolReads - 1]);
      if (poolReads === 1) return busy30();
      if (poolReads === 2) return bridgeResponse(409, '{"error":"catalogue_revision_changed"}');
      return bridgeResponse(200, text(gateway('pools.catalogue')));
    },
  });
  const restarted = await within(pagers.readRestartingOnce(live(poolsClock, pools.fetch), 'pools', requestFor(catalog, 'pools')), 1000);
  assert.equal(restarted.restarted, true);
  assert.deepEqual(deadlineOf(restarted.outcome), ['unavailable', 'read_deadline', 'read']);
});

// ---------------------------------------------------------------------------
// R-1's times run on the monotonic clock, never on the wall clock (#69 A3)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const busyFor = (seconds) => bridgeResponse(429, '{"error":"read_capacity_busy"}', { 'Retry-After': String(seconds) });
/** Steps `clock`'s wall clock by `ms` once `at` ms have passed on its monotonic one. */
const stepWallAt = (clock, at, ms) => clock.timer(at, () => clock.jump(ms));

/**
 * Four reads, the wall clock stepping by `step` in the middle of each: one
 * answered inside its deadlines, a retry answered after its read's 60 s, a
 * 429 whose wait the read can afford, and two reads in one queue. What each
 * comes to must not depend on `step`.
 */
async function readsAcrossAWallStep(step) {
  // Capabilities answer at 1 s and the POST 5 s later; the wall clock steps during each.
  const onTimeClock = fakeClock();
  stepWallAt(onTimeClock, 500, step);
  stepWallAt(onTimeClock, 3_000, step);
  const onTimeWire = bridgeFetch(onTimeClock, {
    capabilities: async () => {
      await later();
      onTimeClock.advance(1_000);
      return bridgeResponse(200, text(gateway('capabilities.live_read_only')));
    },
    token: async () => {
      await later();
      onTimeClock.advance(5_000);
      return bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const onTime = await within(live(onTimeClock, onTimeWire.fetch).read('token', tokenRequest), 1000);

  // A 429 at 19 s asks for 30 s; the wall clock steps at 30 s, mid-wait; the retry at 49 s answers at 61 s.
  const lateClock = fakeClock();
  stepWallAt(lateClock, 30_000, step);
  let lateAttempts = 0;
  const lateWire = bridgeFetch(lateClock, {
    token: async () => {
      await later();
      lateAttempts += 1;
      lateClock.advance(lateAttempts === 1 ? 19_000 : 12_000);
      return lateAttempts === 1 ? busyFor(30) : bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const late = await within(live(lateClock, lateWire.fetch).read('token', tokenRequest), 1000);

  // A 429 at 5 s asks for 50 s, which the read can afford; the wall clock steps at 2 s. The retry at 55 s answers at 56 s.
  const waitClock = fakeClock();
  stepWallAt(waitClock, 2_000, step);
  let waitAttempts = 0;
  const waitWire = bridgeFetch(waitClock, {
    token: async () => {
      await later();
      waitAttempts += 1;
      waitClock.advance(waitAttempts === 1 ? 5_000 : 1_000);
      return waitAttempts === 1 ? busyFor(50) : bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const waited = await within(live(waitClock, waitWire.fetch).read('token', tokenRequest), 1000);

  // Two reads in one queue; the first is answered at 500 ms, and the wall clock steps at 250 ms.
  const queueClock = fakeClock();
  stepWallAt(queueClock, 250, step);
  const queueWire = bridgeFetch(queueClock, {
    token: async () => {
      await later();
      queueClock.advance(500);
      return bridgeResponse(200, text(gateway('token.success')));
    },
  });
  const queue = createScheduledSource(live(queueClock, queueWire.fetch), { clock: queueClock });
  const queued = await within(Promise.all([queue.read('token', tokenRequest), queue.read('pool-metrics', { poolId: FIXTURE_POOL })]), 1000);

  return {
    onTime: [onTime.state, onTime.provenance?.attempts],
    // When it was received is stamped on the wall clock; its deadline is kept on the monotonic one.
    stamps: [onTime.provenance?.receivedAt - onTimeClock.now(), onTime.provenance?.deadlineAt],
    late: [...deadlineOf(late), late.provenance?.attempts],
    waited: [waited.state, waited.provenance?.attempts],
    queued: queued === PENDING ? [PENDING] : queued.map((outcome) => outcome.state),
    starts: posts(queueWire.calls).map((call) => [call.route, call.at]),
  };
}

test('A3: a wall clock stepping forward or back mid-read moves no deadline, no wait and no pacing', async () => {
  const unstepped = await readsAcrossAWallStep(0);
  assert.deepEqual(
    unstepped,
    {
      onTime: ['ok', 1],
      stamps: [0, 60_000],
      late: ['unavailable', 'read_deadline', 'read', 2],
      waited: ['ok', 2],
      queued: ['ok', 'ok'],
      starts: [['token', 0], ['pool-metrics', 1100]],
    },
    'the wall clock left alone',
  );
  const stepped = {};
  for (const step of [10_000, -10_000, HOUR, -HOUR]) stepped[`${step / 1000} s`] = await readsAcrossAWallStep(step);
  assert.deepEqual(stepped, { '10 s': unstepped, '-10 s': unstepped, '3600 s': unstepped, '-3600 s': unstepped });
});

// ---------------------------------------------------------------------------
// Past its deadline a read asks for nothing more (#69 A4)
// ---------------------------------------------------------------------------

test('A4: a read whose deadline has passed sends nothing, not even the capabilities GET, and settles at once', async () => {
  // A restart handed a deadline that has passed, or passes exactly now.
  const clock = fakeClock();
  const { fetch, calls } = bridgeFetch(clock);
  const source = live(clock, fetch);
  clock.advance(30_000);
  for (const deadlineAt of [29_999, 30_000]) {
    const outcome = await within(source.read('token', tokenRequest, { deadlineAt }));
    assert.deepEqual([...deadlineOf(outcome), outcome.provenance?.attempts], ['unavailable', 'read_deadline', 'read', 0], `deadline at ${deadlineAt} ms, now 30,000 ms`);
  }
  assert.deepEqual(calls, [], 'no capabilities GET and no POST');
  // With capabilities already known, it sends no POST either.
  assert.equal((await within(source.read('token', tokenRequest), 1000)).state, 'ok');
  const known = calls.length;
  assert.deepEqual(deadlineOf(await within(source.read('token', tokenRequest, { deadlineAt: 30_000 }))), ['unavailable', 'read_deadline', 'read']);
  assert.equal(calls.length, known, 'no POST');
});

test('A4: in the queue, a read whose deadline passed while it waited, kept by a reader who joined it, is answered without a request', async () => {
  const queueClock = fakeClock();
  let gets = 0;
  const queueWire = bridgeFetch(queueClock, {
    // The read ahead sees the capabilities GET fail after 1 s, so nothing is known about capabilities when the next read's turn comes.
    capabilities: async () => {
      gets += 1;
      if (gets > 1) return bridgeResponse(200, text(gateway('capabilities.live_read_only')));
      await later();
      queueClock.advance(1_000);
      throw new TypeError('Failed to fetch');
    },
  });
  const queue = createScheduledSource(live(queueClock, queueWire.fetch), { clock: queueClock });
  const ahead = queue.read('token', tokenRequest);
  // A restart with 500 ms of its read left, and a fresh identical read that joins it.
  const restart = queue.read('pool-metrics', { poolId: FIXTURE_POOL }, { deadlineAt: 500 });
  const joiner = queue.read('pool-metrics', { poolId: FIXTURE_POOL });
  const [first, cut, joined] = await within(Promise.all([ahead, restart, joiner]), 1000);
  assert.deepEqual([first.state, first.cause?.kind], ['unavailable', 'network']);
  assert.deepEqual(deadlineOf(cut), ['unavailable', 'read_deadline', 'read'], 'the restart, at its deadline');
  assert.deepEqual(deadlineOf(joined), ['unavailable', 'read_deadline', 'read'], 'the joiner, held to the read it joined');
  assert.deepEqual(queueWire.calls.map((call) => `${call.method} ${call.route}`), ['GET capabilities'], 'the read that started past its deadline asked for nothing');
});

test('A4: a retry whose wait, jitter included, would reach the read’s deadline is not sent', async () => {
  // A 429 asking for 59 s, plus 225 ms of jitter: at 0 ms the wait ends at 59.225 s, inside the 60 s; at 800 ms it would end at 60.025 s.
  for (const [at, outcome, waits] of [
    [0, ['ok', 2], [59_225]],
    [800, ['busy', 1], []],
  ]) {
    const clock = fakeClock({ random: () => 0.9 });
    let answered = 0;
    const wire = bridgeFetch(clock, {
      token: async () => {
        await later();
        answered += 1;
        if (answered > 1) return bridgeResponse(200, text(gateway('token.success')));
        clock.advance(at);
        return busyFor(59);
      },
    });
    const read = await within(live(clock, wire.fetch).read('token', tokenRequest), 1000);
    assert.deepEqual([read.state, read.provenance?.attempts], outcome, `a 429 at ${at} ms`);
    assert.equal(posts(wire.calls).length, outcome[1], `a 429 at ${at} ms: POSTs sent`);
    assert.deepEqual(clock.delays, waits, `a 429 at ${at} ms: waits`);
    if (read.state === 'busy') assert.equal(read.retryAfterSeconds, 59, 'shown with the wait it asked for');
  }

  // In the queue the wait must fit what is left of the 60 s from enqueue: queued at 0 and sent at 1.1 s, 1.1 s + 59.225 s would pass them.
  const clock = fakeClock({ random: () => 0.9 });
  let answered = 0;
  const wire = bridgeFetch(clock, {
    token: async () => {
      await later();
      answered += 1;
      return answered > 1 ? bridgeResponse(200, text(gateway('token.success'))) : busyFor(59);
    },
  });
  const queue = createScheduledSource(live(clock, wire.fetch), { clock });
  const [metrics, token] = await within(Promise.all([queue.read('pool-metrics', { poolId: FIXTURE_POOL }), queue.read('token', tokenRequest)]), 1000);
  assert.equal(metrics.state, 'ok');
  assert.deepEqual([token.state, token.provenance?.attempts], ['busy', 1]);
  assert.deepEqual(posts(wire.calls).map((call) => [call.route, call.at]), [['pool-metrics', 0], ['token', 1100]], 'no retry was sent');
});

// ---------------------------------------------------------------------------
// A reader who joins a shared read is held to its deadline (#69 A1)
// ---------------------------------------------------------------------------

test('A1: a joiner is released with the shared answer when the read settles', async () => {
  const clock = fakeClock();
  let answer = () => undefined;
  const wire = bridgeFetch(clock, {
    token: () => new Promise((resolve) => (answer = () => resolve(bridgeResponse(200, text(gateway('token.success')))))),
  });
  const source = createScheduledSource(live(clock, wire.fetch), { clock });
  const first = source.read('token', tokenRequest);
  await until(() => posts(wire.calls).length === 1, 'the POST');
  clock.advance(10_000);
  const joiner = source.read('token', tokenRequest);
  clock.advance(5_000);
  assert.equal(await within(joiner), PENDING, 'the joiner waits for the read it joined');
  answer();
  const [shared, joined] = await within(Promise.all([first, joiner]), 1000);
  assert.equal(shared.state, 'ok');
  assert.equal(joined, shared, 'the joiner has the same answer, at 15 s');
  assert.equal(posts(wire.calls).length, 1, 'one request for both');
});

test('A1: a joiner is held to the shared read’s deadline, its first reader’s, and readers who leave on the way do not cancel it for the others', async () => {
  const clock = fakeClock();
  let tokenPosts = 0;
  const wire = bridgeFetch(clock, {
    token: async () => {
      tokenPosts += 1;
      // The retry, sent at 40 s, never answers.
      if (tokenPosts > 1) return new Promise(() => undefined);
      await later();
      clock.advance(10_000);
      return busyFor(30);
    },
  });
  const source = createScheduledSource(live(clock, wire.fetch), { clock });
  const firstLeaves = new AbortController();
  const otherLeaves = new AbortController();
  // The first reader at 0 s. During the Retry-After wait, a joiner and another reader come at 30 s, and the first reader leaves at 35 s.
  const first = source.read('token', tokenRequest, { signal: firstLeaves.signal });
  let joiner;
  let other;
  clock.timer(30_000, () => {
    joiner = source.read('token', tokenRequest);
    other = source.read('token', tokenRequest, { signal: otherLeaves.signal });
  });
  clock.timer(35_000, () => firstLeaves.abort());
  await until(() => posts(wire.calls).length === 2, 'the retry, at 40 s');
  const retry = posts(wire.calls)[1];
  assert.equal(retry.at, 40_000);
  assert.equal((await within(first)).state, 'aborted', 'the first reader left at 35 s');
  assert.equal(await within(joiner), PENDING);
  assert.equal(retry.signal.aborted, false, 'the read went on for the readers still waiting');
  clock.advance(5_000);
  otherLeaves.abort();
  assert.equal((await within(other)).state, 'aborted', 'another reader left at 45 s');
  assert.equal(await within(joiner), PENDING, 'which did not release the joiner');
  assert.equal(retry.signal.aborted, false);
  clock.advance(14_999);
  assert.equal(await within(joiner), PENDING, 'inside the shared read’s 60 s');
  clock.advance(1);
  const released = await within(joiner);
  assert.deepEqual(deadlineOf(released), ['unavailable', 'read_deadline', 'read'], 'released at the first reader’s 60 s, 30 s after it joined');
  assert.equal(released.provenance.deadlineAt, 60_000, 'the shared read’s deadline, not 90 s');
  assert.equal(retry.signal.aborted, true, 'the retry was stopped at that deadline');
});

test('A1: whatever the source does, a joiner never waits past 60 s from its own enqueue, and only the last reader to leave cancels the read', async () => {
  const clock = fakeClock();
  const signals = [];
  // A source that ignores the deadline it is handed and never answers.
  const stuck = { transport: 'bridge', read: (_route, _request, { signal }) => (signals.push(signal), new Promise(() => undefined)) };
  const source = createScheduledSource(stuck, { clock });
  const first = source.read('token', tokenRequest);
  clock.advance(30_000);
  const joiner = source.read('token', tokenRequest);
  clock.advance(30_000);
  assert.deepEqual(deadlineOf(await within(first)), ['unavailable', 'read_deadline', 'read'], 'the first reader, at its 60 s');
  assert.equal(signals[0].aborted, false, 'not cancelled while the joiner waits');
  clock.advance(29_999);
  assert.equal(await within(joiner), PENDING, 'the joiner, 59.999 s after it joined');
  clock.advance(1);
  assert.deepEqual(deadlineOf(await within(joiner)), ['unavailable', 'read_deadline', 'read'], 'released 60 s after it joined');
  assert.equal(signals[0].aborted, true, 'the last reader to leave cancelled the read');
  assert.equal(signals.length, 1, 'one read for both');
});

// ---------------------------------------------------------------------------
// What the source tree may not contain
// ---------------------------------------------------------------------------

function sources(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

test('no private API path, no signing or value transfer, no markup injection, no provider URL use', async () => {
  const found = [];
  for (const file of sources()) {
    const code = readFileSync(file, 'utf8');
    for (const pattern of [
      /\/v1\/read\//,
      /:8876/,
      /127\.0\.0\.1/,
      /eth_sendTransaction|eth_sendRawTransaction|writeContract|sendCalls|eth_signTypedData|\.approve\(/,
      /dangerouslySetInnerHTML|innerHTML/,
      /\.sourceUrl\b/,
    ]) {
      // 2026-09-24: /finance/position.ts joins on purpose, the owner's collect and close sent to Uniswap's pinned PositionManager.
      // 2026-09-25: /finance/batch.ts joins on purpose, the one module that offers an owner's batch (wallet_sendCalls) for setup.ts and sequence.ts.
      // 2026-10-01 (audit C3): /wallet/walletConnectMethods.ts names what WalletConnect's transport forwards to a phone's
      // wallet, the requests the files above already make; it composes nothing (tests/session.source-guard.test.mjs).
      // 2026-10-01 (the chain2 workstream, part B): /chains/elysium/signer.ts, the second chain's closed signer, which sends
      // exactly the draft rugged97's actions service prepared, once (tests/elysium-signer.test.mjs).
      if (pattern.source.startsWith('eth_sendTransaction') && ['/finance/wallet.ts', '/finance/setup.ts', '/finance/sequence.ts', '/finance/position.ts', '/finance/batch.ts', '/wallet/walletConnectMethods.ts', '/chains/elysium/signer.ts'].some(suffix => file.replace(/\\/g, '/').endsWith(suffix))) continue;
      // Changed on purpose (data) 2026-10-02 (Domino V2, spec F7 §1.8, D15): the closed V2 modules join, held to their own
      // narrower lists in tests/session.source-guard.test.mjs: finance/v2/typedData.ts (the one EIP-712 signer) and the
      // shared sender and the three clients (transact, zap, vault, autoExit). Nothing under src/v2 is exempt.
      // Changed on purpose (data) 2026-10-02 (Domino V2 PHASE B, B5 S2): finance/v2/crosschain.ts, the closed sender of a
      // deposit's approval and deposit on its origin chain, joins them, held to its own list in the same guard.
      // Changed on purpose (data) 2026-10-02 (Domino V2 S1, B2.4): finance/v2/direct.ts joins, the owner's direct exit at
      // Uniswap's own position manager (spec F7 §2.6.4), held to the same list in tests/session.source-guard.test.mjs.
      if (pattern.source.startsWith('eth_sendTransaction') && /\/finance\/v2\/(typedData|transact|zap|vault|autoExit|crosschain|direct)\.ts$/.test(file.replace(/\\/g, '/'))) continue;
      if (pattern.test(code)) found.push(`${file.slice(SRC.length)}: ${pattern}`);
    }
  }
  assert.deepEqual(found, []);

  // The one signature this app ever asks a wallet for is the SIWE login
  // message, and only the wallet port may name it. It is not in the list
  // above because, unlike every method there, it moves nothing: it proves an
  // address is controlled and authorises no transfer, approval or call.
  const signers = sources()
    .filter((file) => /personal_sign/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(SRC.length).replace(/\\/g, '/'));
  // 2026-10-01 (audit C3): and WalletConnect's forward list, which passes the port's request to a phone's wallet.
  assert.deepEqual(signers, ['/wallet/port.ts', '/wallet/walletConnectMethods.ts'], 'only the wallet port may name the login signature');

  // The deployable app still has only its read and session clients. #132
  // adds one reviewed serve-only diagnostic fetch, not a general exception
  // for components or new routes. Check its exact destination and build gate
  // as well as retaining the complete source-tree fetcher allowlist.
  const fetchers = sources().filter((file) => /\bfetch\(/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(SRC.length).replace(/\\/g, '/'));
  // The product now consumes onboarding-v1 (New position's deposit amounts, Setup's swap quote), deliberately
  // through the financial client's same-origin fetch (/finance/http.ts), so no new fetcher joins this list.
  const diagnosticPath = '/components/read/LocalDevelopmentBanner.tsx';
  // Changed on purpose (2026-09-25): the chain's public RPC answers 429 to every call from Cloudflare's shared egress,
  // so the site's routes that read it for the page (functions/api/owned/v2/positions.ts, functions/api/fees/v1/*)
  // failed in production and Positions listed nothing. The page now reads the chain itself, with those routes' own
  // code (functions/_lib/walletPositions.ts, owned.ts and fees.ts, imported as pure modules): /lib/walletPositions.ts
  // (the wallet's positions, replacing its same-origin POST) and /lib/fees/client.ts (a position's state and the fees
  // history's logs, replacing its two) no longer fetch at all. Their one fetcher is /lib/chain/browser.ts, pinned below
  // to the RPC's fixed URL, with no credentials and no referrer; the RPC is named in the page's and the fees worker's
  // connect-src (functions/_middleware.ts). The routes stayed, tested, and nothing on the page asked them; they were
  // retired on 2026-10-01 (platform workstream, D8), and their code runs in the page alone.
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.7, the owner's rule: nothing is read from a public RPC): the routes are
  // back (functions/api/**, over Domino's own node at the edge), the page asks them through /lib/edge/chainRoutes.ts
  // (pinned below), and /lib/chain/browser.ts, its router and its endpoints are gone: the page reads no RPC.
  // 2026-09-25, later (the automation state off the edge): a position's feature, plain, Auto-compound or Domino-compound,
  // and whether its sequence is paused, no longer comes from the site's POST /api/automation/v1/state, which reads the
  // chain from Cloudflare's edge and so could never answer in production. /lib/automationState.ts runs that route's own
  // scan (functions/_lib/automation.ts) through the chain code, like the wallet's positions and a position's state, and
  // leaves this list: automationState no longer fetches (pinned below with the modules that do not).
  // 2026-10-01 (platform workstream, D1): /lib/staleRelease.ts asks the site's own page, once, after a file of the page
  // failed to load, which release it serves now: a same-origin GET of `/`, the request a reload makes, with no body and
  // nothing but the page read back (pinned below).
  const releasePath = '/lib/staleRelease.ts';
  // 2026-10-01 (the chain2 workstream, part B): /chains/elysium/transport.ts, the second chain's section's one network
  // call: the registry's Elysium RPC (no credentials, no referrer) and this site's own /uniswap-v3/{read,actions}/v1/<route>
  // (same-origin), and nothing else (pinned below, and in tests/elysium-transport.test.mjs).
  const elysiumPath = '/chains/elysium/transport.ts';
  assert.deepEqual(fetchers, [elysiumPath, diagnosticPath, '/finance/http.ts', '/lib/edge/chainRoutes.ts', '/lib/read/bridgeSource.ts', releasePath, '/lib/tokenArtwork.ts', '/screens/LivePreview.tsx', '/wallet/session.ts'], 'product clients, the financial client, the site\'s own chain routes, the second chain\'s section\'s, serve-only diagnostics, the release check, the consumer-test preview, and the explicitly authorized decorative token metadata client');
  const elysiumClient = readFileSync(join(SRC, elysiumPath), 'utf8');
  assert.deepEqual([...elysiumClient.matchAll(/\bfetch\(([^)]*)\)/g)].map((match) => match[1]), [
    "url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }",
    "path, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store' }",
  ], 'the chain\'s RPC with no credentials and no referrer, and this site\'s own route');
  assert.match(elysiumClient, /const RPC_URLS: ReadonlySet<string> = new Set\(\[ELYSIUM\.rpc\.primary\.url, \.\.\.ELYSIUM\.rpc\.fallbacks\.map\(\(endpoint\) => endpoint\.url\)\]\)/, 'the RPCs are the registry\'s');
  assert.match(elysiumClient, /import \{ ELYSIUM \} from '\.\.\/\.\.\/config\/chainElysium'/);
  assert.match(elysiumClient, /const API_PATH = \/\^\\\/uniswap-v3\\\/\(\?:read\|actions\)\\\/v1\\\/\[a-z\]\[a-z-\]\{0,63\}\$\//, 'only his two families, version 1, one route');
  // Changed on purpose 2026-10-02 (review of the RPC switch, finding 1): and the registry's RPC too, a public node, while
  // the section has no source of rugged97's (mode.ts SECTION_READS).
  assert.match(elysiumClient, /rpc: \(url, init\) => \(SECTION_READS && RPC_URLS\.has\(url\) \? fetch\(/, 'the public RPC only once the section may read, and any other URL refused before anything is sent');
  assert.match(elysiumClient, /import \{ SECTION_READS \} from '\.\/mode'/);
  assert.match(elysiumClient, /api: \(path, init\) => \(API_PATH\.test\(path\) \? fetch\(/);
  assert.doesNotMatch(elysiumClient, /['"`]https?:\/\/|\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|localStorage|sessionStorage|indexedDB)\b/, 'no host of its own and no other network client or storage');
  const releaseClient = readFileSync(join(SRC, releasePath), 'utf8');
  assert.deepEqual([...releaseClient.matchAll(/\bfetch\(([^)]*)/g)].map((match) => match[1]), [
    "'/', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' } }",
    'input, init',
  ], 'the site\'s own page, read for its entry, through the page\'s own fetch');
  // RPC-SPEC Phase 0: /lib/edge/chainRoutes.ts, the page's and the fees worker's client for Domino's own chain routes:
  // fixed same-origin paths, this site's cookies, and nothing else.
  const routesClient = readFileSync(join(SRC, 'lib/edge/chainRoutes.ts'), 'utf8');
  assert.deepEqual([...routesClient.matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1]), ['ROUTES[route], init', 'ROUTES[route], init'], 'one call, to a fixed path');
  assert.match(routesClient, /credentials: 'same-origin'/, 'the beta cookie goes with it');
  assert.doesNotMatch(routesClient, /['"`]https?:\/\/|\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|localStorage|sessionStorage|indexedDB)\b|\beth_[A-Za-z]/, 'no host, no other network client, no storage, no JSON-RPC method');
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the ledger route, in place of the fees replay's logs route.
  assert.deepEqual([...routesClient.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]), ['/api/owned/v2/positions', '/api/fees/v1/state', '/api/fees/v2/ledger', '/api/automation/v1/state', '/api/automation/v1/record', '/api/chain/v1/simulate', '/api/chain/v1/confirmation'], 'the fixed routes, and only them');
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.2): the page's router to the chain's public RPC (lib/chain/browser.ts,
  // failover.ts, endpoints.ts) is gone, and with it its pins (one fetch, its channels, its fallbacks' trust check).
  for (const gone of ['lib/chain/browser.ts', 'lib/chain/failover.ts', 'lib/chain/endpoints.ts']) assert.ok(!sources().some((file) => file.replace(/\\/g, '/').endsWith(`/src/${gone}`)), `${gone} is gone`);
  assert.match(readFileSync(join(SRC, 'lib/chain/chainCode.ts'), 'utf8'), /^export \{ readOnChain, simulateOnChain \} from '\.\.\/walletReads'$/m, 'the chain code chunk is the wallet feature\'s two functions only');
  // 2026-09-28: the registry. Changed on purpose 2026-10-01 (RPC-SPEC §7.1): the three public fallbacks are gone; the
  // chain's official RPC stays, for the wallet's "add network" alone (src/wallet/chain.ts), and no CSP names it.
  const identities = readFileSync(join(SRC, 'config/chainIdentity.ts'), 'utf8');
  assert.deepEqual([...identities.matchAll(/['"`](https?:\/\/[^'"`]*)['"`]/g)].map((m) => m[1]), ['https://robinhoodchain.blockscout.com', 'https://rpc.mainnet.chain.robinhood.com'], 'the explorer and the chain\'s official RPC, each handed to a wallet and never fetched, and no other host');
  assert.match(identities, /^export const ROBINHOOD_RPC_URL = 'https:\/\/rpc\.mainnet\.chain\.robinhood\.com'$/m);
  const registry = readFileSync(join(SRC, 'config/chainRobinhood.ts'), 'utf8');
  assert.doesNotMatch(registry, /['"`]https?:\/\//, 'the record takes its URL from the identities');
  assert.match(registry, /export const PRIMARY: Endpoint = \{\n\s*url: ROBINHOOD_RPC_URL,/, 'the official RPC, for the wallet');
  assert.doesNotMatch(registry, /\bexport const (?:PUBLICNODE|ORDOFI|DRPC|FALLBACKS|ORDER|LANE_PACE)\b/, 'no fallback, no order, no lane pace');
  for (const text of [identities, registry]) assert.doesNotMatch(text, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b(?!\s+TypeError)/, 'the registry is data');
  // The page's and the fees worker's connect-src. Changed on purpose 2026-10-01 (RPC-SPEC §7.4): no chain RPC host; the
  // page reaches the site, the artwork host and WalletConnect's relay, the fees worker the site alone.
  // Changed on purpose 2026-10-01 (platform workstream): the CSPs are data (APP_CSP_SOURCES, CHAIN_RPC_HOSTS), so the
  // headers they make are checked, from the compiled middleware, rather than the source's text.
  // 2026-10-01 (audit C3): the page's also names WalletConnect's relay, for a phone's wallet (not a chain endpoint),
  // with the page's own sources, before the chain's (src/lib/chain/csp.ts PAGE_CONNECT_BASE).
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees worker is gone, and its CSP with it.
  const middleware = require('../.test-build/app/functions/_middleware.js');
  assert.ok(middleware.APP_CSP.split('; ').includes("connect-src 'self' https://api.dexscreener.com wss://relay.walletconnect.org"), 'the page’s CSP');
  assert.equal(middleware.WORKER_CSP, undefined, 'no fees worker, no worker CSP');
  const owned = readFileSync(join(SRC, '../functions/_lib/owned.ts'), 'utf8');
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): the registry's (pinned above).
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.3): a sentinel, not a URL; only the edge's transport answers it.
  assert.match(owned, /^export const RPC_URL = 'local-rpc:robinhood'$/m, 'the chain code\'s one name for its reads, which no browser can fetch');
  // What the page runs against it can only read: the methods the three modules name are the four reads, and never a
  // send, a signature or a subscription. 2026-09-25: the price path's reads (feesPath.ts, the replay worker's) join them.
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the price path is gone; the fees ledger's reads (feesLedger.ts) join.
  for (const file of ['owned.ts', 'walletPositions.ts', 'fees.ts', 'automation.ts', 'feesLedger.ts', 'vaultRecord.ts']) {
    const code = readFileSync(join(SRC, '../functions/_lib', file), 'utf8');
    const methods = [...new Set([...code.matchAll(/['"`]((?:eth|net|web3|wallet|personal|debug|txpool)_[A-Za-z]+)['"`]/g)].map((match) => match[1]))].sort();
    assert.ok(methods.every((method) => ['eth_blockNumber', 'eth_call', 'eth_getBlockByNumber', 'eth_getLogs'].includes(method)), `${file} names ${methods.join(', ')}`);
    assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB|document\.|window\.|__DOMINO_)\w*/, `${file} stays a pure module: no storage, no DOM, no build flag`);
  }
  // 2026-09-25 (review of r3/chain): the fees client is split so the page loads the chain code lazily
  // (lib/chain/chainCode.ts) while the replay worker, a single classic file, carries its own: answers.ts holds the
  // build check and the answers' checks, logs.ts the log read both share. None of them fetches.
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the replay worker, its pipeline, estimate and log read are gone; the
  // ledger's fold (lib/fees/ledger.ts) and the store take their place, and fetch nothing either.
  for (const path of ['lib/walletPositions.ts', 'lib/automationState.ts', 'lib/fees/client.ts', 'lib/fees/answers.ts', 'lib/chain/chainCode.ts', 'lib/fees/ledger.ts', 'lib/fees/store.ts']) {
    const code = readFileSync(join(SRC, path), 'utf8');
    assert.doesNotMatch(code, /fetch\(/, `${path} names no fetch of its own, not even in a comment`);
    assert.doesNotMatch(code, /['"`]\/api\/(?:owned|fees|automation)\//, `${path} asks no route of the site`);
    assert.doesNotMatch(code, /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/, `${path}: no other network client and no storage`);
  }
  const feesClient = readFileSync(join(SRC, 'lib/fees/answers.ts'), 'utf8');
  assert.match(feesClient, /function chainRead\(\): boolean \{\n  return __DOMINO_DEPLOYABLE__ \|\| __DOMINO_TEST_HOOKS__\n\}/, 'asked only in builds meant to reach the chain, decided inside the call');
  // Changed on purpose 2026-10-02: both of the client's asks (its state and its ledger) decide it first.
  assert.equal([...readFileSync(join(SRC, 'lib/fees/client.ts'), 'utf8').matchAll(/if \(!chainRead\(\) \|\| signal\?\.aborted\) return UNAVAILABLE/g)].length, 2, 'lib/fees/client.ts asks nothing in a build not meant to reach the chain');
  const automationClient = readFileSync(join(SRC, 'lib/automationState.ts'), 'utf8');
  assert.match(automationClient, /function chainRead\(\): boolean \{\n  return __DOMINO_DEPLOYABLE__ \|\| __DOMINO_TEST_HOOKS__\n\}/, 'the automation state is asked only in builds meant to reach the chain');
  assert.match(automationClient, /if \(!chainRead\(\) \|\| ids\.length === 0/, 'decided inside the call');
  assert.match(automationClient, /= postAutomation\): Promise<AutomationAnswer \| null> \{/, 'RPC-SPEC D3: through the site\'s own route (lib/edge/chainRoutes.ts), no chain code of its own');

  const diagnostics = readFileSync(join(SRC, diagnosticPath), 'utf8');
  assert.equal([...diagnostics.matchAll(/\bfetch\s*\(/g)].length, 1, 'exactly one diagnostic fetch call');
  assert.match(diagnostics, /fetch\('\/api\/dev\/v1\/status', \{ credentials: 'omit', cache: 'no-store', signal: controller\.signal \}\)/, 'fixed same-origin status GET, without credentials or configurable target');
  assert.deepEqual([...diagnostics.matchAll(/['"`](https?:\/\/[^'"`]+|\/api\/[^'"`]+)['"`]/g)].map((match) => match[1]), ['/api/dev/v1/status'], 'no other network route in the diagnostic component');
  assert.doesNotMatch(diagnostics, /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, 'no alternate diagnostic network client');

  const consumers = sources().filter((file) => /\bLocalDevelopmentBanner\b/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(SRC.length).replace(/\\/g, '/'));
  assert.deepEqual(consumers, ['/App.tsx', diagnosticPath], 'no other entry point can mount the diagnostic component');
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
  assert.equal([...app.matchAll(/<LocalDevelopmentBanner\b/g)].length, 1);
  assert.match(app, /\{__DOMINO_LOCAL_LIVE__\s*\?\s*<LocalDevelopmentBanner\s*\/>/, 'diagnostics mount only behind the serve-only build literal');

  const { resolveConfig } = await import('vite');
  const root = resolve(SRC, '..');
  for (const mode of ['production', 'development']) {
    const config = await resolveConfig({ root, configFile: join(root, 'vite.config.ts'), mode, logLevel: 'silent' }, 'build');
    assert.equal(config.define.__DOMINO_LOCAL_LIVE__, 'false', `${mode} folds the diagnostic branch away`);
    const guard = config.plugins.find((plugin) => plugin.name === 'domino:deployable-bundle-check');
    assert.ok(guard, `${mode} checks emitted and copied assets`);
    assert.throws(() => guard.generateBundle.call({}, {}, { 'assets/diagnostic.js': { type: 'chunk', fileName: 'assets/diagnostic.js', code: diagnostics } }), /deployable and carries what must never ship/, `${mode} refuses diagnostic code if it reaches the bundle`);
  }
});

test('no source file carries a control character, so git and review see it as text', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.(ts|tsx|mjs|js|css|html|json)$/.test(entry.name)) files.push(join(dir, entry.name));
    }
  };
  walk(SRC);
  const app = resolve(SRC, '..');
  files.push(...['index.html', 'read-lab.html', 'vite.config.ts'].map((name) => join(app, name)));
  // Tab, LF and CR are text. Any other C0 control or DEL makes git call the file binary, or hides a character from review.
  const hasControl = (text) => [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
  const found = files.filter((file) => hasControl(readFileSync(file, 'utf8'))).map((file) => file.slice(app.length).replace(/\\/g, '/'));
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  assert.deepEqual(found, []);
});

test('every failure state has words, and only the gate asks to sign in', () => {
  const failures = [
    { state: 'gate_required' },
    { state: 'gate_unavailable' },
    { state: 'access_required' },
    { state: 'incompatible', reason: 'contract_header_missing' },
    { state: 'invalid', reason: 'identity_mismatch' },
    { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false },
    { state: 'unavailable', cause: { kind: 'read_deadline', limit: 'attempt' }, retryable: true },
    { state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true },
    { state: 'busy', retryAfterSeconds: 7 },
    { state: 'restart_required', code: 'invalid_or_expired_cursor' },
    { state: 'request_rejected', code: 'invalid_request', status: 422 },
    { state: 'disabled', reason: 'live_data_disabled' },
    { state: 'disabled', reason: 'bridge_data_mode_disabled' },
    { state: 'not_connected', reason: 'bridge_unavailable' },
    { state: 'not_connected', reason: 'not_found' },
    { state: 'not_connected', reason: 'worker_subrequest_refused' },
    { state: 'not_connected', reason: 'no_forwarder' },
    { state: 'aborted' },
  ];
  for (const failure of failures) {
    const words = describeFailure({ route: 'token', provenance: { attempts: 1 }, ...failure });
    assert.ok(words.title && words.detail, failure.state);
    assert.equal(Boolean(words.signIn), failure.state === 'gate_required', failure.state);
    // A final product: no state calls the site a beta or says something is to come.
    assert.doesNotMatch(`${words.title} ${words.detail}`, /\bbeta\b|\byet\b/i, failure.state);
  }
  assert.match(describeFailure({ route: 'token', provenance: {}, state: 'busy', retryAfterSeconds: 7 }).detail, /7 s/);
  const late = (limit) => describeFailure({ route: 'token', provenance: {}, state: 'unavailable', cause: { kind: 'read_deadline', limit }, retryable: true });
  assert.match(late('attempt').detail, /did not answer within 20 s/);
  assert.match(late('read').detail, /Stopped after 60 s, time spent queued included/);
  assert.equal(late('read').retry, true, 'a person may try again');
});
