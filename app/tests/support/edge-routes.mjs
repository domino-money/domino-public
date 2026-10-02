/**
 * Domino's own chain routes as the test suites answer them (RPC-SPEC Phase 0, §2.9): the six same-origin POSTs of
 * src/lib/edge/chainRoutes.ts, answered by the routes' own handler (functions/_lib/chainRoutes.ts answerChainRoute),
 * whose node is a test's fake chain (tests/support/fake-node.mjs) under a test token of the secret's shape
 * (https://rpc.domino.money/test-token-0123456789abcdef/). Phase 0 wrote the handlers here over the chain code; the edge
 * unit made them the real ones. Nothing a suite imports from here changed.
 *
 *   edgeRoutes(deps, options)          (request: Request) => Promise<Response | undefined>; undefined: not a chain route
 *   edgeFetch(deps, options)           (path, init) => Promise<Response>: chainRoutes.ts RouteOptions.fetch in unit tests
 *   routeEdge(context, deps, options)  a Playwright context's chain routes (its pages and its fees worker)
 *
 * deps: the chain code's runtime over the fake chain, { fetch(url, init), sleep?(ms), now?() } (functions/_lib/owned.ts
 * OwnedDeps); every call the chain code makes names the chain's RPC URL, which the fake answers.
 * options: { simulator?: () => ((params) => unknown) | null    an eth_simulateV1 answerer; null: the route is off (404)
 *            source?: () => 'up' | 'off'                        off: no node secret; every route answers 503 source_unavailable
 *                                                               (the simulate route too while its flag is on)
 *            log?: string[]                                     each route's path, as it is asked }
 *
 * Each edgeRoutes is one isolate of its own (chainRouteMemory: its visitors, its reads in flight, its view of the
 * node) with its own edge cache (a Map), so one suite's node rests and kept answers never reach another's.
 */
import { createRequire } from 'node:module';
import { fakeNode } from './fake-node.mjs';

const require = createRequire(import.meta.url);
const chainRoutes = require('../../.test-build/app/functions/_lib/chainRoutes.js');

/** The six routes' paths, exactly (src/lib/edge/chainRoutes.ts ROUTES). */
export const EDGE_PATH = /^\/api\/(?:owned\/v2\/positions|fees\/(?:v1\/state|v2\/ledger)|automation\/v1\/(?:state|record)|chain\/v1\/simulate)$/;
/** Each path's route (functions/api/**: one line each over answerChainRoute). */
const ROUTE_OF = Object.freeze({
  '/api/owned/v2/positions': 'owned',
  '/api/fees/v1/state': 'state',
  '/api/fees/v2/ledger': 'ledger',
  '/api/automation/v1/state': 'automation',
  '/api/automation/v1/record': 'record',
  '/api/chain/v1/simulate': 'simulate',
});
/** The test deployment's node secret: the node's exact host and a token of its shape, no real token. */
const LOCAL_RPC_URL = 'https://rpc.domino.money/test-token-0123456789abcdef/';
const ORIGIN = 'https://edge.test';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/** A Map in place of the Workers cache (functions/_lib/owned.ts AnswerCache), one per edgeRoutes. */
function memoryCache() {
  const kept = new Map();
  return {
    async match(request) {
      const hit = kept.get(request.url);
      return hit ? new Response(hit.text, { headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      kept.set(request.url, { text: await response.text(), headers: [...response.headers] });
    },
  };
}

/** The six routes over `deps`' chain: a handler of same-origin Requests (undefined for any other path). */
export function edgeRoutes(deps, { simulator = null, source = null, log = null } = {}) {
  // The routes' clock is the chain's (deps.now), and every wait the routes take moves it on by at least that long: over a
  // chain whose sleep returns at once (the unit suites'), the node's bucket still refills and its rests still end, as on
  // the deployment, instead of every POST past the burst being refused.
  const clock = deps.now ?? (() => Date.now());
  const wait = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let skew = 0;
  const runtime = {
    upstream: fakeNode(deps, { simulator: () => simulator?.() ?? null }),
    cache: memoryCache(),
    now: () => clock() + skew,
    sleep: async (ms) => {
      const before = clock();
      await wait(ms);
      skew += Math.max(0, ms - (clock() - before));
    },
    memory: chainRoutes.chainRouteMemory(),
    // The routes' log lines are the deployment's; the suites read what they need from the answers.
    log: () => {},
  };
  return async (request) => {
    const url = new URL(request.url);
    if (!EDGE_PATH.test(url.pathname)) return undefined;
    log?.push(url.pathname);
    // `source: 'off'` is a deployment without the node's secret; the simulation's flag is a setting of its own.
    const env = { ...(source?.() === 'off' ? {} : { LOCAL_RPC_URL }), ...(simulator?.() ? { LOCAL_RPC_SIMULATE: 'true' } : {}) };
    return chainRoutes.answerChainRoute(ROUTE_OF[url.pathname], { request, env }, runtime);
  };
}

/** chainRoutes.ts RouteOptions.fetch over edgeRoutes, for unit tests: each call a same-origin Request of ORIGIN. */
export function edgeFetch(deps, options) {
  const routes = edgeRoutes(deps, options);
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-origin');
    const request = new Request(new URL(path, ORIGIN), { method: init.method ?? 'GET', headers, body: init.body, signal: init.signal });
    return (await routes(request)) ?? json({ error: 'not_found' }, 404);
  };
}

/** A Playwright context's six chain routes (its pages' and its fees worker's), answered by edgeRoutes. */
export async function routeEdge(context, deps, options = {}) {
  const routes = edgeRoutes(deps, options);
  await context.route((url) => EDGE_PATH.test(url.pathname), async (route) => {
    const asked = route.request();
    const all = await asked.allHeaders();
    const headers = Object.fromEntries(Object.entries(all).filter(([name]) => name === 'content-type' || name === 'origin' || name === 'sec-fetch-site'));
    const response = await routes(new Request(asked.url(), { method: asked.method(), headers, body: asked.method() === 'POST' ? (asked.postData() ?? '') : undefined }));
    if (!response) return route.fallback();
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
}
