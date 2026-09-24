import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { artworkFromPairs, createTokenArtworkResolver, safeTokenImage, tokenArtworkKey } from '../src/lib/tokenArtwork.ts';

const address = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const image = 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=800&height=800';
const expected = 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto';
const pair = (overrides = {}) => ({ chainId: 'robinhood', baseToken: { address }, quoteToken: { address: other }, info: { imageUrl: image }, ...overrides });
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('artwork identity is only Robinhood and exact base token address, never quote or symbol', () => {
  assert.equal(tokenArtworkKey(4663, address.toUpperCase().replace('0X', '0x')), `4663:${address}`);
  for (const [chain, token] of [[1, address], [4663, 'WETH'], [4663, 'https://127.0.0.1'], [4663, `0x${'0'.repeat(40)}`]]) assert.equal(tokenArtworkKey(chain, token), null);
  assert.equal(artworkFromPairs([pair()], address), expected);
  assert.equal(artworkFromPairs([pair({ chainId: 'ethereum' })], address), null);
  assert.equal(artworkFromPairs([pair()], other), null);
  assert.equal(artworkFromPairs([pair({ baseToken: { address: other, symbol: 'WETH' } })], address), null);
  assert.equal(artworkFromPairs(Array(101).fill(pair()), address), null);
  assert.equal(artworkFromPairs([pair(), pair({ info: { imageUrl: image.replace('abcdefghijklmnop', 'differentimageid') } })], address), null);
});

test('image URL admits one opaque CDN path, reconstructs transforms, rejects arbitrary destinations and SVG/data', () => {
  assert.equal(safeTokenImage(image), expected);
  assert.equal(safeTokenImage(image + '&url=http://127.0.0.1'), expected, 'provider query is discarded, never forwarded');
  for (const value of ['http://cdn.dexscreener.com/cms/images/abcdefghijklmnop', 'https://cdn.dexscreener.com.evil.test/cms/images/abcdefghijklmnop', 'https://user@cdn.dexscreener.com/cms/images/abcdefghijklmnop', 'https://cdn.dexscreener.com:443/cms/images/abcdefghijklmnop', 'https://127.0.0.1/logo.png', 'data:image/svg+xml,<svg/>', 'https://cdn.dexscreener.com/cms/images/../../private', 'https://cdn.dexscreener.com/cms/images/%2e%2e', 'https://cdn.dexscreener.com/cms/images/file.svg', image + '#fragment']) assert.equal(safeTokenImage(value), null, value);
});

test('requests omit credentials/referrer, reject redirects, coalesce and cache success then image failure', async () => {
  let calls = 0;
  let now = 0;
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: async (url, init) => {
    calls++;
    assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${address}`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return json([pair()]);
  } });
  const first = resolver.resolve(4663, address);
  assert.equal(resolver.resolve(4663, address), first);
  assert.equal(await first, expected);
  assert.equal(await resolver.resolve(4663, address), expected);
  assert.equal(calls, 1);
  resolver.rejectImage(4663, address);
  assert.equal(await resolver.resolve(4663, address), null);
  now += 300001;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await resolver.resolve(4663, address), expected);
  assert.equal(calls, 2);
});

// 2026-09-24: New position's pool-id hints (src/lib/read/screens/poolHints.ts) read the same token-pairs body.
// Artwork and hints together still cost one GET per token: a body in flight is joined, and one read in the last
// 30 s is reused. The body is the provider's own, parsed; artwork still takes only the base token's image.
test('artwork and pool hints share one guarded GET per token, joined in flight and reused for 30 s', async () => {
  let calls = 0;
  let now = 0;
  const body = [pair(), { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: `0x${'c'.repeat(64)}`, baseToken: { address }, quoteToken: { address: other }, liquidity: { usd: 5 } }];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: async (url, init) => {
    calls++;
    assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${address}`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    return json(body);
  } });
  const [image, pairs] = await Promise.all([resolver.resolve(4663, address), resolver.pairs(4663, address.toUpperCase().replace('0X', '0x'))]);
  assert.equal(image, expected, 'the same artwork as before');
  assert.deepEqual(pairs, body, 'the parsed body, for the hints to check');
  assert.equal(calls, 1, 'one GET for both');
  now += 29_000;
  assert.deepEqual(await resolver.pairs(4663, address), body);
  assert.equal(calls, 1, 'reused within 30 s');
  now += 2_000;
  assert.deepEqual(await resolver.pairs(4663, address), body);
  assert.equal(calls, 2, 'read again after 30 s');
  assert.equal(await resolver.resolve(4663, address), expected, 'the artwork keeps its own hour');
  assert.equal(calls, 2);
  // Only a Robinhood address is ever asked, and nothing else.
  for (const [chain, token] of [[1, address], [4663, 'TOKEN'], [4663, `0x${'a'.repeat(39)}`]]) assert.equal(await resolver.pairs(chain, token), null);
  assert.equal(calls, 2);
  // 2026-09-23: native ETH's pools are asked by the zero address, the provider's own name for it; its artwork never is.
  const zero = `0x${'0'.repeat(40)}`;
  const nativeAsked = [];
  const native = createTokenArtworkResolver({ fetch: async (url) => { nativeAsked.push(url); return json(body); } });
  assert.deepEqual(await native.pairs(4663, zero), body);
  assert.equal(await native.resolve(4663, zero), null);
  assert.deepEqual(nativeAsked, [`https://api.dexscreener.com/token-pairs/v1/robinhood/${zero}`]);
});

// Review 2026-09-23: a failed read (a timeout, a 429, a network error, a body that is not JSON) was kept as the body
// for 30 s, so one artwork lookup that ran out of time turned New position's pool hints off for that token.
test('a failed token-pairs read is not kept: a hint request within 30 s asks again; the artwork keeps its own negative cache', async () => {
  let now = 0;
  let calls = 0;
  let failing = true;
  const body = [pair()];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: async () => {
    calls++;
    return failing ? new Response('{"error":"busy"}', { status: 429, headers: { 'content-type': 'application/json' } }) : json(body);
  } });
  assert.equal(await resolver.resolve(4663, address), null, 'the artwork lookup failed');
  assert.equal(calls, 1);
  now += 1_000;
  failing = false;
  assert.deepEqual(await resolver.pairs(4663, address), body, 'the hints ask again, within 30 s');
  assert.equal(calls, 2);
  assert.equal(await resolver.resolve(4663, address), null, 'the artwork keeps its own five minutes');
  assert.deepEqual(await resolver.pairs(4663, address), body, 'a body is kept');
  assert.equal(calls, 2);
  // A failed hints read is not kept either.
  let broken = 0;
  const other = createTokenArtworkResolver({ now: () => now, fetch: async () => (++broken === 1 ? new Response('{bad', { headers: { 'content-type': 'application/json' } }) : json(body)) });
  assert.equal(await other.pairs(4663, address), null);
  assert.deepEqual(await other.pairs(4663, address), body);
  assert.equal(broken, 2);
});

test('a hint request that joins an artwork read started with less time asks again once that read gives up', { timeout: 8000 }, async () => {
  let now = 0;
  const releases = [];
  const asked = [];
  const body = [pair()];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: (url, { signal }) => {
    if (!url.endsWith(address)) return new Promise((resolve) => releases.push(() => resolve(json([]))));
    asked.push(url);
    // The first read never answers, and gives up at its own deadline; the next one answers.
    if (asked.length === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return Promise.resolve(json(body));
  } });
  // Two lookups hold both slots, and this token's artwork waits behind them.
  const ahead = ['1', '2'].map((digit) => resolver.resolve(4663, `0x${digit.repeat(40)}`));
  const artwork = resolver.resolve(4663, address);
  assert.equal(asked.length, 0);
  now = 5_800;
  releases.shift()();
  await ahead[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, 'the artwork read started with 200 ms left');
  // The hints join it, and do not take its failure as their answer.
  assert.deepEqual(await resolver.pairs(4663, address), body);
  assert.equal(asked.length, 2, 'asked again once, with the hints’ own time');
  assert.equal(await artwork, null, 'the artwork lookup ran out of time');
  releases.shift()();
  await Promise.all(ahead);
});

test('missing, malformed, oversized, HTML and redirected replies keep neutral negative cache', async () => {
  for (const reply of [() => json([]), () => new Response('{bad', { headers: { 'content-type': 'application/json' } }), () => new Response('[]', { headers: { 'content-type': 'text/html' } }), () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '262145' } }), () => new Response(' '.repeat(262145), { headers: { 'content-type': 'application/json' } }), () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }), () => { const response = json([pair()]); Object.defineProperty(response, 'redirected', { value: true }); return response; }]) {
    let calls = 0;
    const resolver = createTokenArtworkResolver({ fetch: async () => { calls++; return reply(); } });
    assert.equal(await resolver.resolve(4663, address), null);
    assert.equal(await resolver.resolve(4663, address), null);
    assert.equal(calls, 1);
  }
});

test('two concurrent lookups maximum, queue expires without dispatch and cap prevents unbounded fanout', async () => {
  let now = 0;
  let calls = 0;
  const releases = [];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: () => { calls++; return new Promise((resolve) => releases.push(() => resolve(json([])))); } });
  const jobs = Array.from({ length: 33 }, (_, index) => resolver.resolve(4663, `0x${(index + 1).toString(16).padStart(40, '0')}`));
  assert.equal(calls, 2);
  assert.equal(await jobs[32], null);
  now = 6001;
  releases.forEach((release) => release());
  assert.deepEqual(await Promise.all(jobs), Array(33).fill(null));
  assert.equal(calls, 2);
});

test('metadata fetch aborts at the bounded deadline without retry', { timeout: 8000 }, async () => {
  let calls = 0;
  const resolver = createTokenArtworkResolver({ fetch: async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  assert.equal(await resolver.resolve(4663, address), null);
  assert.equal(calls, 1);
});

test('CSPs admit only explicit decoration hosts; component suppresses referrer and resets token lifecycle', () => {
  const middleware = readFileSync(new URL('../functions/_middleware.ts', import.meta.url), 'utf8');
  assert.ok(middleware.includes("img-src 'self' data: https://cdn.dexscreener.com"));
  assert.ok(middleware.includes("connect-src 'self' https://api.dexscreener.com"));
  const local = readFileSync(new URL('../scripts/local-live-vite.mjs', import.meta.url), 'utf8');
  assert.ok(local.includes("img-src 'self' data: https://cdn.dexscreener.com"));
  const component = readFileSync(new URL('../src/components/TokenIcon.tsx', import.meta.url), 'utf8');
  assert.match(component, /key=\{`\$\{token.chainId\}:\$\{token.address\}`\}/);
  assert.match(component, /referrerPolicy="no-referrer"/);
  assert.match(component, /brokenSrc !== src/);
});
