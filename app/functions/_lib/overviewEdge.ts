/**
 * The stored overview at the edge: POST /api/read/v3/overview, answered by the read Worker through the fixed forwarder,
 * a settled answer kept for a few seconds (publicEdge.ts has the rules). Added 2026-10-01 (audit A7 b and A14, the
 * owner's OK on more edge caching; docs/API_READ_BRIDGE.md records the exception). pool-market is never kept.
 *
 * Why: Home, the ticker and Markets ask the same overview of the same pools for every visitor (the featured list's
 * pools, in the list's order), and every ask spends one of the visitor's thirty gateway reads a minute; the overview
 * itself costs the VM 54 to 74 ms. Kept at the edge, a visitor's ask gives its read back (the page's scheduler,
 * EDGE_CACHED), and a burst of visitors costs the VM one read.
 *
 * Kept: only an answer read-v3's runtime accepts for the question asked that is settled, every pool and token of it
 * collected (`ready`, not refreshing, no failure) and every pool's provider figures `available`. An answer still
 * collecting a pool, or one whose provider refused, is passed on and never kept: the page asks such an answer again
 * within seconds for the figures that are coming (lib/read/marketsProvider.ts, catch-up), and must meet the store's
 * newest each time.
 *
 * For how long: OVERVIEW_SECONDS as it is, then up to OVERVIEW_STALE_SECONDS in all while the request that found it
 * older refreshes it behind. Every kept answer says how old it is (X-Domino-Edge-Age), and the page dates its figures
 * by when the edge received it, so a kept figure is never younger on screen than it is. The overview's own times are
 * the store's (`generatedAt`), so nothing in it claims to be newer than it is either.
 *
 * The cache key names the contract version and the question exactly as asked (the pools in their order, the token,
 * the page), so only the identical question is ever answered from it.
 *
 * The runtime comes in as `contract`, so this module compiles for node --test without it; functions/api/read/v3/
 * overview.ts hands in the real one.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeRuntime } from './publicEdge'

/** What this route needs from api-contracts/read-v3/runtime.mjs. */
export interface OverviewContract {
  CONTRACT_VERSION: string
  validateRequest(route: 'overview', value: unknown): boolean
  validateResponse(route: 'overview', value: unknown): boolean
  matchesRequest(route: 'overview', request: never, response: never): boolean
}

export interface OverviewRuntime extends EdgeRuntime {
  contract: OverviewContract
}

export const OVERVIEW_PATH = '/api/read/v3/overview'
/** How long a kept overview is served as it is. */
export const OVERVIEW_SECONDS = 10
/** How long a kept overview is served at all, refreshed behind once OVERVIEW_SECONDS old. */
export const OVERVIEW_STALE_SECONDS = 30

interface Asked { token?: string | null; poolIds?: string[]; afterPoolId?: string | null; revision?: number | null; limit?: number }

/** The question, in one spelling: the token, the pools in their order, the page and the limit, lowercase where they are hex. */
export function overviewQuestion(asked: Asked): string {
  return JSON.stringify([
    asked.token?.toLowerCase() ?? null,
    (asked.poolIds ?? []).map((poolId) => poolId.toLowerCase()),
    asked.afterPoolId?.toLowerCase() ?? null,
    asked.revision ?? null,
    asked.limit ?? null,
  ])
}

/** The synthetic GET names the validated app origin, the contract version and the question. */
export const overviewKey = (version: string, asked: Asked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v3/cache/${encodeURIComponent(version)}/overview/${encodeURIComponent(overviewQuestion(asked))}`

interface Acquisition { status?: unknown; refreshing?: unknown; reason?: unknown }
interface Entry { value?: { market?: { market?: { status?: unknown } } } | null; acquisition?: Acquisition }

const settled = (acquisition: Acquisition | undefined) => acquisition?.status === 'ready' && acquisition.refreshing === false && acquisition.reason === null

/** Whether an overview answer is settled enough to keep (see the header). */
export function settledOverview(text: string): boolean {
  try {
    const data = JSON.parse(text) as { pools?: Entry[]; tokens?: Entry[] }
    const pools = data.pools ?? []
    const tokens = data.tokens ?? []
    if (!Array.isArray(pools) || !Array.isArray(tokens)) return false
    return pools.every((pool) => settled(pool.acquisition) && pool.value != null && pool.value.market?.market?.status === 'available')
      && tokens.every((token) => settled(token.acquisition) && token.value != null)
  } catch {
    return false
  }
}

export function answerOverview(request: Request, env: BridgeEnv, rt: OverviewRuntime): Promise<Response> {
  const { contract } = rt
  const answers = (body: unknown, text: string) => {
    try {
      const data = JSON.parse(text)
      return contract.validateResponse('overview', data) && contract.matchesRequest('overview', body as never, data as never)
    } catch {
      return false
    }
  }
  return answerFromEdge(request, env, rt, {
    path: OVERVIEW_PATH,
    version: contract.CONTRACT_VERSION,
    keyOf: (body, origin) => (contract.validateRequest('overview', body) ? overviewKey(contract.CONTRACT_VERSION, body as Asked, origin) : null),
    answers,
    keep: settledOverview,
    freshSeconds: OVERVIEW_SECONDS,
    staleSeconds: OVERVIEW_STALE_SECONDS,
  })
}
