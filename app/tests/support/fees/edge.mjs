/**
 * The fees reads through Domino's own chain routes, for the unit suites (RPC-SPEC, UNIT fees, 2026-10-01): the routes
 * answered from a test's fake or recorded chain by tests/support/edge-routes.mjs (the routes' own chain code over that
 * chain), and the page's client (src/lib/edge/chainRoutes.ts) pointed at them.
 *
 *   withEdge(deps, work, opts)   runs `work` with the global fetch answering this site's chain routes from `deps` (the way
 *                                in for client.ts chainState and chainLedger, which take no fetch of their own); `sent` lists
 *                                each request's path and body
 *   chainDeps(chain)             the chain code's runtime over a chain with a fetch(url, init) of its RPC
 *
 * Not a suite of its own.
 */
import { edgeFetch } from '../edge-routes.mjs';

/** functions/_lib/owned.ts OwnedDeps over `chain` (a fake or recorded chain: its fetch answers the chain's RPC URL). */
export const chainDeps = (chain) => ({ fetch: (url, init) => chain.fetch(url, init), sleep: async () => {}, now: () => Date.now() });

/** Runs `work` while the global fetch answers this site's chain routes from `deps`; nothing else may be fetched. */
export async function withEdge(deps, work, options = {}) {
  const fetch = edgeFetch(deps, options);
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (!path.startsWith('/api/')) throw new TypeError(`not a route of this site: ${path}`);
    sent.push({ path, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, init });
    return fetch(path, init);
  };
  try {
    return { result: await work(), sent };
  } finally {
    globalThis.fetch = original;
  }
}
