import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { artworkFromPairs, createTokenArtworkResolver, safeTokenImage, tokenArtworkKey } from '../src/lib/tokenArtwork.ts';
import { bundledTokenArtwork } from '../src/lib/bundledTokenArtwork.ts';

const address = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const image = 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=800&height=800';
const expected = 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto';
const pair = (overrides = {}) => ({ chainId: 'robinhood', baseToken: { address }, quoteToken: { address: other }, info: { imageUrl: image }, ...overrides });
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('the bundled USDC mark belongs only to its exact chain and contract', () => {
  const contracts = [
    [1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
    [8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
    [42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
    [10, '0x0b2c639c533813f4aa9d7837caf62653d097ff85'],
  ];
  for (const [chainId, address] of contracts) {
    assert.equal(bundledTokenArtwork(chainId, address.toUpperCase()), 'USDC');
    assert.equal(bundledTokenArtwork(4663, address), null, 'same address on Robinhood is not USDC');
    for (const [otherChain] of contracts) if (otherChain !== chainId) assert.equal(bundledTokenArtwork(otherChain, address), null);
  }
  assert.equal(bundledTokenArtwork(8453, 'USDC'), null, 'a symbol never selects artwork');
  assert.equal(bundledTokenArtwork(8453, address), null, 'another token keeps its own identity');
  const svg = readFileSync(new URL('../public/tokens/usdc.svg', import.meta.url), 'utf8');
  assert.match(svg, /<svg\b/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bon\w+=|(?:href|src)=/i, 'the bundled SVG is self-contained artwork');
});

// Changed on purpose 2026-10-06 (the owner's point 3: no icon on Base or Arbitrum One): the three chains a token can be
// on, each its own identity (chain plus address).
test('artwork identity is one of the three chains and the exact base token address, never quote or symbol', () => {
  assert.equal(tokenArtworkKey(4663, address.toUpperCase().replace('0X', '0x')), `4663:${address}`);
  assert.equal(tokenArtworkKey(8453, address), `8453:${address}`);
  assert.equal(tokenArtworkKey(42161, address), `42161:${address}`);
  for (const [chain, token] of [[1, address], [10, address], [4663, 'WETH'], [4663, 'https://127.0.0.1'], [4663, `0x${'0'.repeat(40)}`], [8453, `0x${'0'.repeat(40)}`]]) assert.equal(tokenArtworkKey(chain, token), null);
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
  // Changed on purpose 2026-09-28 (speed wave, item 42): the artwork keeps a failed lookup 30 s, not five minutes.
  assert.equal(await resolver.resolve(4663, address), null, 'the artwork keeps its failure for 30 s');
  assert.deepEqual(await resolver.pairs(4663, address), body, 'a body is kept');
  assert.equal(calls, 2);
  now += 30_000;
  assert.equal(await resolver.resolve(4663, address), expected, 'then asks again, and finds its image');
  assert.equal(calls, 3);
  // A failed hints read is not kept either.
  let broken = 0;
  const other = createTokenArtworkResolver({ now: () => now, fetch: async () => (++broken === 1 ? new Response('{bad', { headers: { 'content-type': 'application/json' } }) : json(body)) });
  assert.equal(await other.pairs(4663, address), null);
  assert.deepEqual(await other.pairs(4663, address), body);
  assert.equal(broken, 2);
});

// Changed on purpose 2026-09-28 (speed wave, item 42): an artwork lookup no longer starts its read with what is left of
// six seconds after waiting in the queue; it has all six from when its read starts. A read in flight can still have
// less time left than a caller that joins it, because it started earlier: that joiner still asks again when it fails.
test('a hint request that joins an artwork read started earlier asks again once that read gives up', { timeout: 8000 }, async () => {
  let now = 0;
  const asked = [];
  let fail;
  const body = [pair()];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: (url) => {
    asked.push(url);
    // The first read gets no answer (its deadline, a refusal or a lost connection); the next one answers.
    if (asked.length === 1) return new Promise((_resolve, reject) => { fail = () => reject(new Error('timed out')); });
    return Promise.resolve(json(body));
  } });
  const artwork = resolver.resolve(4663, address);
  assert.equal(asked.length, 1, 'the artwork read starts at once, with its six seconds');
  now = 3_000;
  // The hints join it with more time than it has left, and do not take its failure as their answer.
  const hints = resolver.pairs(4663, address);
  assert.equal(asked.length, 1, 'joined, not asked twice');
  fail();
  assert.deepEqual(await hints, body);
  assert.equal(asked.length, 2, 'asked again once, with the hints’ own time');
  assert.equal(await artwork, null, 'the artwork lookup got no answer');
});

// 2026-09-28 (speed wave, item 42): a lookup's six seconds start when its read starts. It used to count the time it
// waited for one of the two slots, so a token late in a long queue ran out of time without ever being asked, and then
// showed no image for five minutes.
test('a queued lookup gets its six seconds from when its read starts, not from when it was queued', { timeout: 8000 }, async () => {
  let now = 0;
  const asked = [];
  const releases = [];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: (url) => {
    asked.push(url);
    if (url.endsWith(address)) return Promise.resolve(json([pair()]));
    return new Promise((resolve) => releases.push(() => resolve(json([]))));
  } });
  const ahead = ['1', '2'].map((digit) => resolver.resolve(4663, `0x${digit.repeat(40)}`));
  const queued = resolver.resolve(4663, address);
  assert.equal(asked.length, 2, 'two slots, both taken');
  now = 7_000;
  releases.shift()();
  assert.equal(await queued, expected, 'asked once a slot was free, seven seconds after it was queued, and answered');
  assert.equal(asked.length, 3);
  releases.shift()();
  await Promise.all(ahead);
});

// 2026-09-28 (speed wave, item 42): no answer is not an answer. A lookup that got none is kept 30 s; the provider's
// answer that names no image five minutes; found artwork an hour.
// Changed on purpose 2026-09-28 (speed wave, review): each lookup is let finish before the fake clock moves (its entry
// in flight goes one turn after its answer, and an ask in that turn joins it instead of reading what was kept), and
// what is kept is read with peek one millisecond before and at each limit, so every one of the three limits is checked.
test('a lookup that got no answer is kept 30 s, an answer with no image five minutes, found artwork an hour', { timeout: 8000 }, async () => {
  let now = 0;
  let calls = 0;
  let reply = () => new Response('{"error":"busy"}', { status: 429, headers: { 'content-type': 'application/json' } });
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: async () => { calls++; return reply(); } });
  const ask = async () => {
    const value = await resolver.resolve(4663, address);
    await new Promise((resolve) => setImmediate(resolve));
    return value;
  };
  assert.equal(await ask(), null, 'refused');
  assert.equal(calls, 1);
  now += 29_999;
  assert.equal(resolver.peek(4663, address), null, 'a refusal is still kept at 30 s less 1 ms');
  assert.equal(await ask(), null);
  assert.equal(calls, 1, 'kept for 30 s');
  now += 1;
  assert.equal(resolver.peek(4663, address), undefined, 'and no longer at 30 s');
  reply = () => json([]);
  assert.equal(await ask(), null, 'the provider answers: no image');
  assert.equal(calls, 2, 'asked again after 30 s');
  now += 299_999;
  assert.equal(resolver.peek(4663, address), null, 'an answer with no image is still kept at five minutes less 1 ms');
  assert.equal(await ask(), null);
  assert.equal(calls, 2, 'an answer with no image is kept five minutes');
  now += 1;
  assert.equal(resolver.peek(4663, address), undefined, 'and no longer at five minutes');
  reply = () => json([pair()]);
  assert.equal(await ask(), expected);
  assert.equal(calls, 3);
  now += 3_599_999;
  assert.equal(resolver.peek(4663, address), expected, 'found artwork is still kept at an hour less 1 ms');
  assert.equal(await ask(), expected);
  assert.equal(calls, 3, 'found artwork is kept an hour');
  now += 1;
  assert.equal(resolver.peek(4663, address), undefined, 'and no longer at an hour');
  assert.equal(await ask(), expected);
  assert.equal(calls, 4, 'then asked again');
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

// Changed on purpose 2026-09-28 (speed wave, item 42): a queued lookup is no longer dropped once six seconds have
// passed in the queue; every lookup under the cap is asked in turn, two at a time. The cap stays, and what it turns
// away is kept as a failure (30 s), not as "no image" (five minutes).
// Changed on purpose 2026-09-28 (speed wave, review): every read this test starts is answered by hand, so each check
// is made before anything is awaited and a regression fails at once, with a time limit as the last resort, never hangs.
test('two concurrent lookups maximum, the queue drains in turn and the cap prevents unbounded fanout', { timeout: 8000 }, async () => {
  let now = 0;
  let calls = 0;
  let most = 0;
  let open = 0;
  const releases = [];
  const resolver = createTokenArtworkResolver({ now: () => now, fetch: () => {
    calls++;
    most = Math.max(most, ++open);
    return new Promise((resolve) => releases.push(() => { open--; resolve(json([])); }));
  } });
  const token = (index) => `0x${(index + 1).toString(16).padStart(40, '0')}`;
  const jobs = Array.from({ length: 33 }, (_, index) => resolver.resolve(4663, token(index)));
  assert.equal(calls, 2);
  assert.equal(resolver.peek(4663, token(32)), null, 'over the cap: kept at once as no answer');
  assert.equal(await jobs[32], null, 'over the cap: no lookup at all');
  now = 6001;
  let settled = false;
  const all = Promise.all(jobs).then((values) => { settled = true; return values; });
  // Answer each read in turn; the next one in the queue is asked once a slot frees.
  for (let turn = 0; !settled && turn < 1_000; turn++) {
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(settled, 'every lookup under the cap was answered in turn');
  assert.deepEqual(await all, Array(33).fill(null));
  assert.equal(calls, 32, 'every lookup under the cap was asked');
  assert.equal(most, 2, 'never more than two at once');
  // The cap turned it away at 0 ms.
  now = 29_999;
  const kept = resolver.resolve(4663, token(32));
  assert.equal(calls, 32, 'the one the cap turned away is kept 30 s');
  assert.equal(await kept, null);
  now = 30_000;
  const retry = resolver.resolve(4663, token(32));
  assert.equal(calls, 33, 'then asked');
  releases.shift()();
  assert.equal(await retry, null);
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
  // Changed on purpose 2026-10-01 (platform workstream): the page's CSP is data (APP_CSP_SOURCES, one source per line), so
  // the header it makes is checked, from the compiled middleware, rather than the source's text.
  const { APP_CSP } = createRequire(import.meta.url)('../.test-build/app/functions/_middleware.js');
  const parts = APP_CSP.split('; ');
  assert.ok(parts.some((part) => part.startsWith("img-src 'self' data: https://cdn.dexscreener.com")), APP_CSP);
  assert.ok(parts.some((part) => part.startsWith("connect-src 'self' https://api.dexscreener.com")), APP_CSP);
  const local = readFileSync(new URL('../scripts/local-live-vite.mjs', import.meta.url), 'utf8');
  assert.ok(local.includes("img-src 'self' data: https://cdn.dexscreener.com"));
  const component = readFileSync(new URL('../src/components/TokenIcon.tsx', import.meta.url), 'utf8');
  assert.match(component, /key=\{`\$\{token.chainId\}:\$\{token.address\}`\}/);
  assert.match(component, /referrerPolicy="no-referrer"/);
  assert.match(component, /brokenSrc !== src/);
});

// Added 2026-10-06 (the owner's point 3: Base and Arbitrum One "like Robinhood Chain", their icons and their pools'
// figures): the same guarded read for a token on Base or Arbitrum One, by the provider's own name for its chain, its
// artwork only from that chain's pairs, one body per chain and address, and our edge first with the chain named.
test('Base and Arbitrum One: artwork and pairs by the chain’s own name, one body per chain and address, through our edge with the chain named', async () => {
  const base = (overrides = {}) => pair({ chainId: 'base', ...overrides });
  assert.equal(artworkFromPairs([base()], address, 8453), expected);
  assert.equal(artworkFromPairs([base()], address), null, 'a Robinhood Chain lookup never takes Base’s image');
  assert.equal(artworkFromPairs([pair()], address, 8453), null, 'nor Base’s a Robinhood Chain image');
  assert.equal(artworkFromPairs([base()], address, 1), null, 'a chain these reads do not cover');
  const asked = [];
  const heard = [];
  const resolver = createTokenArtworkResolver({ wall: () => 5_000, fetch: async (url) => {
    asked.push(url);
    return json(url.includes('/base/') ? [base()] : url.includes('/arbitrum/') ? [pair({ chainId: 'arbitrum', info: {} })] : [pair()]);
  } });
  resolver.onPairs((token, body, retrievedAt, chainId) => heard.push([token, chainId]));
  assert.equal(await resolver.resolve(8453, address), expected);
  assert.equal(await resolver.resolve(42161, address), null, 'Arbitrum One’s pairs name no image for it');
  assert.equal(await resolver.resolve(4663, address), expected);
  assert.deepEqual(asked, [8453, 42161, 4663].map((chain) => `https://api.dexscreener.com/token-pairs/v1/${{ 8453: 'base', 42161: 'arbitrum', 4663: 'robinhood' }[chain]}/${address}`), 'one GET per chain, never one chain’s body for another');
  assert.deepEqual(heard, [[address, 8453], [address, 42161], [address, 4663]], 'every body heard with its chain');
  assert.deepEqual(await resolver.pairs(8453, `0x${'0'.repeat(40)}`), [base()], 'native ETH’s pairs by the zero address');
  assert.equal(await resolver.pairs(10, address), null);
  assert.equal(resolver.peek(8453, address), expected);
  assert.equal(resolver.peek(4663, other), undefined);
  // Our edge, where the deployment has it: Base's and Arbitrum One's token-pairs name the chain before the token.
  const viaEdge = [];
  const edged = createTokenArtworkResolver({ edge: '/api/read/dex/', fetch: async (url) => (viaEdge.push(url), json([base()])) });
  await edged.pairs(8453, address);
  await edged.pairs(42161, other);
  await edged.pairs(4663, address);
  assert.deepEqual(viaEdge, [`/api/read/dex/token-pairs/base/${address}`, `/api/read/dex/token-pairs/arbitrum/${other}`, `/api/read/dex/token-pairs/${address}`]);
});

// Added 2026-10-06 (review of the same day, audit I3): our edge gave no answer for a little-read Base token; that sends
// Base's reads to the provider directly for five minutes, never Robinhood Chain's, nor the Wallet card's `tokens` batch.
test('our edge given up for one chain only: a miss on Base keeps Robinhood Chain’s reads and the Wallet card’s prices on our edge', async () => {
  const asked = [];
  let at = 0;
  const resolver = createTokenArtworkResolver({ edge: '/api/read/dex/', now: () => at, wall: () => 1, fetch: async (url) => {
    asked.push(url);
    if (url === `/api/read/dex/token-pairs/base/${address}`) return new Response('{"error":"upstream_unavailable"}', { status: 502, headers: { 'content-type': 'application/json' } });
    return json([pair({ chainId: url.includes('/base/') ? 'base' : 'robinhood' })]);
  } });
  await resolver.pairs(8453, address);
  assert.deepEqual(asked, [`/api/read/dex/token-pairs/base/${address}`, `https://api.dexscreener.com/token-pairs/v1/base/${address}`], 'Base: the provider directly once our edge gave no answer');
  asked.length = 0;
  at += 31_000;
  await resolver.pairs(4663, address);
  await resolver.tokenPrices([address, other]);
  await resolver.pairs(8453, other);
  assert.deepEqual(asked, [
    `/api/read/dex/token-pairs/${address}`,
    `/api/read/dex/tokens/${[address, other].sort().join(',')}`,
    `https://api.dexscreener.com/token-pairs/v1/base/${other}`,
  ], 'Robinhood Chain’s reads still on our edge; Base’s directly for five minutes');
  asked.length = 0;
  at += 300_001;
  await resolver.pairs(8453, `0x${'c'.repeat(40)}`);
  assert.deepEqual(asked, [`/api/read/dex/token-pairs/base/0x${'c'.repeat(40)}`], 'then Base’s on our edge again');
});
