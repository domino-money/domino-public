/**
 * POST /api/fees/v1/state: up to eight position NFTs read at one block from
 * the chain's public RPC by functions/_lib/fees.ts (range, liquidity, price,
 * fee growth and the exact unclaimed fees).
 *
 * Pages routes this path here, ahead of functions/api/[[path]].ts: a route
 * with only static segments is more specific than the catch-all. The beta
 * gate in functions/_middleware.ts runs first, as for every /api path, and the
 * answer leaves through its secured() with no-store and the API CSP. Nothing
 * here is forwarded to a bridge Worker, and nothing needs a binding or a secret.
 */
import { answerState, refusal, runtimeOf } from '../../../_lib/fees'

interface Context {
  request: Request
  waitUntil?: (work: Promise<unknown>) => void
}

export async function onRequest(context: Context): Promise<Response> {
  try {
    return await answerState(context.request, runtimeOf(context))
  } catch {
    return refusal('rpc_unavailable', 502)
  }
}
