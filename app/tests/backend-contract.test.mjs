/**
 * Issue #1, first acceptance criterion: the adapter's request and response
 * types agreed against backend/openapi-read.json and the Python response
 * fixtures, with the backend contract gaps recorded.
 *
 * Three descriptions of the same nine reads meet here:
 *
 *   backend/openapi-read.json         generated from the Python request and
 *                                     response models (pinned by digest)
 *   api-contracts/read-v1/schemas     what the adapter is typed and validated
 *                                     against, and what the bridge serves
 *   read-v1 fixtures/producer and     Python-produced responses and the
 *   fixtures/request-boundaries.json  Python request models' boundary corpus
 *
 * Every difference between the first two must be listed in
 * tests/backend-contract.ledger.mjs, and every listed difference must still
 * exist. The Python fixtures go through the adapter itself. Nothing here
 * edits or copies a producer file.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';
import * as publicRuntime from '../../api-contracts/read-v3/runtime.mjs';
import { validateRequest as bridgeValidateRequest } from '../../bridge/src/request-contract.mjs';
import { parseStrictJson } from '../../bridge/src/strict-json.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';
import * as ledger from './backend-contract.ledger.mjs';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/lib/read/${name}.js`);
const { BACKEND_OPENAPI_PIN } = built('pin');
const { interpretReply } = built('interpret');
const { createBridgeSource } = built('bridgeSource');
const { createFixtureSource } = built('fixtureSource');
const { ERROR_CLASS } = built('errors');
const { requestFor, gateway } = built('scenarios');

const ROOT = resolve(import.meta.dirname, '../..');
const READ = join(ROOT, 'api-contracts/read-v1');
const text = (path) => readFileSync(join(READ, path), 'utf8');
const INDEX = JSON.parse(text('fixtures/index.json'));
const catalog = { index: INDEX, text };
const OPENAPI_BYTES = readFileSync(join(ROOT, BACKEND_OPENAPI_PIN.path));
const OPENAPI = JSON.parse(OPENAPI_BYTES.toString('utf8'));
const RC3 = '1.1.0-rc.3';
const READ_PREFIX = '/v1/read/';

const readSchema = (name) => JSON.parse(text(`schemas/${name}.schema.json`));
const openapiRead = Object.fromEntries(
  Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith(READ_PREFIX))
    .map(([path, item]) => [path.slice(READ_PREFIX.length), item]),
);

// ---------------------------------------------------------------------------
// The document being reconciled is the one that was reviewed.
// ---------------------------------------------------------------------------

test('backend/openapi-read.json is the pinned document', () => {
  assert.equal(
    createHash('sha256').update(OPENAPI_BYTES).digest('hex'),
    BACKEND_OPENAPI_PIN.sha256,
    'openapi-read.json changed: rerun the reconciliation and update tests/backend-contract.ledger.mjs and the pin together',
  );
  assert.equal(OPENAPI.info.version, BACKEND_OPENAPI_PIN.infoVersion);
});

// ---------------------------------------------------------------------------
// Routes and methods
// ---------------------------------------------------------------------------

test('the OpenAPI read routes are exactly the nine read-v1 routes, each a POST with a JSON body', () => {
  assert.deepEqual(Object.keys(openapiRead).sort(), [...runtime.ENABLED_READS].sort());
  for (const [route, item] of Object.entries(openapiRead)) {
    assert.deepEqual(Object.keys(item), ['post'], `${route} is POST only`);
    assert.ok(item.post.requestBody.content['application/json'], `${route} takes JSON`);
    assert.deepEqual(item.post.parameters ?? [], [], `${route} takes nothing in the path or query`);
  }
  const others = Object.entries(OPENAPI.paths)
    .filter(([path]) => !path.startsWith(READ_PREFIX))
    .flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
  assert.deepEqual(others, [...ledger.OPENAPI_NON_READ_PATHS].sort());
});

test('the additive public data routes match the separately pinned V3 contract', () => {
  const paths = Object.entries(OPENAPI.paths).filter(([path]) => path.startsWith('/v3/read/'));
  assert.deepEqual(paths.map(([path]) => path.slice('/v3/read/'.length)).sort(), [...publicRuntime.ENABLED_READS].sort());
  for (const [path, item] of paths) {
    assert.deepEqual(Object.keys(item), ['post']);
    assert.deepEqual(item.post.parameters ?? [], []);
    const name = path.split('/').at(-1);
    const title = name[0].toUpperCase() + name.slice(1);
    assert.equal(item.post.requestBody.content['application/json'].schema.$ref, `#/components/schemas/${title}Request`);
    assert.equal(item.post.responses['200'].content['application/json'].schema.$ref, `#/components/schemas/${title}Response`);
  }
});

// ---------------------------------------------------------------------------
// Schemas, field by field
// ---------------------------------------------------------------------------

/** Resolves a $ref inside its own document: OpenAPI components, or a read-v1 schema's $defs. */
const openapiRef = (schema) => {
  for (let i = 0; schema?.$ref && i < 32; i++) schema = OPENAPI.components.schemas[schema.$ref.split('/').pop()];
  return schema;
};
const localRef = (doc) => (schema) => {
  for (let i = 0; schema?.$ref && i < 32; i++) {
    schema = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], doc);
  }
  return schema;
};

const COMPARED = [
  'type', 'enum', 'const', 'required', 'additionalProperties', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'format',
];
const canonical = (key, value) => {
  if ((key === 'required' || key === 'enum') && Array.isArray(value)) return JSON.stringify([...value].sort());
  if (key === 'additionalProperties' && typeof value === 'object') return 'schema';
  return JSON.stringify(value) ?? 'absent';
};
const emptyList = (key, value) => (key === 'required' || key === 'enum') && (value === undefined || (Array.isArray(value) && value.length === 0));

/** Every place two schemas disagree, as `route.kind.path.keyword`. */
function differences(a, b, openapiSide, readSide, path, out = []) {
  a = openapiSide(a);
  b = readSide(b);
  if (!a || !b) {
    if (Boolean(a) !== Boolean(b)) out.push(path);
    return out;
  }
  for (const key of COMPARED) {
    if (emptyList(key, a[key]) && emptyList(key, b[key])) continue;
    if (canonical(key, a[key]) !== canonical(key, b[key])) out.push(`${path}.${key}`);
  }
  const pa = a.properties ?? {};
  const pb = b.properties ?? {};
  for (const name of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (!(name in pa) || !(name in pb)) out.push(`${path}.${name}`);
    else differences(pa[name], pb[name], openapiSide, readSide, `${path}.${name}`, out);
  }
  for (const union of ['anyOf', 'oneOf', 'allOf']) {
    if (!a[union] && !b[union]) continue;
    if (a[union]?.length !== b[union]?.length) {
      out.push(`${path}.${union}`);
      continue;
    }
    a[union].forEach((branch, i) => differences(branch, b[union][i], openapiSide, readSide, `${path}.${union}[${i}]`, out));
  }
  if (a.items || b.items) differences(a.items, b.items, openapiSide, readSide, `${path}[]`, out);
  return out;
}

function allDifferences() {
  const found = [];
  for (const [route, item] of Object.entries(openapiRead)) {
    const request = readSchema(`${route}.request`);
    const response = readSchema(`${route}.response`);
    differences(item.post.requestBody.content['application/json'].schema, request, openapiRef, localRef(request), `${route}.request`, found);
    differences(item.post.responses['200'].content['application/json'].schema, response, openapiRef, localRef(response), `${route}.response`, found);
  }
  const capabilities = readSchema('capabilities.response');
  differences(
    OPENAPI.paths['/v1/capabilities'].get.responses['200'].content['application/json'].schema,
    capabilities, openapiRef, localRef(capabilities), 'capabilities.response', found,
  );
  const error = readSchema('error.response');
  differences({ $ref: '#/components/schemas/ErrorResponse' }, error, openapiRef, localRef(error), 'error.response', found);
  return found.sort();
}

test('the comparison is not blind: it sees a change in a nested field', () => {
  const request = readSchema('pools.request');
  const mutated = structuredClone(request);
  mutated.properties.maxPools.maximum = 21;
  const source = OPENAPI.paths['/v1/read/pools'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(differences(source, request, openapiRef, localRef(request), 'pools.request'), []);
  assert.deepEqual(differences(source, mutated, openapiRef, localRef(mutated), 'pools.request'), ['pools.request.maxPools.maximum']);
});

test('every request and response schema agrees with OpenAPI, except the recorded gaps', () => {
  const recorded = ledger.BACKEND_GAPS.flatMap((gap) => gap.schemaDiffs).sort();
  const found = allDifferences();
  assert.deepEqual(found.filter((d) => !recorded.includes(d)), [], 'a difference not recorded in tests/backend-contract.ledger.mjs');
  assert.deepEqual(recorded.filter((d) => !found.includes(d)), [], 'a recorded gap is gone: remove it from tests/backend-contract.ledger.mjs');
});

test('every recorded gap says what OpenAPI says, what read-v1 says, what the adapter does and what to ask', () => {
  const ids = ledger.BACKEND_GAPS.map((gap) => gap.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const gap of ledger.BACKEND_GAPS) {
    for (const field of ['openapi', 'readV1', 'adapter', 'question']) assert.ok(gap[field].length > 3, `${gap.id}.${field}`);
  }
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('the error codes are the same in OpenAPI, read-v1 and the adapter error table', () => {
  const openapiCodes = [...OPENAPI.components.schemas.ErrorResponse.properties.error.enum].sort();
  assert.deepEqual(openapiCodes, Object.keys(runtime.ERROR_STATUS_BY_CODE).sort());
  assert.deepEqual(Object.keys(ERROR_CLASS).sort(), openapiCodes);
});

test('every status read-v1 binds a code to is declared by OpenAPI, or recorded as bridge-only', () => {
  const declared = new Set();
  for (const [route, item] of Object.entries(openapiRead)) {
    for (const status of Object.keys(item.post.responses).filter((s) => s !== '200')) {
      assert.equal(item.post.responses[status].content['application/json'].schema.$ref, '#/components/schemas/ErrorResponse', `${route} ${status}`);
      declared.add(Number(status));
    }
  }
  const bridgeOnly = {};
  for (const [code, status] of Object.entries(runtime.ERROR_STATUS_BY_CODE)) {
    if (!declared.has(Number(status))) (bridgeOnly[status] ??= []).push(code);
  }
  assert.deepEqual(bridgeOnly, JSON.parse(JSON.stringify(ledger.BRIDGE_ONLY_ERROR_STATUSES)));
});

test('whether OpenAPI declares the contract header is as recorded', () => {
  assert.equal(OPENAPI_BYTES.toString('utf8').toLowerCase().includes('x-domino-read-contract'), ledger.OPENAPI_DECLARES_CONTRACT_HEADER);
});

// ---------------------------------------------------------------------------
// The Python request models' boundary corpus
// ---------------------------------------------------------------------------

const BOUNDARIES = JSON.parse(text('fixtures/request-boundaries.json'));

test('the Python boundary corpus covers all nine routes', () => {
  assert.deepEqual([...new Set(BOUNDARIES.map((c) => c.route))].sort(), [...runtime.ENABLED_READS].sort());
  assert.ok(BOUNDARIES.length > 200, `${BOUNDARIES.length} cases`);
});

test('the adapter request check accepts exactly what the Python models accept', () => {
  const disagreements = BOUNDARIES
    .filter((item) => runtime.validateRequest(item.route, JSON.parse(item.json)) !== item.parsedValid)
    .map((item) => `${item.route} ${item.name}`);
  assert.deepEqual(disagreements, []);
});

test('the one tokenIds difference is the recorded end assertion, and both sides accept the same ids', () => {
  const gap = ledger.BACKEND_GAPS.find((g) => g.id === 'nft-token-id-range');
  const request = readSchema('nft-positions.request');
  const readIds = localRef(request)(request.properties.tokenIds);
  const openapiRequest = openapiRef(OPENAPI.paths['/v1/read/nft-positions'].post.requestBody.content['application/json'].schema);
  const openapiIds = openapiRef(openapiRequest.properties.tokenIds);
  assert.equal(openapiIds.items.pattern, readIds.items.pattern + gap.endAssertion, 'OpenAPI pattern = read-v1 pattern + end assertion');
  assert.equal(openapiIds.items.maxLength, readIds.items.maxLength);
  assert.equal(openapiIds.uniqueItems, true);
  assert.equal(readIds.uniqueItems, true);
  const openapiPattern = new RegExp(openapiIds.items.pattern, 'u');
  const max = (2n ** 256n - 1n).toString();
  const cases = [['0', true], [max, true], [`${max}\n`, false], [(2n ** 256n).toString(), false], ['01', false], [`${max}0`, false]];
  for (const [id, valid] of cases) {
    assert.equal(openapiPattern.test(id), valid, `OpenAPI pattern on ${JSON.stringify(id)}`);
    assert.equal(runtime.validateRequest('nft-positions', { tokenIds: [id] }), valid, `read-v1 runtime on ${JSON.stringify(id)}`);
  }
  assert.equal(runtime.validateRequest('nft-positions', { tokenIds: ['1', '1'] }), false, 'a repeated id is refused');
});

test('a request the Python models refuse never leaves the adapter, from either source', async () => {
  for (const item of BOUNDARIES.filter((c) => !c.parsedValid)) {
    let fetched = 0;
    const bridge = createBridgeSource({
      enabled: true,
      validators: runtime,
      fetch: async () => {
        fetched += 1;
        throw new Error('must not fetch');
      },
    });
    const fixtures = createFixtureSource({ catalog, validators: runtime, script: {} });
    for (const source of [bridge, fixtures]) {
      const outcome = await source.read(item.route, JSON.parse(item.json));
      assert.equal(outcome.state, 'invalid', `${item.route} ${item.name}`);
      assert.equal(outcome.reason, 'request_contract', `${item.route} ${item.name}`);
    }
    assert.equal(fetched, 0, `${item.route} ${item.name} reached the network`);
  }
});

test('what the Python models accept, the adapter sends in a form the strict bridge parser accepts', async () => {
  const APP = 'https://app.test';
  const upstream = [];
  const worker = createWorker({
    getClientIp: () => '203.0.113.9',
    fetch: async (url, init) => {
      upstream.push({ route: new URL(url).pathname.replace('/internal/read/v1/', ''), body: init.body });
      return new Response('{"error":"upstream_unavailable"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3 },
      });
    },
  });
  const env = {
    APP_ORIGIN: APP,
    READ_BRIDGE_ENABLED: 'true',
    GATEWAY_ORIGIN: 'https://gateway.test',
    ENABLED_READS: runtime.ENABLED_READS.join(','),
    ACCESS_CLIENT_ID: 'test-client',
    ACCESS_CLIENT_SECRET: 'test-secret',
  };
  /** What the bridge itself answered, for the requests it refuses before the gateway. */
  let answered = null;
  const fetch = async (path, init) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', APP);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('Sec-Fetch-Mode', 'cors');
    const response = await worker.fetch(new Request(new URL(path, APP), { method: init.method, headers, body: init.body, redirect: 'manual' }), env);
    answered = { status: response.status, text: await response.clone().text() };
    return response;
  };
  const once = { maxAttempts: 1, jitterMs: 0, attemptMs: 20_000, totalMs: 60_000 };
  const refused = {};
  for (const item of BOUNDARIES.filter((c) => c.parsedValid)) {
    const parsed = JSON.parse(item.json);
    const before = upstream.length;
    const outcome = await createBridgeSource({ enabled: true, validators: runtime, fetch, policy: once }).read(item.route, parsed);
    if (upstream.length === before && answered?.status !== 503) {
      // Refused by the bridge itself: recorded, never retried, and nothing rendered as data.
      refused[`${item.route} ${item.name}`] = JSON.parse(answered.text).error;
      assert.notEqual(outcome.state, 'ok', `${item.route} ${item.name}`);
      continue;
    }
    assert.equal(upstream.length, before + 1, `${item.route} ${item.name} did not reach the gateway: ${outcome.state}/${outcome.reason ?? outcome.cause?.code ?? ''}`);
    const sent = upstream.at(-1);
    assert.equal(sent.route, item.route);
    // The body as the bridge itself parses it, number lexemes and all, before its own check.
    assert.equal(bridgeValidateRequest(item.route, parseStrictJson(sent.body, { numberLexemes: true })), true, `${item.route} ${item.name}`);
    assert.deepEqual(JSON.parse(sent.body), parsed, `${item.route} ${item.name} arrived changed`);
  }
  assert.deepEqual(refused, JSON.parse(JSON.stringify(ledger.BRIDGE_REFUSES_PYTHON_VALID)), 'Python-valid requests the bridge refuses, as recorded');
  // The Python models refuse some bodies only for how a number is written (1.0, 1e0).
  // JSON.stringify never writes those, so the adapter cannot send one.
  for (const item of BOUNDARIES.filter((c) => c.parsedValid && !c.valid)) {
    assert.notEqual(JSON.stringify(JSON.parse(item.json)), item.json, `${item.route} ${item.name}`);
  }
});

// ---------------------------------------------------------------------------
// Python-produced responses
// ---------------------------------------------------------------------------

const PRODUCER = INDEX.fixtures.filter((f) => f.kind === 'producer');
const nameOf = (entry) => entry.file.replace(/^fixtures\/producer\//, '').replace(/\.json$/, '');

test('every read route has Python-produced responses', () => {
  assert.deepEqual([...new Set(PRODUCER.map((f) => f.route))].sort(), [...runtime.ENABLED_READS].sort());
});

/** Paths at which two JSON values differ. */
function jsonPaths(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) jsonPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  } else out.push(path);
  return out;
}

test('each Python response is the browser-facing fixture of the same name, except as recorded', () => {
  const found = {};
  for (const entry of PRODUCER) {
    const name = nameOf(entry);
    const twin = `fixtures/gateway/${name}.json`;
    assert.ok(INDEX.fixtures.some((f) => f.file === twin), `${name} has a gateway twin`);
    const diff = jsonPaths(JSON.parse(text(entry.file)), JSON.parse(text(twin)));
    if (diff.length) found[name] = diff;
  }
  assert.deepEqual(found, JSON.parse(JSON.stringify(ledger.PRODUCER_GATEWAY_DIFFERENCES)));
});

test('every Python response passes read-v1 and the adapter pipeline, as the bridge would carry it', () => {
  for (const entry of PRODUCER) {
    const name = nameOf(entry);
    const body = text(entry.file);
    assert.doesNotThrow(() => runtime.assertResponse(entry.route, JSON.parse(body)), name);
    const reply = {
      status: 200,
      opaqueRedirect: false,
      contentType: 'application/json',
      contractHeader: RC3,
      requestIdHeader: null,
      retryAfterHeader: null,
      body: { kind: 'text', text: body },
    };
    const request = requestFor(catalog, entry.route, gateway(name));
    const outcome = interpretReply(entry.route, request, reply, runtime, { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 });
    assert.equal(outcome.state, 'ok', `${name}: ${outcome.state}/${outcome.reason ?? ''}`);
  }
});
