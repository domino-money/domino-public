import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as v1 from '../../api-contracts/read-v1/runtime.mjs';
import * as v2 from '../../api-contracts/read-v2/runtime.mjs';
const require = createRequire(import.meta.url);
const built = (file) => require(`../.test-build/app/src/lib/read/${file}.js`);
const { createEstimateSource } = built('estimateSource');
const { createScheduledSource } = built('scheduler');
const { loadSelectedPools, retainAsStale } = built('marketsProvider');
const { presentAprEstimate, estimateTitle, limitationText, ESTIMATE_SCOPE } = built('aprEstimate');
const { chartMatches, candleGeometry } = built('chart');
const { interpretReply } = built('interpret');
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v2/fixtures/producer/pool-market.${name}.json`, import.meta.url)));
const old = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url)));
const good = fixture('available');
const id = good.poolId;
const caps = (version, enabled = true) => ({ contractVersion: version, dataMode: enabled ? 'live_read_only' : 'disabled', chainId: 4663, enabledReads: enabled ? version === v2.CONTRACT_VERSION ? ['pool-market'] : ['pool-market', 'token'] : [], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false });
const response = (body, version = v2.CONTRACT_VERSION, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': version } });
function setup(override = () => null) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const changed = await override(url, init);
    if (changed) return changed;
    if (url.endsWith('capabilities')) return response(caps(url.includes('/v2/') ? v2.CONTRACT_VERSION : v1.CONTRACT_VERSION), url.includes('/v2/') ? v2.CONTRACT_VERSION : v1.CONTRACT_VERSION);
    if (url.includes('/v2/')) return response(good);
    if (url.endsWith('/token')) return response(old(JSON.parse(init.body).token === '0x0000000000000000000000000000000000000000' ? 'token.native' : 'token.success'), v1.CONTRACT_VERSION);
    return response(good.market, v1.CONTRACT_VERSION);
  };
  return { calls, source: createEstimateSource({ enabled: true, validators: v1, fetch }, v2) };
}
const observe = (data) => ({ data, receivedAt: 0, receivedMonotonic: 0 });
const now = (seconds) => ({ wall: seconds * 1000, monotonic: seconds * 1000 });

test('v2 supplies one market+estimate; row keeps historical APR separate and tokens use v1', async () => {
  const { source, calls } = setup();
  const loaded = await loadSelectedPools(source, [id]);
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0].feeAprPercent.state, 'unavailable');
  assert.equal(loaded.rows[0].feeAprEstimate.data.feeAprEstimate24hPercent, '10.95');
  assert.deepEqual(calls.filter((c) => c.url.endsWith('/pool-market')).map((c) => [c.url, JSON.parse(c.init.body)]), [['/api/read/v2/pool-market', { poolId: id }]]);
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 2);
});

test('available, exact zero, tiny positive and unavailable never replace one another', () => {
  assert.equal(presentAprEstimate(observe(good.estimate), now(0)).text, '10.95');
  assert.equal(presentAprEstimate(observe(fixture('zero-volume').estimate), now(0)).text, '0.00');
  const tiny = { ...good.estimate, feeAprEstimate24hPercent: '0.000000000000000001' };
  assert.equal(presentAprEstimate(observe(tiny), now(0)).text, '<0.01');
  // T1.4: the equal-fee protocol fixture is available now — its adjusted value shows.
  assert.equal(presentAprEstimate(observe(fixture('protocol-fee').estimate), now(0)).text, '10.94');
  for (const name of ['zero-tvl', 'missing-tvl', 'invalid-protocol-fee', 'dynamic', 'expired']) assert.equal(presentAprEstimate(observe(fixture(name).estimate), now(0)).text, null, name);
});

test('estimates age on screen, expire after 300 seconds and ignore wall-clock jumps', () => {
  const o = observe(good.estimate);
  assert.equal(presentAprEstimate(o, now(59)).state, 'available');
  assert.equal(presentAprEstimate(o, now(60)).state, 'stale');
  assert.equal(presentAprEstimate(o, now(61)).state, 'stale');
  const expiresAfter = 300 - Math.max(good.estimate.provenance.snapshotAgeSeconds, good.estimate.provenance.effectiveMarketAgeSeconds);
  assert.equal(presentAprEstimate(o, now(expiresAfter)).state, 'stale');
  assert.equal(presentAprEstimate(o, now(expiresAfter + 1)).text, null);
  assert.equal(presentAprEstimate(o, { wall: 999999999999, monotonic: 1000 }).state, 'available');
  assert.equal(presentAprEstimate(observe(fixture('cache-300').estimate), now(1)).text, null);
  assert.equal(presentAprEstimate(observe(fixture('snapshot-300').estimate), now(1)).text, null);
});

test('G14: an estimate’s title is its own limitations, then why it is stale or unavailable; with none, what it would be and why there is none', () => {
  const title = estimateTitle(observe(good.estimate), now(0));
  assert.deepEqual(good.estimate.limitations.map(limitationText).join(' '), title, 'every limitation the payload carries, in its order, and nothing else while it is current');
  assert.match(title, /^From a market data provider’s reported 24h volume and TVL, not reconciled\. .* Pool estimate, not position APR or APY\. Not a return forecast or a recommendation\.$/);
  assert.equal(estimateTitle({ ...observe({ ...good.estimate, limitations: ['no_full_day_coverage_proof'] }) }, now(0)), 'Full-day coverage is not proven.', 'the payload decides, not a caveat written in the app');
  assert.match(estimateTitle(observe(good.estimate), now(60)), / Provider inputs are stale\. Stale, not current\.$/);
  assert.match(estimateTitle(observe(fixture('protocol-fee').estimate), now(0)), /The protocol fee’s effect is not reconciled\./);
  const unavailable = estimateTitle(observe(fixture('invalid-protocol-fee').estimate), now(0));
  assert.match(unavailable, / The protocol fee could not be validated\.$/);
  for (const [reason, words] of [['estimate_not_enabled', 'Estimated APR is not enabled on this connection.'], ['estimate_transport_unavailable', 'Estimated APR is unavailable; market figures use the supported read connection.'], ['estimate_not_in_snapshot', 'Estimated APR is read with the pool’s own market figures, not with stored ones.']]) {
    assert.equal(estimateTitle({ data: null, reason, receivedAt: 0 }, now(0)), `${ESTIMATE_SCOPE} ${words}`, reason);
  }
  assert.equal(estimateTitle(undefined, now(0)), `${ESTIMATE_SCOPE} Estimated APR is not enabled on this connection.`);
  assert.equal(limitationText('a_future_limitation'), 'a future limitation.', 'a code this build does not know is plain words, never dropped');
});

test('a failed refresh marks retained estimates stale without resetting their expiry', () => {
  const m = { feeAprEstimate: observe(good.estimate), tvlUsd: { state: 'unavailable', value: null }, volume24hUsd: { state: 'unavailable', value: null }, feeAprPercent: { state: 'unavailable', value: null } };
  const retained = retainAsStale({ markets: [m] }, 250000).markets[0];
  assert.equal(presentAprEstimate(retained.feeAprEstimate, now(1)).state, 'stale');
  assert.equal(presentAprEstimate(retained.feeAprEstimate, now(301)).text, null);
});

for (const mode of ['disabled', 'absent', 'unavailable']) test(`v2 ${mode} capabilities fall back before any data POST, once per page`, async () => {
  const { source, calls } = setup((url) => !url.includes('/v2/') ? null : mode === 'disabled' ? response(caps(v2.CONTRACT_VERSION, false)) : mode === 'absent' ? new Response('{"error":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }) : response({ error: 'upstream_unavailable' }, v2.CONTRACT_VERSION, 503));
  for (let i = 0; i < 2; i++) { const r = await source.read('pool-market', { poolId: id, includePriceHistory: false }); assert.equal(r.state, 'ok'); assert.equal(r.estimate, undefined); }
  assert.equal(calls.filter((c) => c.url.includes('/v2/')).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/pool-market')).every((c) => c.url.includes('/v1/')), true);
});

test('v2 data failure and malformed replies do not trigger another real market read', async () => {
  for (const payload of [{ error: 'upstream_unavailable' }, { ...good, poolId: `0x${'f'.repeat(64)}` }]) {
    const { source, calls } = setup((url) => url.endsWith('/pool-market') ? response(payload, v2.CONTRACT_VERSION, payload.error ? 503 : 200) : null);
    const result = await source.read('pool-market', { poolId: id });
    assert.notEqual(result.state, 'ok');
    assert.equal(calls.filter((c) => c.url.endsWith('/pool-market')).length, 1);
  }
});

test('a v2 reply whose estimate the runtime refuses keeps its read-v1-valid market figures, without an estimate and without another read', async () => {
  // A read service on another release: the estimate does not match what this build's runtime derives from its inputs.
  const skewed = { ...good, estimate: { ...good.estimate, feeAprEstimate24hPercent: '99.99' } };
  assert.equal(v2.validateResponse('pool-market', skewed), false, 'the fixture must fail the v2 contract');
  assert.equal(v1.validateResponse('pool-market', skewed.market), true, 'while its market figures pass read-v1');
  const { source, calls } = setup((url) => url === '/api/read/v2/pool-market' ? response(skewed) : null);
  const result = await source.read('pool-market', { poolId: id });
  assert.deepEqual([result.state, result.estimate, result.estimateReason], ['ok', undefined, 'estimate_contract_mismatch']);
  assert.equal(result.data.poolId, good.market.poolId);
  assert.deepEqual(calls.filter((c) => c.url.endsWith('/pool-market')).map((c) => c.url), ['/api/read/v2/pool-market'], 'one POST, never a second read');
  // A market part that fails read-v1 too stays invalid.
  const broken = { ...skewed, market: { ...skewed.market, poolId: 'not-a-pool' } };
  const bad = setup((url) => url === '/api/read/v2/pool-market' ? response(broken) : null);
  const refused = await bad.source.read('pool-market', { poolId: id });
  assert.equal(refused.state, 'invalid');
  assert.equal(bad.calls.filter((c) => c.url.endsWith('/pool-market')).length, 1);
});

const invalidV2 = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v2/fixtures/invalid/pool-market.${name}.json`, import.meta.url)));

test('only an estimate is tolerated: a reply whose envelope is not read-v2’s stays invalid, even when its market figures would pass read-v1', async () => {
  const skewed = { ...good, estimate: { ...good.estimate, feeAprEstimate24hPercent: '99.99' } };
  const withoutEstimate = structuredClone(good);
  delete withoutEstimate.estimate;
  const cases = [
    ['the package’s invalid pool-market.version (schemaVersion 2)', invalidV2('version')],
    ['the package’s invalid pool-market.execution (executionAvailable true)', invalidV2('execution')],
    ['an extra top-level key', { ...skewed, somethingNew: true }],
    ['no estimate key at all', withoutEstimate],
    ['an estimate that is null', { ...good, estimate: null }],
    ['an estimate that is a list', { ...good, estimate: [good.estimate] }],
    ['a schemaVersion written as a string', { ...skewed, schemaVersion: '1' }],
    ['executionAvailable missing', (() => { const body = structuredClone(skewed); delete body.executionAvailable; return body; })()],
  ];
  for (const [label, body] of cases) {
    assert.equal(v2.validateResponse('pool-market', body), false, `${label}: must fail the v2 contract`);
    assert.equal(v1.validateResponse('pool-market', body.market), true, `${label}: while its market figures pass read-v1`);
    const { source, calls } = setup((url) => (url === '/api/read/v2/pool-market' ? response(body) : null));
    const result = await source.read('pool-market', { poolId: id });
    assert.deepEqual([result.state, result.reason], ['invalid', 'response_contract'], label);
    assert.equal(calls.filter((c) => c.url.endsWith('/pool-market')).length, 1, `${label}: one POST, never a second read`);
  }
  // What the tolerance is for: a read service on another release, whose estimate differs and nothing else.
  for (const name of ['apr-tampered', 'apr-float', 'limitation-removed', 'protocol-promoted', 'stale-promoted']) {
    const body = invalidV2(name);
    const { source } = setup((url) => (url === '/api/read/v2/pool-market' ? response(body) : null));
    const result = await source.read('pool-market', { poolId: id });
    assert.deepEqual([result.state, result.estimate, result.estimateReason], ['ok', undefined, 'estimate_contract_mismatch'], name);
  }
  // And identity to the request still holds: an envelope about another pool is refused.
  for (const name of ['outer-pool', 'market-pool']) {
    const { source } = setup((url) => (url === '/api/read/v2/pool-market' ? response(invalidV2(name)) : null));
    assert.equal((await source.read('pool-market', { poolId: id })).state, 'invalid', name);
  }
});

test('same scheduler coalesces v2 reads and an explicit chart stays a single v1 read', async () => {
  const { source, calls } = setup((url) => url === '/api/read/v1/pool-market' ? response(old('pool-market.success'), v1.CONTRACT_VERSION) : null);
  const queue = createScheduledSource(source, { minIntervalMs: 0 });
  const [a, b] = await Promise.all([queue.read('pool-market', { poolId: id }), queue.read('pool-market', { poolId: id })]);
  assert.equal(a.state, 'ok'); assert.equal(b.state, 'ok');
  assert.equal(calls.filter((c) => c.url.endsWith('/pool-market')).length, 1);
  const chart = await queue.read('pool-market', { poolId: id, includePriceHistory: true, priceToken: 'base' });
  assert.equal(chart.state, 'ok'); assert.equal(chart.estimate, undefined);
  assert.equal(calls.filter((c) => c.url === '/api/read/v1/pool-market').length, 1);
});

const posts = (calls) => calls.filter((c) => c.init.method === 'POST').map((c) => [c.url, JSON.parse(c.init.body)]);
const snapshotNotBuilt = () => response({ error: 'snapshot_not_built' }, v1.CONTRACT_VERSION, 503);
const storedRead = (init) => JSON.parse(init.body).fromSnapshot === true;

test('G10: a stored market read goes to read-v1 exactly as asked, never widened into a v2 read, and says the store keeps no estimate', async () => {
  const { source, calls } = setup();
  const stored = await source.read('pool-market', { poolId: id, fromSnapshot: true });
  assert.deepEqual([stored.state, stored.estimate, stored.estimateReason], ['ok', undefined, 'estimate_not_in_snapshot']);
  assert.deepEqual(calls.map((c) => c.url), ['/api/read/v1/capabilities', '/api/read/v1/pool-market'], 'no estimate namespace at all');
  assert.deepEqual(posts(calls), [['/api/read/v1/pool-market', { poolId: id, fromSnapshot: true }]]);
  // A stored read that says no is a normal read.
  const normal = await setup().source.read('pool-market', { poolId: id, fromSnapshot: false });
  assert.equal(normal.estimate.feeAprEstimate24hPercent, '10.95');
});

test('G10: a store that holds nothing for the pool answers snapshot_not_built, and that is the answer: no normal read is sent from inside the same job, so the caller’s own paced read follows', async () => {
  const { source, calls } = setup((url, init) => (url === '/api/read/v1/pool-market' && storedRead(init) ? snapshotNotBuilt() : null));
  const read = await source.read('pool-market', { poolId: id, fromSnapshot: true });
  assert.deepEqual([read.state, read.cause.code, read.retryable], ['unavailable', 'snapshot_not_built', false], 'final, so no quiet re-ask repeats the stored read');
  assert.deepEqual(posts(calls), [['/api/read/v1/pool-market', { poolId: id, fromSnapshot: true }]], 'one POST: the stored read, and no v2 or v1 read after it');

  const off = setup((url, init) => (url.includes('/v2/') ? response(caps(v2.CONTRACT_VERSION, false)) : url === '/api/read/v1/pool-market' && storedRead(init) ? snapshotNotBuilt() : null));
  const offRead = await off.source.read('pool-market', { poolId: id, fromSnapshot: true });
  assert.equal(offRead.cause.code, 'snapshot_not_built');
  assert.equal(posts(off.calls).length, 1, 'with v2 off, the same');

  const down = setup((url) => (url === '/api/read/v1/pool-market' ? response({ error: 'upstream_unavailable' }, v1.CONTRACT_VERSION, 503) : null));
  const downRead = await down.source.read('pool-market', { poolId: id, fromSnapshot: true });
  assert.deepEqual([downRead.state, downRead.cause.code], ['unavailable', 'upstream_unavailable']);
  assert.equal(posts(down.calls).length, 1, 'any other failure is the answer too');

  // The caller's normal read is its own job in the one queue, so the queue spaces it from the stored read.
  const paced = setup((url, init) => (url === '/api/read/v1/pool-market' && storedRead(init) ? snapshotNotBuilt() : null));
  const queue = createScheduledSource(paced.source, { minIntervalMs: 0 });
  assert.equal((await queue.read('pool-market', { poolId: id, fromSnapshot: true })).cause.code, 'snapshot_not_built');
  const lean = await queue.read('pool-market', { poolId: id, includePriceHistory: false });
  assert.deepEqual([lean.state, lean.estimate?.feeAprEstimate24hPercent], ['ok', '10.95']);
  assert.deepEqual(posts(paced.calls).map(([url]) => url), ['/api/read/v1/pool-market', '/api/read/v2/pool-market'], 'each read its own job');
});

test('G0: the estimate source answers routeEnabled from read-v1’s capabilities alone, never the estimate namespace', async () => {
  const listed = (url) => (url === '/api/read/v1/capabilities' ? response({ ...caps(v1.CONTRACT_VERSION), enabledReads: ['pool-market', 'token', 'markets-snapshot'] }, v1.CONTRACT_VERSION) : null);
  const { source, calls } = setup(listed);
  assert.deepEqual(await source.routeEnabled('markets-snapshot'), { state: 'enabled' });
  assert.deepEqual(await source.routeEnabled('pool-metrics'), { state: 'not_enabled' });
  assert.deepEqual(calls.map((c) => c.url), ['/api/read/v1/capabilities']);
  assert.equal(typeof createScheduledSource(source).routeEnabled, 'function', 'and the queue passes it on');
});

test('G2 with read-v2: fresh stored rows cost no v2 read and carry no estimate; a stale one is read again through v2 and carries it', async () => {
  const { createReadMarketsProvider } = built('marketsProvider');
  const settledState = (provider) => new Promise((resolve) => {
    const off = provider.subscribe(() => {
      const state = provider.getSnapshot();
      if (state.phase !== 'loading') { off(); resolve(state); }
    });
    provider.ensure();
  });
  for (const [label, observedAt, refreshed] of [['fresh', 1010, false], ['stored 400 s before the answer', 610, true]]) {
    const { source, calls } = setup((url) => {
      if (url === '/api/read/v1/capabilities') return response({ ...caps(v1.CONTRACT_VERSION), enabledReads: ['pool-market', 'token', 'markets-snapshot'] }, v1.CONTRACT_VERSION);
      if (url !== '/api/read/v1/markets-snapshot') return null;
      const stored = old('markets-snapshot.subset');
      assert.equal(stored.pools[0].poolId, id, 'the package’s snapshot stores the estimate fixture’s pool');
      stored.pools[0].observedAt = observedAt;
      return response(stored, v1.CONTRACT_VERSION);
    });
    const provider = createReadMarketsProvider({ source: createScheduledSource(source, { minIntervalMs: 0 }), poolIds: [id], kind: 'bridge' });
    const state = await settledState(provider);
    assert.equal(state.phase, 'ready', label);
    const [row] = state.result.markets;
    assert.deepEqual(posts(calls).map(([url]) => url), [
      '/api/read/v1/markets-snapshot', '/api/read/v1/token', '/api/read/v1/token', ...(refreshed ? ['/api/read/v2/pool-market'] : []),
    ], label);
    if (refreshed) {
      assert.deepEqual([row.provenance.origin, row.feeAprEstimate.data.feeAprEstimate24hPercent], ['pool-market', '10.95'], `${label}: the estimate comes with the pool’s own read`);
    } else {
      assert.equal(calls.some((c) => c.url.includes('/v2/')), false, `${label}: the estimate namespace is never asked`);
      assert.deepEqual([row.provenance.origin, row.feeAprEstimate.data, row.feeAprEstimate.reason], ['markets-snapshot', null, 'estimate_not_in_snapshot'], label);
    }
  }
});

test('chart binding rejects the other asset even when it belongs to the pool', () => {
  const data = old('pool-market.success');
  assert.equal(chartMatches(data, data.priceHistory.data.currency, 'base'), true);
  assert.equal(chartMatches(data, data.market.data.quoteToken, 'base'), false);
  const bad = structuredClone(data); bad.priceHistory.data.currency = data.market.data.quoteToken;
  const raw = { status: 200, opaqueRedirect: false, contentType: 'application/json', contractHeader: v1.CONTRACT_VERSION, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: JSON.stringify(bad) } };
  assert.equal(interpretReply('pool-market', { poolId: data.poolId, includePriceHistory: true }, raw, v1, { receivedAt: 0, attempts: 1, transport: 'bridge', contract: null }).reason, 'identity_mismatch');
});

test('candlestick coordinates preserve raw values, timestamps, orientation and gaps', () => {
  const history = old('pool-market.success').priceHistory.data;
  const sample = structuredClone(history); sample.candles = [history.candles[0], { ...history.candles[0], startTimestamp: history.candles[0].startTimestamp + 10800 }];
  const before = JSON.stringify(sample);
  const geometry = candleGeometry(sample);
  assert.equal(JSON.stringify(sample), before);
  assert.deepEqual(geometry.map((g) => g.candle), sample.candles);
  assert.ok(geometry[1].x - geometry[0].x > 200);
  assert.equal(geometry[0].candle.closeUsd, sample.candles[0].closeUsd);
});
