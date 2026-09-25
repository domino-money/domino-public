/**
 * POST /api/automation/v1/state: for a few position NFTs, whether each is a
 * plain position, Auto-compound or Domino-compound, and paused or active,
 * read from the chain's public RPC by functions/_lib/automation.ts
 * (2026-09-24, the owner's three features on Positions).
 *
 * Pages routes this path here and not to functions/api/[[path]].ts: a route
 * with only static segments is more specific than the catch-all. The beta
 * gate in functions/_middleware.ts runs before it, like before every /api
 * path, and the answer leaves through the gate's secured() with no-store and
 * the API CSP. Nothing here needs a binding or a secret.
 */
import { refuse, type AnswerCache } from '../../../_lib/owned'
import { answerAutomation } from '../../../_lib/automation'

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
    return await answerAutomation(
      context.request,
      { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() },
      defaultCache(),
      context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    )
  } catch {
    return refuse('internal_error', 500)
  }
}
