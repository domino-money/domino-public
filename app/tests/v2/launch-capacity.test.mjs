/**
 * Added 2026-10-30 (launch capacity, CAP-5, CAP-6, CAP-11; C:/dwt/launch-2026-11-01/CAPACITY.md items 5, 6 and 11): what
 * the app does with the services' refusals at launch load, on a clock and a random draw the test hands in.
 *
 *   - A capacity-busy refusal (a worker slot taken: position_plan_, crosschain_, session_, onboarding_capacity_busy) holds
 *     the wallet's requests and is asked again after 4 to 5 s, never the 60 s every 429 names; a rate limit keeps its
 *     Retry-After (finance/v2/requestCoordinator.ts, and the funding offer's requestFailure).
 *   - The funding offer's speculative quotes: one ask per identical request, its answer reused for 12 s, an abandoned
 *     preparation stopping only its own wait, and the ask itself stopped once nobody waits for it (v2in/funds/quoteCache.ts).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const build = (path) => require(`../../.test-build/app/src/${path}.js`);
const coordinator = build('finance/v2/requestCoordinator');
const model = build('v2in/funds/model');
const { createQuoteCache, FUNDS_QUOTE_REUSE_MS } = build('v2in/funds/quoteCache');
const constants = build('v2in/funds/constants');

const OWNER = `0x${'11'.repeat(20)}`;
const BUSY = ['position_plan_capacity_busy', 'crosschain_capacity_busy', 'session_capacity_busy', 'onboarding_capacity_busy'];
const LIMITS = ['session_rate_limited', 'onboarding_rate_limited', 'provider_rate_limited'];

test('a capacity-busy refusal holds the wallet 4 to 5 s, never later than its Retry-After; a rate limit keeps its Retry-After', () => {
  assert.equal(coordinator.CAPACITY_BUSY_WAIT_MS, 4_000);
  for (const code of BUSY) {
    assert.equal(coordinator.isCapacityBusy(code), true, code);
    assert.equal(coordinator.refusalDelay('60', code, 0, () => 0), 4_000, `${code}: the short wait, not 60 s`);
    assert.equal(coordinator.refusalDelay('60', code, 0, () => 0.999_999), 4_999, `${code}: up to a quarter more, at random`);
    assert.equal(coordinator.refusalDelay(null, code, 0, () => 0.5), 4_500, `${code}: whatever Retry-After is missing`);
  }
  assert.equal(coordinator.refusalDelay('2', 'position_plan_capacity_busy', 0, () => 0.999), 2_000, 'never later than the Retry-After named');
  for (const code of [...LIMITS, 'upstream_unavailable', null]) {
    assert.equal(coordinator.isCapacityBusy(code), false, String(code));
    assert.equal(coordinator.refusalDelay('60', code, 0), 60_000, `${code}: its Retry-After`);
  }
  assert.equal(coordinator.refusalDelay(null, 'session_rate_limited', 0), 60_000, 'a missing Retry-After keeps the one-minute window');
  for (const odd of [() => -1, () => 7, () => Number.NaN]) {
    const wait = coordinator.capacityBusyWait(odd);
    assert.ok(wait >= 4_000 && wait <= 5_000, String(wait));
  }
});

test('the funding offer: a capacity-busy refusal is asked again after 4 to 5 s; a rate limit after its Retry-After', () => {
  for (const code of ['crosschain_capacity_busy', 'session_capacity_busy', 'onboarding_capacity_busy']) {
    const failure = model.requestFailure({ kind: 'error', code, status: 429, retryAfterS: 60 }, 1);
    assert.ok(failure.retryMs >= 4_000 && failure.retryMs <= 5_000, `${code}: ${failure.retryMs}`);
    assert.equal(model.requestFailure({ kind: 'error', code, status: 429, retryAfterS: 60 }, 2).retryMs <= 5_000, true, `${code}: the second wait too`);
  }
  assert.equal(model.requestFailure({ kind: 'error', code: 'session_rate_limited', status: 429, retryAfterS: 30 }, 1).retryMs, 30_000);
  assert.equal(model.requestFailure({ kind: 'error', code: 'onboarding_rate_limited', status: 429, retryAfterS: 30 }, 2).retryMs, 60_000);
  assert.equal(constants.FUNDS_ROUTES_BUSY_RETRY_MS, 60_000, 'no route while every provider is busy: a minute at least');
  assert.equal(constants.FUNDS_AUTO_RETRIES, 3, 'an amount is prepared again by itself a few times, then only on request');
});

// Added 2026-10-30 (its review): the quote already spends its two quick retries on a capacity-busy refusal, so the offer's
// next preparation by itself waits a minute, as it does with no route; never three more asks every few seconds.
test('the funding offer: a failed preparation waits a minute after no route or a capacity-busy refusal, else 5 s', () => {
  for (const code of ['funding_routes_busy', 'crosschain_capacity_busy', 'session_capacity_busy', 'onboarding_capacity_busy', 'position_plan_capacity_busy']) {
    assert.equal(model.preparationRetryFloor(code), constants.FUNDS_ROUTES_BUSY_RETRY_MS, code);
  }
  for (const code of ['session_rate_limited', 'provider_rate_limited', 'funding_plan_timeout', 'quote_unavailable', null, undefined]) {
    assert.equal(model.preparationRetryFloor(code), constants.FUNDS_REQUEST_RETRY_MS, String(code));
  }
  assert.equal(constants.FUNDS_REQUEST_RETRY_MS, 5_000);
});

const REQUEST = { originChainId: 42161, originToken: `0x${'af'.repeat(20)}`, destinationChainId: 4663, destinationToken: `0x${'5f'.repeat(20)}`, amountKind: 'exact_input', amountRaw: '100000000', maxInputRaw: null, slippageBps: 50, destinationGas: false };
const quoted = (n) => ({ ok: true, route: 'quote', data: { quote: { n } }, timing: { sentMono: n, receivedMono: n + 1 }, source: 'http' });

/** A client whose asks the test answers by hand, recording each ask's options. */
function client() {
  const asks = [];
  return {
    asks,
    quote: (request, options) => new Promise((resolve) => {
      const ask = { request, options, resolve };
      asks.push(ask);
      options.signal?.addEventListener('abort', () => resolve({ ok: false, route: 'quote', failure: { kind: 'aborted' } }), { once: true });
    }),
  };
}
const servicesOf = (quotes, now = () => 0, owner = OWNER) => ({ owner, clock: { monoMs: now }, client: quotes });

test('one ask per identical quote request, its answer reused for 12 s, then asked anew; another amount, wallet or session asks its own', async () => {
  assert.equal(FUNDS_QUOTE_REUSE_MS, 12_000);
  let now = 0;
  const quotes = client();
  const cache = createQuoteCache();
  const services = servicesOf(quotes, () => now);
  const first = cache(services, 'ready:1', { ...REQUEST });
  const joined = cache(services, 'ready:1', { ...REQUEST });
  assert.equal(quotes.asks.length, 1, 'the same request in flight is joined');
  assert.equal(quotes.asks[0].options.owner, OWNER);
  assert.equal(quotes.asks[0].options.priority, 'preview', 'speculative: it queues behind tracking and actions');
  quotes.asks[0].resolve(quoted(1));
  assert.deepEqual(await Promise.all([first, joined]), [quoted(1), quoted(1)]);
  now = 11_999;
  assert.deepEqual(await cache(services, 'ready:1', { ...REQUEST }), quoted(1), 'reused, with the first ask\'s timing');
  assert.equal(quotes.asks.length, 1);
  void cache(services, 'ready:1', { ...REQUEST, amountRaw: '200000000' });
  void cache(servicesOf(quotes, () => now, `0x${'22'.repeat(20)}`), 'ready:1', { ...REQUEST });
  void cache(services, 'ready:2', { ...REQUEST });
  assert.equal(quotes.asks.length, 4, 'another amount, wallet or session is its own ask');
  now = 12_000;
  void cache(services, 'ready:1', { ...REQUEST });
  assert.equal(quotes.asks.length, 5, 'past 12 s it is asked anew');
});

test('a refusal or a failure is never reused', async () => {
  const quotes = client();
  const cache = createQuoteCache();
  const services = servicesOf(quotes);
  const refused = { ok: false, route: 'quote', failure: { kind: 'error', code: 'provider_rate_limited', status: 429, retryAfterS: 30 } };
  const asked = cache(services, 'ready:1', REQUEST);
  quotes.asks[0].resolve(refused);
  assert.deepEqual(await asked, refused);
  const again = cache(services, 'ready:1', REQUEST);
  assert.equal(quotes.asks.length, 2, 'asked anew');
  quotes.asks[1].resolve(quoted(2));
  assert.deepEqual(await again, quoted(2));
});

test('an abandoned preparation stops its own wait; the ask stops only once nobody waits for it, and is not kept', async () => {
  const quotes = client();
  const cache = createQuoteCache();
  const services = servicesOf(quotes);
  const mine = new AbortController();
  const other = new AbortController();
  const a = cache(services, 'ready:1', REQUEST, mine.signal);
  const b = cache(services, 'ready:1', REQUEST, other.signal);
  assert.equal(quotes.asks.length, 1);
  mine.abort();
  assert.deepEqual(await a, { ok: false, route: 'quote', failure: { kind: 'aborted' } });
  assert.equal(quotes.asks[0].options.signal.aborted, false, 'still wanted by the other preparation');
  other.abort();
  assert.deepEqual(await b, { ok: false, route: 'quote', failure: { kind: 'aborted' } });
  assert.equal(quotes.asks[0].options.signal.aborted, true, 'nobody waits: a queued ask never takes a slot for nobody');
  const fresh = cache(services, 'ready:1', REQUEST);
  assert.equal(quotes.asks.length, 2, 'an ask nobody waited for is asked anew');
  quotes.asks[1].resolve(quoted(3));
  assert.deepEqual(await fresh, quoted(3));
  const gone = new AbortController();
  gone.abort();
  assert.deepEqual(await cache(services, 'ready:1', { ...REQUEST, amountRaw: '1' }, gone.signal), { ok: false, route: 'quote', failure: { kind: 'aborted' } });
  assert.equal(quotes.asks.length, 2, 'a preparation already abandoned asks nothing');
});
