/**
 * The Pages Function for /uniswap-v3/* : rugged97's Uniswap v3 services for the second chain's section, through this
 * site's edge (2026-10-01, the chain2 workstream, audit item G9). edge.ts holds the rules; this module hands it his
 * runtimes and pins, vendored byte for byte at 7d190690 under ./contracts (inside functions/, so the release digest
 * covers them with the rest of functions/ and nothing joins scripts/release.mjs BUNDLED), and Cloudflare's default cache.
 *
 * Its handler is not named onRequest, so Pages does not route to it yet: part B adds the one-line route file
 * functions/uniswap-v3/[[path]].ts (`export { onUniswapV3Request as onRequest } from '../_lib/uniswap-v3/handler'`)
 * together with the route list tests/owned.test.mjs holds, the middleware's wiring for this prefix (an API: no-store
 * and the API CSP, every cookie removed, an empty segment refused) and the ELYSIUM_BRIDGE binding
 * (the chain2 workstream's part-B plan). Until that binding exists, every path answers 404 {"error":"not_enabled"}.
 */
import * as read from './contracts/uniswap-v3-read-v1/runtime.mjs'
import * as actions from './contracts/uniswap-v3-actions-v1/runtime.mjs'
import readPin from './contracts/uniswap-v3-read-v1/pin.json'
import actionsPin from './contracts/uniswap-v3-actions-v1/pin.json'
import type { EdgeCache } from '../publicEdge'
import { answerUniswapV3, type UniswapV3Env, type V3Contract } from './edge'

interface Context {
  request: Request
  env: UniswapV3Env
  waitUntil?: (work: Promise<unknown>) => void
}

/** Cloudflare's default cache, where the runtime has one. */
function defaultCache(): EdgeCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches
  return storage?.default ?? null
}

export const CONTRACTS: { read: V3Contract; actions: V3Contract } = {
  read: { CONTRACT_VERSION: read.CONTRACT_VERSION, ROUTES: read.ROUTES, validateRequest: read.validateRequest as V3Contract['validateRequest'], validateResponse: read.validateResponse as V3Contract['validateResponse'], pin: readPin },
  actions: { CONTRACT_VERSION: actions.CONTRACT_VERSION, ROUTES: actions.ROUTES, validateRequest: actions.validateRequest as V3Contract['validateRequest'], validateResponse: actions.validateResponse as V3Contract['validateResponse'], pin: actionsPin },
}

export async function onUniswapV3Request(context: Context): Promise<Response> {
  try {
    return await answerUniswapV3(context.request, context.env, {
      contracts: CONTRACTS,
      cache: defaultCache(),
      now: () => Date.now(),
      waitUntil: context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
    })
  } catch {
    return new Response(JSON.stringify({ error: 'bridge_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }
}
