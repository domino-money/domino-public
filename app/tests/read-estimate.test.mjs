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
const { presentAprEstimate } = built('aprEstimate');
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
  for (const name of ['zero-tvl', 'missing-tvl', 'protocol-fee', 'dynamic', 'expired']) assert.equal(presentAprEstimate(observe(fixture(name).estimate), now(0)).text, null, name);
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
