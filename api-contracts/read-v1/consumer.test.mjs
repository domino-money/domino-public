import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateRequest as validateWireRequest } from '../../bridge/src/request-contract.mjs';
import { parseStrictJson } from '../../bridge/src/strict-json.mjs';
import { CONTRACT_VERSION, ENABLED_READS, ERROR_STATUS_BY_CODE, RESPONSE_SCHEMA_VERSIONS,
  assertResponse, validateResponse, validateRequest, validateError } from './runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const corpus = read('fixtures/index.json');
const fixture = (route, name = 'success') => read(`fixtures/producer/${route}.${name}.json`);
const token = '0x' + '11'.repeat(20);
const other = '0x' + '22'.repeat(20);
const pool = '0x' + 'ab'.repeat(32);

for (const item of corpus.fixtures) {
  test(`shared consumer: ${item.file}`, () => {
    const payload = read(item.file);
    if (item.status === 200) {
      const before = JSON.stringify(payload);
      assert.equal(validateResponse(item.route, payload), item.valid);
      if (item.valid) assert.equal(assertResponse(item.route, payload), payload);
      else assert.throws(() => assertResponse(item.route, payload), /^TypeError: upstream_contract_mismatch$/);
      assert.equal(JSON.stringify(payload), before);
    } else {
      assert.equal(validateError(item.status, payload), true);
      assert.equal(ERROR_STATUS_BY_CODE[payload.error], item.status);
    }
  });
}

for (const item of corpus.requests) {
  test(`shared request: ${item.file}`, () => assert.equal(validateRequest(item.route, read(item.file)), true));
}

test('ten response schemas retain independent version numbers and exact amounts', () => {
  assert.equal(corpus.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(ENABLED_READS,
    ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics', 'markets-snapshot']);
  assert.deepEqual(RESPONSE_SCHEMA_VERSIONS,
    { token: 1, pools: 2, 'pool-market': 1, 'wallet-assets': 2, 'nft-positions': 1, catalogue: 1, 'pool-activity': 1, 'pool-positions': 1, 'pool-metrics': 1, 'markets-snapshot': 1 });
  const wallet = fixture('wallet-assets', 'fallback');
  const text = wallet.items[1].amountRaw;
  assert.equal(typeof text, 'string');
  assert.equal(BigInt(text), 2n ** 255n + 123n);
  assert.notEqual(BigInt(Number(text)), BigInt(text));
  assert.equal(wallet.items[0].amountRaw, '0');
  assert.equal(fixture('token', 'missing-decimals').asset.decimals, null);
  assert.equal(fixture('token', 'zero-decimals').asset.decimals, 0);
});

test('required nested names, exact types, enums and nullability fail closed', () => {
  const mutations = [
    ['token', 'success', ['asset', 'decimals'], '6'],
    ['token', 'success', ['liveExecution'], 0],
    ['token', 'success', ['schemaVersion'], true],
    ['token', 'success', ['asset', 'metadataIssues'], { renamedDecimals: 'rpc_error' }],
    ['pools', 'catalogue', ['pools', 0, 'catalogueObservation'], undefined],
    ['pools', 'success', ['discovery', 'status'], 'new_state'],
    ['pool-market', 'success', ['market', 'data', 'reportedLiquidityUsd'], undefined],
    ['pool-market', 'success', ['priceHistory', 'data', 'coverage', 'closedCandles'], undefined],
    ['pool-market', 'success', ['market', 'cache', 'ageSeconds'], '0'],
    ['pool-market', 'success', ['priceHistory', 'data', 'candles', 0, 'openUsd'], 1],
    ['pool-market', 'success', ['priceHistory', 'data', 'candles', 0, 'openUsd'], 'NaN'],
    ['pool-market', 'success', ['market', 'data'], null],
    ['wallet-assets', 'page', ['inventory', 'hasMore'], undefined],
    ['wallet-assets', 'fallback', ['items', 1, 'amountRaw'], 9007199254740992],
    ['wallet-assets', 'fallback', ['items', 1, 'amountRaw'], (2n ** 256n).toString()],
    ['wallet-assets', 'fallback', ['items', 1, 'amountRaw'], '01'],
    ['wallet-assets', 'fallback', ['items', 1, 'amountRaw'], '1\n'],
    ['nft-positions', 'success', ['items', 0, 'unsettledFeesRaw'], undefined],
    ['nft-positions', 'success', ['items', 0, 'unsettledFeesRaw'], ['0']],
  ];
  for (const [route, name, segments, value] of mutations) {
    const payload = fixture(route, name);
    let node = payload;
    for (const segment of segments.slice(0, -1)) node = node[segment];
    if (value === undefined) delete node[segments.at(-1)];
    else node[segments.at(-1)] = value;
    assert.equal(validateResponse(route, payload), false, `${route}.${segments.join('.')}`);
  }
});

test('opaque gateway pagination changes only the cursor value', () => {
  const producer = fixture('wallet-assets', 'page');
  const gateway = read('fixtures/gateway/wallet-assets.opaque-page.json');
  assert.equal(typeof gateway.inventory.nextCursor, typeof producer.inventory.nextCursor);
  assert.match(gateway.inventory.nextCursor, /^[0-9a-f]{64}$/);
  assert.notEqual(gateway.inventory.nextCursor, producer.inventory.nextCursor);
  gateway.inventory.nextCursor = producer.inventory.nextCursor;
  assert.deepEqual(gateway, producer);
});

test('metadata remains untrusted text without schema-driven HTML transformations', () => {
  const payload = fixture('token', 'untrusted-symbol');
  assert.equal(validateResponse('token', payload), true);
  assert.equal(payload.asset.symbol, '<img src=x onerror=alert(1)>');
  // A consumer renders symbol through a text node / normal React interpolation.
  // The shared validator neither strips nor marks this string as trusted HTML.
});

test('strict requests preserve defaults and enforce pair, budget and uint256 constraints', () => {
  const examples = [
    ['token', { token }], ['pools', { token, pairedToken: other, maxPools: 1, poolIds: [pool] }],
    ['pool-market', { poolId: pool, includePriceHistory: true, priceToken: 'quote' }],
    ['wallet-assets', { wallet: token }],
    ['nft-positions', { tokenIds: [(2n ** 256n - 1n).toString()], blockNumber: 700 }],
  ];
  for (const [route, value] of examples) {
    const before = JSON.stringify(value);
    assert.equal(validateRequest(route, value), true, route);
    assert.equal(JSON.stringify(value), before);
  }
  for (const [route, value] of [
    ['token', { token, rpcUrl: 'https://untrusted.invalid' }],
    ['token', { token: token + '\n' }],
    ['pools', { token, pairedToken: token }],
    ['pools', { token, maxPools: true }],
    ['pools', { token, maxPools: 1, poolIds: [pool, pool] }],
    ['wallet-assets', { wallet: token, autoDiscover: 'true' }],
    ['wallet-assets', { wallet: token, owner: token }],
    ['pool-market', { poolId: pool, priceToken: 'unreviewed' }],
    ['nft-positions', { tokenIds: [(2n ** 256n).toString()] }],
    ['nft-positions', { tokenIds: ['01'] }],
    ['nft-positions', { tokenIds: ['1', '1'] }],
    ['nft-positions', { tokenIds: [1] }],
    ['nft-positions', { tokenIds: ['1'], blockNumber: true }],
  ]) assert.equal(validateRequest(route, value), false, `${route}: ${JSON.stringify(value)}`);
});

test('error shape, finite code and status are jointly validated without leaking details', () => {
  assert.equal(validateError(422, { error: 'invalid_request' }), true);
  assert.equal(validateError(503, { error: 'invalid_request' }), false);
  assert.equal(validateError(503, { error: 'upstream_unavailable', detail: 'private provider URL' }), false);
  assert.equal(validateError(503, { error: 'unreviewed_provider_error' }), false);
});

test('unknown route and capability versions never enable live behavior', () => {
  const capabilities = read('fixtures/gateway/capabilities.disabled.json');
  capabilities.contractVersion = '2.0.0';
  assert.equal(validateResponse('capabilities', capabilities), false);
  capabilities.contractVersion = CONTRACT_VERSION; capabilities.enabledReads = ['token'];
  assert.equal(validateResponse('capabilities', capabilities), false);
  capabilities.dataMode = 'live_read_only'; capabilities.enabledReads = ['token', 'token'];
  assert.equal(validateResponse('capabilities', capabilities), false);
  assert.equal(validateResponse('pool-metrics', {}), false);
  assert.equal(validateRequest('pool-metrics', { poolId: pool }), true);
  for (const route of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', null,
    ['token'], { toString: () => 'token' }]) {
    assert.equal(validateResponse(route, {}), false);
    assert.equal(validateRequest(route, { token }), false);
    assert.throws(() => assertResponse(route, {}), /^TypeError: upstream_contract_mismatch$/);
  }
});


test('next candidate tags, closed reasons and unavailable historical context reject silent repair', () => {
  const pools = fixture('pools', 'success');
  assert.equal(pools.pools[0].poolKind, 'discovery');
  pools.pools[0].poolKey.feeMode = 'dynamic';
  assert.equal(validateResponse('pools', pools), false);
  const asset = fixture('token', 'missing-decimals');
  asset.asset.metadataIssues.decimals = 'new_unreviewed_reason';
  assert.equal(validateResponse('token', asset), false);
  const incomplete = fixture('pool-metrics', 'capital-unavailable');
  assert.equal(incomplete.capital.current, null);
  incomplete.prices[0].observations = 0;
  assert.equal(validateResponse('pool-metrics', incomplete), false);
  const price = fixture('pool-metrics', 'price-capacity');
  assert.equal(price.capital.status, 'reconciled_event_history');
  assert.equal(price.valuation.tvlUsd, null);
  price.valuation.tvlUsd = '0';
  assert.equal(validateResponse('pool-metrics', price), false);
  for (const blockNumber of [-1, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.equal(validateRequest('nft-positions', { tokenIds: ['1'], blockNumber }), false);
  }
  assert.equal(validateRequest('nft-positions', { tokenIds: ['1'], blockNumber: Number.MAX_SAFE_INTEGER }), true);
  assert.equal(validateRequest('catalogue', { token, afterPoolId: pool }), false);
  assert.equal(validateRequest('catalogue', { token, afterPoolId: pool, revision: 0 }), true);
});


test('all nine response families reject integers above the safe boundary without narrowing amount strings', () => {
  const cases = [
    ['token', 'success', ['snapshot', 'number']],
    ['pools', 'success', ['discovery', 'returned']],
    ['pool-market', 'success', ['market', 'data', 'retrievedAt']],
    ['wallet-assets', 'fallback', ['snapshot', 'timestamp']],
    ['nft-positions', 'success', ['freshness', 'ageSeconds']],
    ['catalogue', 'success', ['revision']],
    ['catalogue', 'success', ['startBlock']],
    ['catalogue', 'success', ['indexedThrough']],
    ['pool-activity', 'success', ['storedEventCount']],
    ['pool-activity', 'success', ['window24h', 'fromTimestampExclusive']],
    ['pool-positions', 'success', ['positionAccounting', 'onchainReconciliation', 'blockNumber']],
    ['pool-metrics', 'qualified', ['capital', 'sourceEventCount']],
  ];
  for (const [route, name, segments] of cases) {
    for (const [value, expected] of [[Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER + 1, false],
      [true, false], ['9007199254740991', false]]) {
      const payload = fixture(route, name);
      let node = payload;
      for (const segment of segments.slice(0, -1)) node = node[segment];
      node[segments.at(-1)] = value;
      assert.equal(validateResponse(route, payload), expected, `${route}.${segments.join('.')}: ${value}`);
    }
  }
  const signed = fixture('pool-activity', 'success');
  signed.window24h.fromTimestampExclusive = -Number.MAX_SAFE_INTEGER;
  assert.equal(validateResponse('pool-activity', signed), true);
  signed.window24h.fromTimestampExclusive--;
  assert.equal(validateResponse('pool-activity', signed), false);
  const wallet = fixture('wallet-assets', 'fallback');
  wallet.items[1].amountRaw = (2n ** 256n - 1n).toString();
  assert.equal(validateResponse('wallet-assets', wallet), true);
  wallet.items[1].amountRaw = (2n ** 256n).toString();
  assert.equal(validateResponse('wallet-assets', wallet), false);
});

test('reference APR values never acquire current qualified status and every prerequisite is mandatory', () => {
  const reference = fixture('pool-metrics', 'reference-analytics');
  assert.equal(reference.valuation.status, 'reference_analytics_only');
  assert.equal(reference.valuation.complete24h, true);
  assert.equal(reference.freshness.status, 'fresh');
  assert.notEqual(reference.valuation.feeAprPercent, null);
  assert.notEqual(reference.valuation.tvlUsd, null);
  assert.equal(reference.usableAsCurrent24h, false);
  reference.usableAsCurrent24h = true;
  assert.equal(validateResponse('pool-metrics', reference), false);
  for (const [parent, key, value] of [['valuation', 'status', 'reference_analytics_only'],
    ['valuation', 'complete24h', false], ['capital', 'complete24h', false],
    ['valuation', 'feeAprPercent', null], ['freshness', 'status', 'stale']]) {
    const payload = fixture('pool-metrics', 'qualified');
    assert.equal(payload.usableAsCurrent24h, true);
    payload[parent][key] = value;
    assert.equal(validateResponse('pool-metrics', payload), false, `${parent}.${key}`);
    payload.usableAsCurrent24h = false;
    assert.equal(validateResponse('pool-metrics', payload), true);
  }
});


for (const item of read('fixtures/request-boundaries.json')) {
  test(`request boundary parity: ${item.route}/${item.name}`, () => {
    const exact = parseStrictJson(item.json, { numberLexemes: true });
    const parsed = JSON.parse(item.json);
    assert.equal(validateWireRequest(item.route, exact), item.valid, 'exact-lexeme Worker boundary');
    // A parsed JS number cannot reveal whether its original lexeme was 1 or 1.0.
    // Transport validation must precede the portable validator, as documented.
    assert.equal(validateRequest(item.route, parsed), item.parsedValid, 'portable parsed-JSON boundary');
    assert.equal(JSON.stringify(parsed), JSON.stringify(JSON.parse(item.json)));
  });
}

test('handwritten Worker request validator rejects unknown/prototype route keys safely', () => {
  for (const route of ['__proto__', 'constructor', 'toString', 'missing', null, ['token']]) {
    assert.equal(validateWireRequest(route, parseStrictJson('{"token":"'+token+'"}', { numberLexemes:true })), false);
  }
});
