import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createSessionWorker } from '../src/session-worker.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from '../../api-contracts/session-v1/runtime.mjs';

const base = new URL('../../api-contracts/session-v1/', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, base), 'utf8'));
const manifest = await read('manifest.json');
const origin = 'https://app.example.invalid';
const env = { APP_ORIGIN: origin, SESSION_GATEWAY_ORIGIN: 'https://auth.example.invalid', SESSION_BRIDGE_ENABLED: 'true',
  SESSION_ACCESS_CLIENT_ID: 'synthetic-auth-id', SESSION_ACCESS_CLIENT_SECRET: 'synthetic-auth-secret' };

test('session manifest hashes bind the exact closed schemas/types/fixtures/validator', async () => {
  assert.equal(manifest.contractVersion, CONTRACT_VERSION);
  assert.equal(manifest.status, 'candidate_disabled_pending_consumer_acknowledgement');
  for (const file of manifest.files) {
    const content = await readFile(new URL(file.path, base));
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
  }
});

for (const route of ROUTES) test(`Python model fixtures pass the actual session Worker for ${route}`, async () => {
  const input = await read(`fixtures/requests/${route}.json`);
  const output = await read(`fixtures/responses/${route}.json`);
  assert.equal(validateRequest(route, input), true);
  assert.equal(validateResponse(route, output), true);
  const credentials = route === 'bootstrap' ? { preauth: 'x'.repeat(43) } :
    route === 'verify' ? { preauth: null, session: 'y'.repeat(43) } :
    route === 'logout' ? { preauth: null, session: null } : {};
  const worker = createSessionWorker({ getClientIp: () => '203.0.113.8', fetch: async () => new Response(JSON.stringify({ result: output, credentials }), {
    headers: { 'Content-Type': 'application/json', 'X-Domino-Session-Contract': CONTRACT_VERSION },
  }) });
  const method = route === 'me' ? 'GET' : 'POST';
  const response = await worker.fetch(new Request(`${origin}/api/session/v1/${route}`, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Domino-CSRF': 'z'.repeat(43) },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), output);
});

test('Python finite error fixtures match JS status handling exactly', async () => {
  const fixtures = await read('fixtures/errors.json');
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(ERROR_STATUS_BY_CODE).sort());
  for (const { body, status } of Object.values(fixtures)) {
    assert.equal(validateError(status, body), true);
    assert.equal(validateError(status + 1, body), false);
    assert.equal(validateError(status, { ...body, detail: 'sensitive' }), false);
  }
});

for (const route of ROUTES) test(`${route} rejects deleted/extra/wrong-type fields in nested producer output`, async () => {
  const body = await read(`fixtures/responses/${route}.json`);
  function mutations(value) {
    const cases = [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      cases.push({ ...value, unknownField: 'must-not-pass' });
      for (const [key, child] of Object.entries(value)) {
        const missing = { ...value }; delete missing[key]; cases.push(missing);
        cases.push({ ...value, [key]: null }, { ...value, [key]: [] }, { ...value, [key]: typeof child === 'string' ? 123 : 'coercion' });
        if (typeof child === 'boolean') cases.push({ ...value, [key]: Number(child) });
        for (const changed of mutations(child)) cases.push({ ...value, [key]: changed });
      }
    }
    return cases;
  }
  for (const changed of mutations(body)) assert.equal(validateResponse(route, changed), false);
});
