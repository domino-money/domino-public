import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CONTRACT_VERSION, ENABLED_READS, RESPONSE_SCHEMA_VERSIONS, ERROR_STATUS_BY_CODE,
  validateResponse, validateError, validateRequest as sharedValidateRequest,
} from '../../api-contracts/read-v1/runtime.mjs';
import { createWorker } from '../src/worker.mjs';
import { ROUTES, validateRequest } from '../src/request-contract.mjs';
import { parseStrictJson } from '../src/strict-json.mjs';

const contractRoot = new URL('../../api-contracts/read-v1/', import.meta.url);
const read = (file) => readFile(new URL(file, contractRoot), 'utf8');
const index = JSON.parse(await read('fixtures/index.json'));
const opaquePage = JSON.parse(await read('fixtures/gateway/wallet-assets.opaque-page.json'));
const origin = 'https://app.example.invalid';
const address = `0x${'1'.repeat(40)}`;
const poolId = `0x${'2'.repeat(64)}`;
const bodies = {
  catalogue: { token: address }, 'pool-activity': { poolId }, 'pool-positions': { poolId }, 'pool-metrics': { poolId },
  token: { token: address }, pools: { token: address }, 'pool-market': { poolId },
  'wallet-assets': { wallet: address }, 'nft-positions': { tokenIds: ['1'] },
};
const env = {
  READ_BRIDGE_ENABLED: 'true', APP_ORIGIN: origin, GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  ENABLED_READS: ENABLED_READS.join(','), ACCESS_CLIENT_ID: 'synthetic-id', ACCESS_CLIENT_SECRET: 'synthetic-secret',
};

test('Worker route/version contract and exact request validator match the shared candidate', () => {
  assert.equal(index.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(Object.keys(ROUTES), ENABLED_READS);
  for (const route of ENABLED_READS) {
    assert.equal(ROUTES[route].schemaVersion, RESPONSE_SCHEMA_VERSIONS[route]);
    for (const payload of [bodies[route], { ...bodies[route], rpcMethod: 'eth_sendTransaction' }, {}, [], null]) {
      assert.equal(validateRequest(route, parseStrictJson(JSON.stringify(payload), { numberLexemes: true })), sharedValidateRequest(route, payload));
    }
  }
});

test('request field allowlists match each generated closed request schema', async () => {
  for (const route of ENABLED_READS) {
    const schema = JSON.parse(await read(`schemas/${route}.request.schema.json`));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...ROUTES[route].fields].sort(), Object.keys(schema.properties).sort());
    assert.deepEqual([...ROUTES[route].required].sort(), [...schema.required].sort());
  }
});

for (const fixture of index.fixtures) test(`shared fixture consumer: ${fixture.file}`, async () => {
  const payload = JSON.parse(await read(fixture.file));
  if (fixture.status === 200) assert.equal(validateResponse(fixture.route, payload), fixture.valid);
  else assert.equal(validateError(fixture.status, payload), fixture.valid);

  let wireText = JSON.stringify(payload);
  // Producer cursors are never valid gateway output. Simulate only the declared
  // gateway substitution using its distinct fixture before this BFF consumes it.
  if (fixture.kind === 'producer' && fixture.route === 'wallet-assets' && payload.inventory.nextCursor !== null) {
    payload.inventory.nextCursor = opaquePage.inventory.nextCursor;
    wireText = JSON.stringify(payload);
  }
  let calls = 0;
  const worker = createWorker({ getClientIp: () => '203.0.113.7', fetch: async () => {
    calls++;
    return new Response(wireText, {
      status: fixture.status,
      headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION },
    });
  } });
  if (fixture.route === 'capabilities') {
    const response = await worker.fetch(new Request(`${origin}/api/read/v1/capabilities`), {
      ...env, READ_BRIDGE_ENABLED: payload.dataMode === 'disabled' ? 'false' : 'true', ENABLED_READS: payload.enabledReads.join(','),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.equal(calls, 0);
    return;
  }
  const response = await worker.fetch(new Request(`${origin}/api/read/v1/${fixture.route}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(bodies[fixture.route]),
  }), env);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  if (fixture.valid) {
    assert.equal(response.status, fixture.status);
    assert.deepEqual(await response.json(), payload);
  } else {
    assert.equal(response.status, ERROR_STATUS_BY_CODE.upstream_contract_mismatch);
    assert.deepEqual(await response.json(), { error: 'upstream_contract_mismatch' });
  }
});
