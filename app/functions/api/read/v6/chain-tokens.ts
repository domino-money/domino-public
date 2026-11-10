/**
 * POST /api/read/v6/chain-tokens: the tokens Domino knows on Base and Arbitrum One matching a query, each answer kept at the edge for a few seconds (functions/_lib/chainEdge.ts has the rules), from the read Worker through the fixed
 * forwarder. Added 2026-11-07 (edge hardening, after rugged97's attack test of the open site: it reached the VM on every
 * request).
 *
 * Pages routes this path here, ahead of functions/api/[[path]].ts: a route with only static segments is more specific
 * than the catch-all. Every other /api/read/v6/ path (the wallet's reads: portfolio, activity, chain-balances,
 * position-fees) still goes to the catch-all, and so to the same Worker, never kept. The beta gate in
 * functions/_middleware.ts runs first, as for every /api path (a public read: no cookie goes on), and the answer leaves
 * through its secured() with no-store and the API CSP, so no browser keeps it.
 *
 * The runtime is read-v6's own validator, the one the Worker runs; wrangler bundles it from api-contracts/ at upload,
 * and scripts/release.mjs hashes it with the rest of what a deploy uploads.
 */
import { CONTRACT_VERSION, CONTRACT_VERSIONS, validateExchange, validateRequest, validateResponse } from '../../../../../api-contracts/read-v6/runtime.mjs'
import type { BridgeEnv } from '../../../_lib/bridge'
import { answerChainTokens } from '../../../_lib/chainEdge'
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
    return await answerChainTokens(context.request, context.env, {
      contract: { CONTRACT_VERSION, CONTRACT_VERSIONS, validateRequest, validateResponse, validateExchange },
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
