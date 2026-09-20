import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateRequest, validateResponse, matchesRequest } from './runtime.mjs';

const fixture = route => JSON.parse(readFileSync(new URL(`./fixtures/${route}.json`, import.meta.url), 'utf8'));
const hash = digit => '0x' + digit.repeat(64);
const address = digit => '0x' + digit.repeat(40);

test('generated producer fixtures are accepted, exact public envelope is enforced', () => {
  for (const route of ['overview', 'search', 'history', 'capabilities']) {
    const response = fixture(route);
    assert.equal(validateResponse(route, response), true, route);
    assert.equal(validateResponse(route, { ...response, owner: address('9') }), false);
    assert.equal(validateResponse(route, { ...response, chainId: 1 }), false);
  }
});

test('overview selection, paging and per-request budget are bounded without a token allowlist', () => {
  assert.equal(validateRequest('overview', { token: address('9') }), true);
  assert.equal(validateRequest('overview', { poolIds: [hash('a')] }), true);
  for (const request of [{}, { token: address('9'), poolIds: [hash('a')] }, { poolIds: [hash('a'), hash('a')] },
    { token: address('9'), afterPoolId: hash('a') }, { token: address('9'), limit: 25 }]) assert.equal(validateRequest('overview', request), false);
  assert.equal(validateRequest('overview', { token: address('9'), afterPoolId: hash('a'), revision: 1 }), true);
});

test('nested metadata/APR evidence is validated, never repaired or promoted', () => {
  let response = fixture('overview');
  response.tokens[0].value.asset.address = address('9');
  assert.equal(validateResponse('overview', response), false);
  response = fixture('overview'); response.tokens[0].observedAt = null;
  assert.equal(validateResponse('overview', response), false);
  response = fixture('overview'); response.pools[0].value.estimate.feeAprEstimate24hPercent = '999';
  assert.equal(validateResponse('overview', response), false);
  response = fixture('overview'); response.pools.push(response.pools[0]);
  assert.equal(validateResponse('overview', response), false);
  response = fixture('overview'); response.hasMore = true;
  assert.equal(validateResponse('overview', response), false);
  response = fixture('overview'); response.pools[0].value = null; response.pools[0].observedAt = null;
  response.pools[0].acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: null };
  assert.equal(validateResponse('overview', response), true, 'pending observations remain explicit nulls');
});

test('responses must echo requested identity; unrelated pools and changed cursors are refused', () => {
  const response = fixture('overview');
  assert.equal(matchesRequest('overview', { poolIds: response.requestedPoolIds }, response), true);
  assert.equal(matchesRequest('overview', { poolIds: [hash('a')] }, response), false);
  assert.equal(matchesRequest('overview', { token: address('9') }, response), false);
  assert.equal(matchesRequest('search', { query: 'TOKEN' }, fixture('search')), true);
  assert.equal(matchesRequest('search', { query: 'elsewhere' }, fixture('search')), false);
});

test('history is explicitly a ratio, bounded, ordered, covered and never a USD candle', () => {
  const response = fixture('history');
  assert.equal(matchesRequest('history', { poolId: response.poolId, currency: response.currency }, response), true);
  assert.equal(validateRequest('history', { poolId: response.poolId, currency: response.currency, windowSeconds: 2592000, resolutionSeconds: 60 }), false);
  assert.equal(validateResponse('history', { ...response, unit: 'usd' }), false);
  assert.equal(validateResponse('history', { ...response, quoteCurrency: response.currency }), false);
  assert.equal(validateResponse('history', { ...response, candles: [...response.candles, response.candles[0]] }), false);
  assert.equal(validateResponse('history', { ...response, snapshot: null }), false);
  assert.equal(validateResponse('history', { ...response, gaps: [{ startTimestamp: 3, endTimestamp: 2 }] }), false);
  assert.equal(matchesRequest('history', { poolId: response.poolId, currency: address('9') }, response), false);
});
