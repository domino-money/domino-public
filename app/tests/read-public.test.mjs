import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as v1 from '../../api-contracts/read-v1/runtime.mjs';
import * as v2 from '../../api-contracts/read-v2/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';

const require = createRequire(import.meta.url);
const built = name => require(`../.test-build/app/src/lib/read/${name}.js`);
const { createBridgeSource } = built('bridgeSource');
const { createEstimateSource } = built('estimateSource');
const { createPublicSource } = built('publicSource');
const { createPublicMetadataCache } = built('publicMetadataCache');
const { createScheduledSource } = built('scheduler');
const { loadSelectedPools, createReadMarketsProvider } = built('marketsProvider');
const { overviewRows, overviewPoolOption } = built('publicOverview');
const { GATE_REFUSAL } = built('interpret');
const fixture = route => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v3/fixtures/${route}.json`, import.meta.url), 'utf8'));
const initial = fixture('overview');
const pool = initial.pools[0].poolId;
const token = initial.tokens[0].address;

function setup({ answer = () => fixture('overview'), enabled = true, clock } = {}) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    let response;
    if (path === '/api/read/v3/capabilities') {
      response = fixture('capabilities');
      if (!enabled) { response.dataMode = 'disabled'; response.enabledReads = []; }
    } else if (path === '/api/read/v3/overview') response = answer();
    else throw new Error(`unexpected read: ${path}`);
    return response instanceof Response ? response : new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  };
  const options = { enabled: true, validators: v1, fetch, clock };
  const publicSource = createPublicSource(createEstimateSource(options, v2), options, v3);
  const source = createPublicMetadataCache(createScheduledSource(publicSource, { minIntervalMs: 0, budget: null, clock }), clock);
  return { source, calls };
}

test('stored table gets metadata and APR in one overview POST, retains original observation age and makes no provider fanout', async () => {
  const data = fixture('overview'); data.generatedAt += 40;
  const { source, calls } = setup({ answer: () => data });
  const loaded = await loadSelectedPools(source, [pool], undefined, undefined, { overview: true });
  assert.equal(loaded.rows.length, 1);
  assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities', '/api/read/v3/overview']);
  assert.equal(loaded.rows[0].feeAprEstimate.data.feeAprEstimate24hPercent, data.pools[0].value.estimate.feeAprEstimate24hPercent);
  assert.equal(Object.values(loaded.rows[0].tokens).find(asset => asset.address === token).decimals, 6);
  const read = await source.read('overview', { poolIds: [pool] });
  assert.equal(calls.length, 2, 'the following page reuses its just-read bundle briefly');
  const row = overviewRows(read)[0];
  assert.ok(Math.abs(row.provenance.market.receivedAt - (read.provenance.receivedAt - 40_000)) < 1);
  const option = overviewPoolOption(read, pool);
  assert.equal(option.kind, 'stored'); assert.equal(option.block, data.pools[0].value.market.snapshot.number);
  assert.equal(option.catalogue, null, 'a stored observation is not fabricated catalogue provenance');
  const metadata = await source.read('token', { token });
  assert.equal(metadata.state, 'ok'); assert.equal(calls.length, 2, 'metadata is reusable outside the table');
  assert.equal(metadata.provenance.receivedAt, read.provenance.receivedAt - 40_000);
});

test('a bad overview identity, a gate refusal, or invalid nested APR never triggers fallback reads', async () => {
  for (const answer of [
    () => ({ ...fixture('overview'), requestedPoolIds: [] }),
    () => new Response(GATE_REFUSAL, { status: 401, headers: { 'Content-Type': 'application/json' } }),
    () => { const data = fixture('overview'); data.pools[0].value.estimate.feeAprEstimate24hPercent = '999'; return data; },
  ]) {
    const { source, calls } = setup({ answer });
    const loaded = await loadSelectedPools(source, [pool], undefined, undefined, { overview: true });
    assert.equal(loaded.rows.length, 0);
    assert.ok(loaded.blocking || loaded.problems.length);
    assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities', '/api/read/v3/overview']);
  }
});

test('disabled V3 capability permits the older read path without a V3 POST', async () => {
  const { source, calls } = setup({ enabled: false });
  assert.equal((await source.routeEnabled('overview')).state, 'not_enabled');
  assert.equal((await source.routeEnabled('overview')).state, 'not_enabled');
  assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities']);
});

test('V3 and legacy reads share one queue, exact-request coalescing and request cancellation', async () => {
  let release;
  const arrived = new Promise(done => { release = done; });
  const calls = [];
  const base = setup();
  const combined = {
    transport: 'bridge',
    routeEnabled: base.source.routeEnabled,
    async read(route, request, options) {
      calls.push(route);
      if (route === 'overview') { await arrived; return base.source.read(route, request, options); }
      return { route, state: 'aborted', provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 0 } };
    },
  };
  const source = createScheduledSource(combined, { minIntervalMs: 0, budget: null });
  const first = source.read('overview', { poolIds: [pool] });
  const second = source.read('overview', { poolIds: [pool] });
  const old = source.read('token', { token });
  assert.deepEqual(calls, ['overview']);
  release();
  const outcomes = await Promise.all([first, second, old]);
  assert.equal(outcomes[0].state, 'ok'); assert.equal(outcomes[1].state, 'ok');
  assert.deepEqual(calls, ['overview', 'token']);
});

test('pending acquisition is explicit and does not require keeping a component open to finish backend work', async () => {
  const pending = fixture('overview');
  for (const entry of [...pending.pools, ...pending.tokens]) {
    entry.value = null; entry.observedAt = null;
    entry.acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: null };
  }
  const { source, calls } = setup({ answer: () => pending });
  const provider = createReadMarketsProvider({ source, poolIds: [pool], kind: 'bridge' });
  const state = await new Promise(resolve => {
    const stop = provider.subscribe(() => { const state = provider.getSnapshot(); if (state.phase !== 'loading') { stop(); resolve(state); } });
    provider.ensure();
  });
  assert.equal(state.phase, 'ready'); assert.equal(state.acquiring, true);
  assert.equal(state.result.markets.length, 0, 'no synthetic zero or fake metadata');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('legacy source still rejects V3 routes through its original contract', async () => {
  const source = createBridgeSource({ enabled: true, validators: v1, fetch: () => { throw new Error('no request should escape'); } });
  assert.equal((await source.read('overview', { poolIds: [pool] })).state, 'invalid');
});
