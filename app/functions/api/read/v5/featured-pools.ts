/**
 * POST /api/read/v5/featured-pools: the featured pools list, from the read
 * Worker through the fixed forwarder, each valid list kept at the edge: fresh
 * for 60 seconds, then served for up to 15 minutes while a background read
 * keeps a newer one (changed on purpose 2026-09-28, speed wave, item 7;
 * functions/_lib/featuredEdge.ts; featured-pools v1 §10.3, §10.6).
 *
 * Pages routes this path here, ahead of functions/api/[[path]].ts: a route
 * with only static segments is more specific than the catch-all. Every other
 * /api/read/v5/ path still goes to the catch-all, and so to the same Worker.
 * The beta gate in functions/_middleware.ts runs first, as for every /api
 * path (a public read: no cookie goes on), and the answer leaves through its
 * secured() with no-store and the API CSP, so no browser keeps it.
 *
 * The runtime is read-v5's own validator, the one the Worker runs; wrangler
 * bundles it from api-contracts/ at upload, and scripts/release.mjs hashes it
 * with the rest of what a deploy uploads.
 */
import { CONTRACT_VERSION, validateRequest, validateResponse } from '../../../../../api-contracts/read-v5/runtime.mjs'
import type { BridgeEnv } from '../../../_lib/bridge'
import { answerFeatured, type EdgeCache } from '../../../_lib/featuredEdge'

interface Context {
  request: Request
  env: BridgeEnv
  waitUntil?: (work: Promise<unknown>) => void
}

/** Cloudflare's default cache, where the runtime has one. */
function defaultCache(): EdgeCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches
  return storage?.default ?? null
}

export async function onRequest(context: Context): Promise<Response> {
  try {
    return await answerFeatured(context.request, context.env, {
      contract: { CONTRACT_VERSION, validateRequest, validateResponse },
      cache: defaultCache(),
      now: () => Date.now(),
      waitUntil: context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    })
  } catch {
    // Like the forwarder's own failure: JSON, and no contract header.
    return new Response(JSON.stringify({ error: 'bridge_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }
}
