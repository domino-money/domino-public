import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createProgressiveReader } from './progressive.mjs';
import { CONTRACT_VERSION } from './runtime.mjs';
const token = JSON.parse(readFileSync(new URL('./fixtures/gateway/token.success.json', import.meta.url)));
const wallet = JSON.parse(readFileSync(new URL('./fixtures/gateway/wallet-assets.fallback.json', import.meta.url)));
const body = { token: token.asset.address };
const response = (data = token, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION, ...headers },
});
function setup(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const reader = createProgressiveReader({ intervalMs: 1000, random: () => 0, ...options });
  t.after(() => reader.dispose());
  return { reader, advance: async ms => { t.mock.timers.tick(ms); await setImmediate(); } };
}

test('identical in-flight queries deduplicate and obsolete subscribers cancel independently', async t => {
  let calls = 0, release, upstreamSignal;
  const { reader, advance } = setup(t, { fetch: async (_, init) => {
    calls++; upstreamSignal = init.signal; await new Promise(resolve => { release = resolve; }); return response();
  } });
  const selected = new AbortController();
  const cancelled = reader.read('token', body, { signal: selected.signal });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  const kept = reader.read('token', body);
  await advance(0); selected.abort();
  assert.equal(upstreamSignal.aborted, false); release(); await kept; await rejection;
  assert.equal(calls, 1);
});

test('serial scheduling and bounded pending admission include the active request', async t => {
  const starts = [];
  const { reader, advance } = setup(t, { maxPending: 2, fetch: async () => { starts.push(Date.now()); return response(); } });
  const first = reader.read('token', body), second = reader.read('token', { token: '0x'+'22'.repeat(20) });
  await assert.rejects(reader.read('token', { token: '0x'+'33'.repeat(20) }), /screen_read_capacity/);
  await advance(0); await first; assert.equal(starts.length, 1);
  await advance(999); assert.equal(starts.length, 1);
  await advance(1); await second; assert.deepEqual(starts, [1000, 2000]);
});

test('429 obeys Retry-After and preserves timestamped public data through backoff/failure', async t => {
  let calls = 0;
  const states = [];
  const { reader, advance } = setup(t, { maxRetries: 1, fetch: async () => ++calls === 1 ? response()
    : response({ error: 'read_capacity_busy' }, 429, { 'Retry-After': '3' }) });
  const first = reader.read('token', body); await advance(0); await first;
  const next = reader.read('token', body, { onState: state => states.push(state) });
  const rejected = assert.rejects(next, error => error.code === 'read_capacity_busy' && error.status === 429);
  await advance(1000); assert.equal(calls, 2);
  assert.equal(states.at(-1).status, 'backoff'); assert.equal(states.at(-1).retained.receivedAt, 1000);
  await advance(2999); assert.equal(calls, 2);
  await advance(1); await rejected; assert.equal(calls, 3);
  assert.deepEqual(states.at(-1).retained.data, token);
});

test('last-subscriber cancellation removes queued work and aborts active fetch', async t => {
  const calls = [];
  const { reader, advance } = setup(t, { fetch: async (_, init) => { calls.push(init); return new Promise(() => {}); } });
  const a = new AbortController(), b = new AbortController();
  const one = reader.read('token', body, { signal: a.signal });
  const two = reader.read('token', { token: '0x'+'22'.repeat(20) }, { signal: b.signal });
  const rejects = [assert.rejects(one, { name: 'AbortError' }), assert.rejects(two, { name: 'AbortError' })];
  await advance(0); b.abort(); a.abort(); await Promise.all(rejects); await advance(5000);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, true);
});

test('absolute deadline bounds transports ignoring abort and clears the admission slot', async t => {
  const { reader, advance } = setup(t, { budgetMs: 1000, maxPending: 1, fetch: () => new Promise(() => {}) });
  const pending = reader.read('token', body);
  const rejected = assert.rejects(pending, /read_deadline_exceeded/);
  await advance(0); await advance(1000); await rejected;
  const next = reader.read('token', body); const nextRejected = assert.rejects(next, { name: 'AbortError' });
  reader.dispose(); await nextRejected;
});

test('wallet/NFT responses are not retained and non-429 errors never retry', async t => {
  let calls = 0; const states = [];
  const { reader, advance } = setup(t, { fetch: async () => ++calls === 1 ? response(wallet)
    : response({ error: 'upstream_unavailable' }, 503) });
  const input = { wallet: '0x'+'33'.repeat(20) };
  const first = reader.read('wallet-assets', input); await advance(0); await first;
  const next = reader.read('wallet-assets', input, { onState: state => states.push(state) });
  const rejected = assert.rejects(next, /upstream_unavailable/); await advance(1000); await rejected;
  assert.equal(calls, 2); assert.ok(states.every(state => state.retained === null));
});

test('old contract versions and invalid request fields fail closed', async t => {
  const { reader, advance } = setup(t, { fetch: async () => response(token, 200, { 'X-Domino-Read-Contract': '1.0.0' }) });
  await assert.rejects(reader.read('token', { ...body, rpcUrl: 'https://invalid.invalid' }), /invalid_request/);
  const pending = reader.read('token', body); const rejected = assert.rejects(pending, /upstream_contract_mismatch/);
  await advance(0); await rejected;
});


test('malformed gateway JSON never echoes its parser diagnostic to a screen', async t => {
  const { reader, advance } = setup(t, { fetch: async () => new Response('private-provider-diagnostic', {
    headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION },
  }) });
  const pending = reader.read('token', body);
  const rejected = assert.rejects(pending, error => error.code === 'upstream_invalid_response' && !error.message.includes('private'));
  await advance(0); await rejected;
});

test('replacing an aborted identical query preserves the new pending entry', async t => {
  let calls = 0, release;
  const { reader, advance } = setup(t, { fetch: async () => {
    calls++; if (calls === 1) return new Promise(() => {});
    await new Promise(resolve => { release = resolve; }); return response();
  } });
  const signal = new AbortController();
  const first = reader.read('token', body, { signal: signal.signal });
  const aborted = assert.rejects(first, { name: 'AbortError' });
  await advance(0); signal.abort();
  const next = reader.read('token', body);
  await aborted; await advance(1000);
  const same = reader.read('token', body);
  release(); await Promise.all([next, same]); assert.equal(calls, 2);
});
