import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createOriginsCache, fundingWait } = require('../../.test-build/app/src/v2in/funds/originsCache.js');
const fixture = JSON.parse(readFileSync(new URL('../../../api-contracts/crosschain-v1/fixtures/responses/origins.json', import.meta.url), 'utf8'));
const OWNER = `0x${'11'.repeat(20)}`;
const REQUEST = { destinationChainId: fixture.origins.destinationChainId, destinationToken: fixture.origins.destinationToken };
const success = (request = REQUEST, status = 'listed') => {
  const data = structuredClone(fixture);
  Object.assign(data.origins, request);
  data.origins.providers[0].status = status;
  data.origins.providers[0].reason = status === 'listed' ? null : 'provider_unavailable';
  return { ok: true, route: 'origins', data, timing: { sentMono: 0, receivedMono: 1 }, source: 'http' };
};
const services = (origins, monoMs = () => 0, owner = OWNER) => ({ owner, clock: { monoMs }, client: { origins } });

test('typing different amounts shares one in-flight origins request and its successful listing', async () => {
  const cache = createOriginsCache();
  let count = 0, finish;
  const source = services((_request, options) => {
    count += 1;
    assert.equal(options.owner, OWNER);
    return new Promise((resolve) => { finish = resolve; });
  });
  // Amount does not belong to a route-discovery request. Each form revision asks for the same listing.
  const revisions = [10, 20, 50].map(() => cache(source, 'ready:session-one', { ...REQUEST }));
  assert.equal(count, 1);
  assert.equal(revisions[0], revisions[1]);
  assert.equal(revisions[1], revisions[2]);
  const listing = success();
  finish(listing);
  assert.deepEqual(await Promise.all(revisions), [listing, listing, listing]);
  assert.equal(await cache(source, 'ready:session-one', { ...REQUEST, destinationToken: REQUEST.destinationToken.toUpperCase() }), listing);
  assert.equal(count, 1, 'same destination address remains the same discovery identity');
});

test('owners, signed-in access, destination chains and destination tokens have separate listings', async () => {
  const cache = createOriginsCache(), asked = [];
  const makeSource = (owner) => services(async (request, options) => {
    const result = { ...success(request), scope: [options.owner, request.destinationChainId, request.destinationToken] };
    asked.push(result);
    return result;
  }, () => 0, owner);
  const first = makeSource(OWNER), other = makeSource(`0x${'22'.repeat(20)}`);
  const requests = [
    cache(first, 'ready:session-one', REQUEST),
    cache(other, 'ready:session-one', REQUEST),
    cache(first, 'ready:session-two', REQUEST),
    cache(first, 'ready:session-one', { ...REQUEST, destinationChainId: 8453 }),
    cache(first, 'ready:session-one', { ...REQUEST, destinationToken: '0x0000000000000000000000000000000000000000' }),
  ];
  const results = await Promise.all(requests);
  assert.equal(asked.length, 5);
  assert.equal(new Set(results).size, 5);
  assert.notEqual(results[0].scope[0], results[1].scope[0]);
  assert.equal(await cache(first, 'ready:session-one', REQUEST), results[0]);
  assert.equal(await cache(other, 'ready:session-one', REQUEST), results[1]);
});

test('a complete listing is reused for five minutes from receipt and expires at the boundary', async () => {
  const cache = createOriginsCache();
  let now = 0, count = 0, finish;
  const source = services(() => {
    count += 1;
    return count === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(success());
  }, () => now);
  const first = cache(source, 'ready:session-one', REQUEST);
  now = 20_000;
  finish(success());
  const listing = await first;
  now = 319_999;
  assert.equal(await cache(source, 'ready:session-one', REQUEST), listing);
  assert.equal(count, 1);
  now = 320_000;
  assert.notEqual(await cache(source, 'ready:session-one', REQUEST), listing);
  assert.equal(count, 2);
});

for (const status of ['rate_limited', 'unavailable']) {
  test(`a ${status} provider listing is retried after ten seconds, not cached for five minutes`, async () => {
    const cache = createOriginsCache();
    let now = 0, count = 0;
    const source = services(async () => { count += 1; return success(REQUEST, count === 1 ? status : 'listed'); }, () => now);
    const incomplete = await cache(source, 'ready:session-one', REQUEST);
    now = 9_999;
    assert.equal(await cache(source, 'ready:session-one', REQUEST), incomplete);
    assert.equal(count, 1);
    now = 10_000;
    const recovered = await cache(source, 'ready:session-one', REQUEST);
    assert.equal(recovered.data.origins.providers[0].status, 'listed');
    assert.equal(count, 2);
    now = 20_001;
    assert.equal(await cache(source, 'ready:session-one', REQUEST), recovered);
    assert.equal(count, 2, 'successful recovery receives the complete-list TTL');
  });
}

test('429 and transport rejection do not become cached route-discovery results', async () => {
  const cache = createOriginsCache();
  let count = 0;
  const limited = { ok: false, route: 'origins', failure: { kind: 'error', code: 'session_rate_limited', status: 429, retryAfterS: 60 } };
  const source = services(async () => {
    count += 1;
    if (count === 1) return limited;
    if (count === 2) throw new Error('transport stopped');
    return success();
  });
  assert.equal(await cache(source, 'ready:session-one', REQUEST), limited);
  await assert.rejects(cache(source, 'ready:session-one', REQUEST), /transport stopped/);
  const recovered = await cache(source, 'ready:session-one', REQUEST);
  assert.equal(recovered.ok, true);
  assert.equal(count, 3);
  assert.equal(await cache(source, 'ready:session-one', REQUEST), recovered);
  assert.equal(count, 3);
});

test('abandoning one amount stops its waiter without aborting discovery needed by the next amount', async () => {
  const cache = createOriginsCache();
  let count = 0, finish, clientOptions;
  const source = services((_request, options) => {
    count += 1; clientOptions = options;
    return new Promise((resolve) => { finish = resolve; });
  });
  const firstController = new AbortController();
  const first = fundingWait(cache(source, 'ready:session-one', REQUEST), firstController.signal);
  const next = fundingWait(cache(source, 'ready:session-one', REQUEST), new AbortController().signal);
  firstController.abort();
  await assert.rejects(first, /funding_cancelled/);
  assert.equal(clientOptions.signal, undefined, 'a consumer must not own the shared transport signal');
  const listing = success();
  finish(listing);
  assert.equal(await next, listing);
  assert.equal(await cache(source, 'ready:session-one', REQUEST), listing);
  assert.equal(count, 1);
});

test('funding waiter propagates failures and rejects already-cancelled consumers', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fundingWait(Promise.resolve(success()), controller.signal), /funding_cancelled/);
  await assert.rejects(fundingWait(Promise.reject(new Error('listing unavailable')), new AbortController().signal), /listing unavailable/);
});
