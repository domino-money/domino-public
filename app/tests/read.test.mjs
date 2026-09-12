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
const { createScheduledSource } = built('scheduler');
const { describeFailure, reasonText } = built('describe');
const decimal = built('decimal');
const project = built('project');
const pagers = built('pagers');
const scenarios = built('scenarios');
const { loadSelectedPools, createReadMarketsProvider, tableMarketRequest } = built('marketsProvider');
const markets = require('../.test-build/app/src/lib/markets.js');
const middleware = require('../.test-build/app/functions/_middleware.js');

const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1');
const SRC = resolve(import.meta.dirname, '../src');
const text = (path) => readFileSync(join(READ, path), 'utf8');
const INDEX = JSON.parse(text('fixtures/index.json'));
const catalog = { index: INDEX, text };
const { FIXTURE_POOL, FIXTURE_TOKEN, NATIVE, MUTATED_CURSOR, gateway, errorFixture, invalidFixture, requestFor } = scenarios;

const ROUTES = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics'];
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
    if (entry.route === 'catalogue') {
      assert.equal(outcome.observation.block, null);
      assert.deepEqual(outcome.observation.interval, { startBlock: 10, indexedThrough: 650, coverage: 'configured_interval_only' });
      assert.equal(outcome.observation.revision, 2);
    } else {
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
  const NOT_CONNECTED = 'Live data isn\'t connected yet';
  assert.deepEqual(words({ state: 'not_connected', reason: 'bridge_unavailable' }), [NOT_CONNECTED, false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'no_forwarder' }), [NOT_CONNECTED, false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'not_found' }), ['Live data isn\'t available on this address', false, false]);
  assert.deepEqual(words({ state: 'not_connected', reason: 'worker_subrequest_refused' }), ['Request refused', false, false]);
  for (const reason of ['bridge_data_mode_disabled', 'route_not_enabled', 'live_data_disabled']) {
    assert.deepEqual(words({ state: 'disabled', reason }), ['Live data is switched off for now', false, false], reason);
  }
  assert.deepEqual(words({ state: 'gate_required' }), ['Beta access needed', false, true]);
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
  assert.match(outcome.provenance.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(bridge.browser.map((r) => [r.init.method, r.path]), [['GET', '/api/read/v1/capabilities'], ['POST', '/api/read/v1/pool-market']]);
  await source.read('token', tokenRequest);
  assert.equal(bridge.browser.filter((r) => r.init.method === 'GET').length, 1, 'capabilities are asked once');
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
  assert.deepEqual(Object.keys(second.view).sort(), ['freshness', 'hasMore', 'notes', 'pages', 'restarted', 'rows', 'unavailable']);
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
  assert.equal(reasonText('fee_apr_not_provided'), 'APR not provided by the read service yet');
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

  assert.equal(markets.aprLabel(market.feeAprPercent).text, '158.06% APR');
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
  assert.match(byLabel['Price history (GeckoTerminal)'].text, /cache 0 s/);
  assert.equal(view.facts.some((f) => /24h (volume|figure)/i.test(f.label) && f.label !== '24h volume'), false);
  const stale = project.projectPoolMarket(JSON.parse(text(gateway('pool-market.stale'))));
  assert.equal(stale.facts.find((f) => f.label === 'Price history (GeckoTerminal)').state, 'stale');
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
  assert.equal(fact(view('pools', 'pools.provider-unavailable'), 'Discovery (DexScreener)').state, 'partial');
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

  // An abandoned read, restarted by the next viewer.
  const again = holdable(providerCase);
  const restarted = createReadMarketsProvider({ source: again.source, poolIds: [FIXTURE_POOL], kind: 'fixture', now: () => 5_000_000 });
  assert.equal((await settled(restarted, () => restarted.ensure())).phase, 'ready');
  again.hold();
  const leaving = restarted.subscribe(() => undefined);
  restarted.refresh();
  assert.equal(restarted.getSnapshot().previous.markets[0].tvlUsd.state, 'provider', 'a refresh of current rows keeps them as they are');
  leaving();
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

test('D4: the last viewer leaving the deferred provider releases its inner subscription, which cancels the read; a viewer who returns reads again', async () => {
  const { deferredMarkets } = built('deferredMarkets');
  const reads = gated(scenarios.MARKET_CASES.find((c) => c.id === 'provider').script);
  const inner = counted(createReadMarketsProvider({ source: reads.source, poolIds: [FIXTURE_POOL], kind: 'fixture' }));
  let loads = 0;
  const provider = deferredMarkets('fixture', async () => ((loads += 1), inner.provider));

  reads.hold();
  const viewer = provider.subscribe(() => undefined);
  provider.ensure();
  await until(() => reads.counts.held === 1, 'the first read, held');
  assert.equal(inner.active(), 1, 'one inner subscription while someone looks');
  viewer();
  assert.equal(inner.active(), 0, 'the last viewer leaving released the inner subscription');
  assert.equal(reads.counts.aborted, 1, 'and the read nobody waited for was cancelled');

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
// without price history, then each distinct token once. No pool-metrics, one
// capabilities GET per source, strictly one read at a time, and no cache.
// ---------------------------------------------------------------------------

const POOL_A = `0x${'a1'.repeat(32)}`;
const POOL_Z = `0x${'b2'.repeat(32)}`;
const TOKEN_Y = `0x${'22'.repeat(20)}`;
const TOKEN_Z = `0x${'33'.repeat(20)}`;
/** Two pools that share one currency: A/Y and Y/Z, where A is the native currency. Test data only. */
const BUDGET_POOLS = { [POOL_A]: [NATIVE, TOKEN_Y], [POOL_Z]: [TOKEN_Y, TOKEN_Z] };
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

test('the table’s load is N pool-market reads without price history plus U distinct token reads, one at a time, and never pool-metrics', async () => {
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
  // Nothing is kept between loads: the next load reads everything again.
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
});

test('the selected pools are exactly the two chain-4663 ids rugged97 chose on #45, and the config holds ids only', () => {
  const { SELECTED_POOLS } = require('../.test-build/app/src/config/selectedPools.js');
  assert.deepEqual(SELECTED_POOLS, [
    '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7',
  ]);
  for (const id of SELECTED_POOLS) assert.match(id, /^0x[0-9a-f]{64}$/);
  const code = readFileSync(join(SRC, 'config/selectedPools.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /symbol|label|name|weth|usdg|marlin|tvl|volume|apr|price/i, 'no labels, symbols or figures');
  assert.deepEqual(code.match(/0x[0-9a-f]+/g), SELECTED_POOLS, 'nothing but the two ids');
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
  const source = createScheduledSource(createBridgeSource({ enabled: true, validators: runtime, fetch, clock }), { clock });
  const [token, metrics] = await Promise.all([source.read('token', tokenRequest), source.read('pool-metrics', { poolId: FIXTURE_POOL })]);
  assert.deepEqual([token.state, token.provenance.attempts, metrics.state], ['ok', 2, 'ok']);
  // The retry waits the bridge's Retry-After; the next read waits the queue's 1.1 s from that retry.
  assert.deepEqual(starts, [[0, 'token'], [1000, 'token'], [2100, 'pool-metrics']]);
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

test('no private API path, no signing or value transfer, no markup injection, no provider URL use', () => {
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
  assert.deepEqual(signers, ['/wallet/port.ts'], 'only the wallet port may name the login signature');

  // Two clients reach the network, each to its own family on this origin: the
  // read adapter through /api/read/v1/, and the session client through
  // /api/session/v1/. A third thing that fetches is a path nobody reviewed,
  // which is what this guard exists to catch.
  const fetchers = sources().filter((file) => /\bfetch\(/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(SRC.length).replace(/\\/g, '/'));
  assert.deepEqual(fetchers, ['/lib/read/bridgeSource.ts', '/wallet/session.ts'], 'only the read adapter and the session client fetch');
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
  }
  assert.match(describeFailure({ route: 'token', provenance: {}, state: 'busy', retryAfterSeconds: 7 }).detail, /7 s/);
  const late = (limit) => describeFailure({ route: 'token', provenance: {}, state: 'unavailable', cause: { kind: 'read_deadline', limit }, retryable: true });
  assert.match(late('attempt').detail, /did not answer within 20 s/);
  assert.match(late('read').detail, /Stopped after 60 s, time spent queued included/);
  assert.equal(late('read').retry, true, 'a person may try again');
});
