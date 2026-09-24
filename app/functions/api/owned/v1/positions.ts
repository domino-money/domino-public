/**
 * POST /api/owned/v1/positions: the position NFTs and held setup deposits of
 * one wallet, read from the chain's public RPC by functions/_lib/owned.ts.
 *
 * Pages routes this path here and not to functions/api/[[path]].ts: a route
 * with only static segments is more specific than the catch-all, and Pages
 * matches the most specific route first. The beta gate in
 * functions/_middleware.ts runs before it, like before every /api path, so a
 * browser without the access cookie gets the gate's 401 and never reaches
 * this code; the answer leaves through the gate's secured() with no-store and
 * the API CSP. Nothing here is forwarded to a bridge Worker, and nothing
 * needs a binding or a secret.
 */
import { answerOwned, refuse, type AnswerCache } from '../../../_lib/owned'

interface Context {
  request: Request
  waitUntil?: (work: Promise<unknown>) => void
}

/** Cloudflare's default cache, where the runtime has one. */
function defaultCache(): AnswerCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: AnswerCache } }).caches
  return storage?.default ?? null
}

export async function onRequest(context: Context): Promise<Response> {
  try {
    return await answerOwned(
      context.request,
      { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() },
      defaultCache(),
      context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    )
  } catch {
    return refuse('internal_error', 500)
  }
}
