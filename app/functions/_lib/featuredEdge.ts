/**
 * The featured pools list at the edge (featured-pools v1 §10.3, §10.6):
 * POST /api/read/v5/featured-pools, answered by the read Worker through the
 * fixed forwarder, with its valid answers kept at the edge (publicEdge.ts has
 * the rules every public read kept there follows).
 *
 * Why a cache here, against docs/API_READ_BRIDGE.md's "no CDN or BFF caching
 * initially" (an exception the spec records): the list changes once a day and
 * is the same for every visitor, the Home asks it before anything else, and
 * every read costs the VM a gateway admission, a reader health round trip and
 * a place in the stored lane, out of a per-IP budget all read versions share.
 *
 * What is kept: every 200 with read-v5's contract header whose body passes
 * read-v5's runtime (api-contracts/read-v5/runtime.mjs, which the Worker ran
 * on it already), `none` included; the key names the contract version.
 *
 * For how long: 60 seconds as it is (LIST_SECONDS), then, changed on purpose
 * 2026-09-28 (speed wave, item 7, the owner's OK), up to 15 minutes
 * (STALE_SECONDS) served at once while the request that found it older goes on
 * to the Worker in the background to keep a newer one. A visitor who came
 * after the site was quiet for more than a minute used to wait for the VM's
 * own 0.55 to 0.78 s (Home's figures at 1.2 s, measured; 0.5 s from the edge).
 * A route switched off (READ_V5_BRIDGE_ENABLED=false) is seen by that
 * background read, whose 404 takes the entry out: the next visitor gets the
 * Worker's own refusal, so a rollback still reaches open pages at their next
 * read, within about a minute where the site is visited, and within 15 minutes
 * at the most. The written promise "switching the list off reaches everyone in
 * 60 s" changes accordingly.
 *
 * Who is answered from it: only a request the read Worker itself would have
 * answered with that list (a POST of `{}` as JSON, the browser checks the
 * Worker makes). Any other request is forwarded, and the Worker's own refusal
 * is the answer, so the cache never widens what the route accepts. A kept
 * answer carries no X-Domino-Request-Id (no Worker handled that request) and
 * says `X-Domino-Edge-Cache: hit`.
 *
 * The runtime comes in as `contract`, so this module compiles for node --test
 * without it (tsconfig.test.json); functions/api/read/v5/featured-pools.ts
 * hands in the real one.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeCache, type EdgeRuntime } from './publicEdge'

export type { EdgeCache } from './publicEdge'

/** What this route needs from api-contracts/read-v5/runtime.mjs. */
export interface FeaturedContract {
  CONTRACT_VERSION: string
  validateRequest(route: 'featured-pools', value: unknown): boolean
  validateResponse(route: 'featured-pools', value: unknown): boolean
}

export interface FeaturedRuntime extends EdgeRuntime {
  contract: FeaturedContract
  cache: EdgeCache | null
}

export const FEATURED_PATH = '/api/read/v5/featured-pools'
/** How long a kept list is served as it is (§10.6). */
export const LIST_SECONDS = 60
/** How long a kept list is served at all, refreshed in the background once LIST_SECONDS old (speed wave, item 7). */
export const STALE_SECONDS = 15 * 60

/** The synthetic GET the list is kept under, on the app's own origin. */
export const cacheKey = (version: string) => `${APP_ORIGIN}/api/read/v5/cache/${encodeURIComponent(version)}/featured-pools`

export function answerFeatured(request: Request, env: BridgeEnv, rt: FeaturedRuntime): Promise<Response> {
  const { contract } = rt
  const valid = (text: string) => {
    try {
      return contract.validateResponse('featured-pools', JSON.parse(text))
    } catch {
      return false
    }
  }
  return answerFromEdge(request, env, rt, {
    path: FEATURED_PATH,
    version: contract.CONTRACT_VERSION,
    keyOf: (body) => (contract.validateRequest('featured-pools', body) ? cacheKey(contract.CONTRACT_VERSION) : null),
    answers: (_body, text) => valid(text),
    freshSeconds: LIST_SECONDS,
    staleSeconds: STALE_SECONDS,
  })
}
