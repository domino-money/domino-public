/**
 * GET /api/read/dex2/token-pairs/<token>, /api/read/dex2/tokens/<token>[,<token>…] and
 * /api/read/dex2/token-pairs/<base|arbitrum>/<token>: the asks of /api/read/dex/, answered as a 200 whatever the provider
 * does, saying each token's own state: its pairs with the time this edge retrieved them, none, or missing with the reason
 * and a retry hint (2026-10-14, incident of 2026-10-13, package D1; functions/_lib/dexEdge.ts answerDex2). One slow or
 * refused token no longer costs the others, and a token with no price yet is a state of the answer, not a failed
 * request. Only a visitor past its own allowance hears a 429, with the wait.
 *
 * A path of its own because the shape is another: a tab opened before the deploy keeps asking /api/read/dex/, which keeps
 * its list and its 502 (functions/api/read/dex/[[path]].ts). Both read the same kept entries, share the reads on their
 * way and draw on the same visitor's allowance.
 *
 * Pages routes /api/read/dex2/* here, ahead of functions/api/[[path]].ts, as it does /api/read/dex/*: no read family
 * owns the prefix (functions/_lib/bridge.ts), so it never reaches a Worker, and this path never calls Domino's node. The
 * beta gate in functions/_middleware.ts runs first, as for every /api path, and the answer leaves through its secured()
 * with no-store and the API CSP.
 */
import { answerDex2 } from '../../../_lib/dexEdge'
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
    return await answerDex2(context.request, {
      cache: defaultCache(),
      now: () => Date.now(),
      waitUntil: context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    })
  } catch {
    // Only a fault of this Function's own comes here: an ask the route answers is a 200 whatever the provider does.
    return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }
}
