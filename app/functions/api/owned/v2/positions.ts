/**
 * POST /api/owned/v2/positions: the positions one wallet created through
 * DominoSetupV1 and its held setup deposits, read from the chain's public RPC
 * by functions/_lib/walletPositions.ts. (v1, every position NFT the wallet
 * held, was retired on 2026-09-24: Positions lists only what Domino made.)
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
import { refuse, type AnswerCache } from '../../../_lib/owned'
import { answerWalletPositions } from '../../../_lib/walletPositions'

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
    return await answerWalletPositions(
      context.request,
      { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() },
      defaultCache(),
      context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    )
  } catch {
    return refuse('internal_error', 500)
  }
}
