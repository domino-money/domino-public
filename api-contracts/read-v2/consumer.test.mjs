import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {CONTRACT_VERSION, ENABLED_READS, assertRequest, assertResponse,
  validateRequest, validateResponse, validateError} from './runtime.mjs';

const read = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const corpus = read('fixtures/index.json');

for (const entry of corpus.fixtures) test(`portable response: ${entry.file}`, () => {
  const payload = read(entry.file), before = JSON.stringify(payload);
  assert.equal(validateResponse(entry.route, payload), entry.valid);
  if (entry.valid) assert.equal(assertResponse(entry.route, payload), payload);
  else assert.throws(() => assertResponse(entry.route, payload), /^TypeError: upstream_contract_mismatch$/u);
  assert.equal(JSON.stringify(payload), before);
});

for (const entry of read('fixtures/request-boundaries.json')) test(`portable request: ${entry.name}`, () => {
  const before = JSON.stringify(entry.payload);
  assert.equal(validateRequest(entry.route, entry.payload), entry.valid);
  if (entry.valid) assert.equal(assertRequest(entry.route, entry.payload), entry.payload);
  else assert.throws(() => assertRequest(entry.route, entry.payload), /^TypeError: invalid_request$/u);
  assert.equal(JSON.stringify(entry.payload), before);
});

test('finite errors retain the correct status without extra values', () => {
  for (const {status, payload} of read('fixtures/errors.json')) {
    assert.equal(validateError(status, payload), true);
    assert.equal(validateError(200, payload), false);
    assert.equal(validateError(status, {...payload, detail: 'untrusted'}), false);
  }
  assert.equal(validateError(503, {error: 'private-provider-body'}), false);
});

test('the version exposes only pool-market and keeps read-v1 feeApr24h null', () => {
  assert.equal(CONTRACT_VERSION, '2.0.0-rc.1');
  assert.deepEqual(ENABLED_READS, ['pool-market']);
  const result = read('fixtures/responses/pool-market.json');
  assert.equal(result.estimate.feeAprEstimate24hPercent, '10.95');
  assert.equal(result.market.feeApr24h, null);
  assert.equal(result.estimate.providerMetricsReconciled, false);
  assert.equal(validateResponse('pool-metrics', result), false);
  assert.equal(validateResponse('__proto__', result), false);
});

test('capabilities cannot advertise routes or mode combinations outside v2', () => {
  const disabled = read('fixtures/capabilities.disabled.json');
  assert.equal(validateResponse('capabilities', {...disabled, enabledReads: ['pool-market']}), false);
  assert.equal(validateResponse('capabilities', {...disabled, dataMode: 'live_read_only'}), false);
  assert.equal(validateResponse('capabilities', {...disabled, contractVersion: '1.1.0-rc.3'}), false);
  assert.equal(validateResponse('capabilities', {...disabled, enabledReads: ['token']}), false);
  assert.equal(validateResponse('capabilities', {...disabled, automation: 0}), false);
});

test('validation is independent of JSON object key order and does not perform I/O', () => {
  function reversed(value) {
    if (Array.isArray(value)) return value.map(reversed);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]));
  }
  const payload = reversed(read('fixtures/responses/pool-market.json'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('validator attempted I/O'); };
  try { assert.equal(validateResponse('pool-market', payload), true); }
  finally { globalThis.fetch = oldFetch; }
});
