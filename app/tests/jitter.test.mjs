/**
 * Added (2026-10-15, pack 8; incident design 2.5, limits item 3, package Q3, client side): every wait the page derives from
 * a Retry-After, or from a 429 or a "busy" answer, gets 0 to 25% more at random (src/lib/jitter.ts), so the thousands of
 * tabs one refusal reaches do not all ask again in the same second; never a wait shorter than the server named. Over a
 * seeded Math.random, so each run draws the same numbers; nothing reaches the network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const edge = require('../.test-build/app/src/lib/edge/chainRoutes.js');
const { createConfirmationReads } = require('../.test-build/app/src/lib/edge/confirmation.js');
const { readAgainAfter } = require('../.test-build/app/src/v2in/lists/read.js');
const { providerAgain, FIRST_TALLY } = require('../.test-build/app/src/lib/read/cardSeries.js');

/** mulberry32: a small seeded generator in [0, 1), as Math.random. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
Math.random = seeded(20261015);

/** The largest share of `waits` that falls in any one `slotMs` slot: how many tabs come back at the same moment. */
const busiest = (waits, slotMs) => {
  const slots = new Map();
  for (const wait of waits) slots.set(Math.floor(wait / slotMs), (slots.get(Math.floor(wait / slotMs)) ?? 0) + 1);
  return Math.max(...slots.values()) / waits.length;
};
/** Each of `waits` at least `named` and at most a quarter more; spread over that quarter, no 100 ms holding a sixth of them. */
function spreadOver(waits, named) {
  for (const wait of waits) assert.ok(wait >= named && wait <= named * 1.25, `${wait} within [${named}, ${named * 1.25}]`);
  assert.ok(Math.min(...waits) < named * 1.03 && Math.max(...waits) > named * 1.22, `spread over the quarter: ${Math.min(...waits)} to ${Math.max(...waits)}`);
  assert.ok(busiest(waits, 100) < 1 / 6, `no 100 ms holds a sixth of the tabs: ${busiest(waits, 100)}`);
}

test('jittered: 0 to 25% more at random, never less, a wait that is no wait handed back as it came', () => {
  const { jittered, JITTER_SHARE } = require('../.test-build/app/src/lib/jitter.js');
  assert.equal(JITTER_SHARE, 0.25);
  spreadOver(Array.from({ length: 10_000 }, () => jittered(5_000)), 5_000);
  assert.equal(jittered(5_000, () => 0), 5_000);
  assert.equal(jittered(5_000, () => 0.999_999), 6_249);
  for (const odd of [() => -1, () => 7, () => Number.NaN]) assert.ok(jittered(4_000, odd) >= 4_000 && jittered(4_000, odd) <= 5_000);
  for (const none of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(Object.is(jittered(none), none), true);
});

test('a chain route’s refusal: a thousand tabs told the same Retry-After come back spread over a quarter of it, never sooner', async () => {
  const tabs = async (status, headers, body) => {
    const waits = [];
    for (let tab = 0; tab < 1_000; tab++) {
      const answer = await edge.postState(['1'], false, { fetch: async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }) });
      assert.equal(answer.ok, false);
      waits.push(answer.retryAfterMs);
    }
    return waits;
  };
  // A 429 naming 5 s: before, all thousand at exactly 5,000 ms.
  spreadOver(await tabs(429, { 'Retry-After': '5' }, { v: 1, error: 'rate_limited' }), 5_000);
  // A 429 naming none: the rate refusal's own wait, spread the same.
  spreadOver(await tabs(429, {}, { v: 1, error: 'rate_limited' }), edge.RATE_RETRY_MS);
  // The node resting (a 502 chain_busy) naming 12 s, and the source away (a 503 naming 30 s).
  spreadOver(await tabs(502, { 'Retry-After': '12' }, { v: 1, error: 'chain_busy' }), 12_000);
  spreadOver(await tabs(503, { 'Retry-After': '30' }, { v: 1, error: 'rpc_unavailable' }), 30_000);
  // The longest wait is bounded first, then spread; a failure that names no wait still names none.
  spreadOver(await tabs(429, { 'Retry-After': '999999' }, { v: 1, error: 'rate_limited' }), edge.MAX_RETRY_MS);
  assert.deepEqual(new Set(await tabs(502, {}, { v: 1, error: 'rpc_unavailable' })), new Set([0]));
});

test('the edge’s "busy" confirmation: each tab rests the wait it named plus up to a quarter, never less', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ v: 2, state: 'busy', retryAfterMs: 8_000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const waits = [];
    for (let tab = 0; tab < 600; tab++) {
      const reads = createConfirmationReads();
      await assert.rejects(reads.read(`0x${'ab'.repeat(32)}`), (error) => {
        waits.push(error.retryAfterMs);
        return error.message === 'confirmation_unavailable';
      });
    }
    spreadOver(waits, 8_000);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test('the read gateway’s busy reader (read-v6): asked again after its Retry-After plus up to a quarter; the ladder itself unchanged', () => {
  const busy = { kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 30 };
  spreadOver(Array.from({ length: 1_000 }, () => readAgainAfter(busy, 1)), 30_000);
  assert.equal(readAgainAfter({ kind: 'unavailable', reason: 'read_capacity_busy' }, 1), 5_000, 'no Retry-After: the ladder as before');
  assert.equal(readAgainAfter({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 1 }, 3), 45_000, 'the ladder past the Retry-After');
  assert.equal(readAgainAfter({ kind: 'ok', body: {} }, 0), 60_000);
  // A card's busy service: never sooner than the 90 s it asked for.
  spreadOver(Array.from({ length: 1_000 }, () => providerAgain({ state: 'busy', retryAfterSeconds: 90 }, FIRST_TALLY).delay), 90_000);
});
