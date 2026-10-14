/**
 * TEST-ONLY. The Wallet card's DEX reads answered by our edge's real route code behind the test server (incident of
 * 2026-10-13, package D2's reproduction, 2026-10-14).
 *
 * - `createDexUpstream`: DEX Screener's `token-pairs/v1/robinhood/<token>` as a double (the only upstream our edge
 *   asks): each token's pairs from a table, an empty list for a token with no market, and on demand a refusal (a status
 *   with Retry-After) or a slow answer. Every upstream call is recorded.
 * - `createDexEdgeRoute`: a wallet-server route (tests/support/wallet-server.mjs `routes`) that answers
 *   /api/read/dex/<ask> with functions/_lib/dexEdge.ts `answerDex` and, where the tree has it (the D1 commit on),
 *   /api/read/dex2/<ask> with `answerDex2`, from the unit build (.test-build), on a memory cache standing in for
 *   Cloudflare's, the upstream double for `fetch`, and the visitor's network as Cloudflare would name it. These are the
 *   functions functions/api/read/dex/[[path]].ts and dex2/[[path]].ts call; nothing is reimplemented here. Every ask
 *   the page sent is recorded with its status.
 * - `edgeOnInTestBuild`: the test builds have no edge (lib/tokenArtwork.ts asks our edge first "in the deployable
 *   builds only"), so the page's one resolver is built with `{edge:null}` there. This rewrites that one literal, in the
 *   served bundle only, to production's `{edge:"/api/read/dex/"}`, so the card takes production's path through our
 *   edge, and counts the rewrite (exactly one, or the test would be measuring something else).
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '../..');

/** The upstream path our edge asks for one token on Robinhood Chain. */
const UPSTREAM = /^https:\/\/api\.dexscreener\.com\/token-pairs\/v1\/robinhood\/(0x[0-9a-fA-F]{40})$/;

function memoryCache() {
  const entries = new Map();
  return {
    entries,
    async match(request) { const entry = entries.get(request.url); return entry ? entry.clone() : undefined; },
    async put(request, response) { entries.set(request.url, new Response(await response.text(), response)); },
  };
}

const sleep = (ms, signal) => new Promise((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

/**
 * `pairsOf(token)`: the provider's pairs for a token (lowercase), [] for none. `refuse` (status, retryAfter) answers
 * every call with that status while set; `delayMs` holds every answer that long (honouring the edge's own abort).
 */
export function createDexUpstream({ pairsOf, refuse = null, delayMs = 0 } = {}) {
  const calls = [];
  const state = { refuse, delayMs };
  const upstream = {
    calls,
    state,
    /** Our edge's upstream fetch: recorded in `calls`. */
    async fetch(input, init = {}) {
      calls.push(input);
      return upstream.answer(input, init);
    },
    /** The same answer, not recorded: for the page's direct asks, which a test counts apart. */
    async answer(input, init = {}) {
      const token = UPSTREAM.exec(input)?.[1]?.toLowerCase();
      if (state.delayMs > 0) await sleep(state.delayMs, init.signal);
      if (state.refuse) {
        return new Response('{"error":"refused"}', { status: state.refuse.status, headers: { 'Content-Type': 'application/json', ...(state.refuse.retryAfter ? { 'Retry-After': String(state.refuse.retryAfter) } : {}) } });
      }
      const pairs = token ? (pairsOf(token) ?? []) : [];
      return new Response(JSON.stringify(pairs), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return upstream;
}

/** The real route code of `tree` (the app directory whose unit build answers), mounted as a wallet-server route. */
export function createDexEdgeRoute(upstream, { tree = APP } = {}) {
  const edge = require(resolve(tree, '.test-build/app/functions/_lib/dexEdge.js'));
  const cache = memoryCache();
  const memory = typeof edge.dexMemory === 'function' ? edge.dexMemory() : undefined;
  const inflight = memory?.inflight ?? new Map();
  const refreshing = memory?.refreshing ?? new Map();
  const later = [];
  /** Every ask the page sent to either path, in order: its path (below the prefix), its status, and its tokens. */
  const asked = [];
  return {
    asked,
    cache,
    hasDex2: typeof edge.answerDex2 === 'function',
    /** The asks for prices (`tokens/…`), on either path. */
    priceAsks: () => asked.filter((one) => one.kind === 'tokens'),
    /** The asks for one token's pairs (`token-pairs/…`): artwork and figures. */
    pairAsks: () => asked.filter((one) => one.kind === 'token-pairs'),
    async settle() { await Promise.allSettled(later.splice(0)); },
    async handle(request, url) {
      const two = url.pathname.startsWith('/api/read/dex2/');
      if (!two && !url.pathname.startsWith('/api/read/dex/')) return undefined;
      const rest = url.pathname.slice(two ? '/api/read/dex2/'.length : '/api/read/dex/'.length);
      const kind = rest.split('/')[0];
      const entry = { path: two ? 'dex2' : 'dex', kind, tokens: (rest.split('/').at(-1) ?? '').split(','), status: 0 };
      asked.push(entry);
      if (two && typeof edge.answerDex2 !== 'function') {
        entry.status = 404;
        return new Response('not found', { status: 404 });
      }
      const headers = new Headers(request.headers);
      // What Cloudflare adds: the visitor's address. Nothing else is changed.
      headers.set('CF-Connecting-IP', '203.0.113.9');
      const real = new Request(request.url, { method: request.method, headers });
      const rt = { cache, now: () => Date.now(), waitUntil: (work) => later.push(work), fetch: upstream.fetch, inflight, refreshing, ...(memory ? { memory } : {}) };
      const response = two ? await edge.answerDex2(real, rt) : await edge.answerDex(real, rt);
      entry.status = response.status;
      return response;
    },
  };
}

/** The one literal the test builds give the page's DEX resolver, and production's, which asks our edge first. */
export const TEST_BUILD_EDGE = '({edge:null})';
export const PRODUCTION_EDGE = '({edge:"/api/read/dex/"})';

/**
 * Serves the page's scripts with the DEX resolver built as production builds it (`edgeOnInTestBuild`). Returns the
 * count of rewrites made; a page loaded after this must show exactly one.
 */
export async function edgeOnInTestBuild(context, origin) {
  const rewrites = { count: 0 };
  await context.route((url) => url.href.startsWith(`${origin}/assets/`) && url.pathname.endsWith('.js'), async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const found = body.split(TEST_BUILD_EDGE).length - 1;
    if (found === 0) return route.fulfill({ response, body });
    rewrites.count += found;
    return route.fulfill({ response, body: body.split(TEST_BUILD_EDGE).join(PRODUCTION_EDGE) });
  });
  return rewrites;
}
