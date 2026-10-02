/**
 * GET /api/read/dex/token-pairs/<token> and /api/read/dex/tokens/<token>[,<token>…]: DEX Screener's public answers
 * about Robinhood Chain tokens, asked by this edge one token at a time and kept there, so the visitor's address and
 * a wallet's set of tokens never reach the provider (audit I3, 2026-10-01; functions/_lib/dexEdge.ts).
 *
 * Pages routes /api/read/dex/* here, ahead of functions/api/[[path]].ts: more static segments are more specific than
 * the catch-all, and no read family owns /api/read/dex/ (functions/_lib/bridge.ts). The beta gate in
 * functions/_middleware.ts runs first, as for every /api path (a public read: no cookie goes on), and the answer leaves
 * through its secured() with no-store and the API CSP.
 */
import { answerDex } from '../../../_lib/dexEdge'
import type { EdgeCache } from '../../../_lib/publicEdge'

interface Context {
  request: Request
  waitUntil?: (work: Promise<unknown>) => void
}

/** Cloudflare's default cache, where the runtime has one. */
function defaultCache(): EdgeCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches
  return storage?.default ?? null
}

export async function onRequest(context: Context): Promise<Response> {
  try {
    return await answerDex(context.request, {
      cache: defaultCache(),
      now: () => Date.now(),
      waitUntil: context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    })
  } catch {
    return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }
}
