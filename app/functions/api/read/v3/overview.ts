/**
 * POST /api/read/v3/overview: the stored overview of a list of pools or of a token's pools, from the read Worker through
 * the fixed forwarder, a settled answer kept at the edge for a few seconds (functions/_lib/overviewEdge.ts). Added
 * 2026-10-01 (audit A7 b and A14, the owner's OK on more edge caching).
 *
 * Pages routes this path here, ahead of functions/api/[[path]].ts: a route with only static segments is more specific
 * than the catch-all. Every other /api/read/v3/ path still goes to the catch-all, and so to the same Worker. The beta
 * gate in functions/_middleware.ts runs first, as for every /api path (a public read: no cookie goes on), and the
 * answer leaves through its secured() with no-store and the API CSP, so no browser keeps it.
 *
 * The runtime is read-v3's own validator, the one the Worker runs; wrangler bundles it from api-contracts/ at upload,
 * and scripts/release.mjs hashes it with the rest of what a deploy uploads.
 */
import { CONTRACT_VERSION, matchesRequest, validateRequest, validateResponse } from '../../../../../api-contracts/read-v3/runtime.mjs'
import type { BridgeEnv } from '../../../_lib/bridge'
import { answerOverview } from '../../../_lib/overviewEdge'
import type { EdgeCache } from '../../../_lib/publicEdge'

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
    return await answerOverview(context.request, context.env, {
      contract: { CONTRACT_VERSION, validateRequest, validateResponse, matchesRequest },
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
