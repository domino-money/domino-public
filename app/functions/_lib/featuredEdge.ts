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
 * on it already), `none` included; the key names the contract version. Since
 * 2026-09-28 (featured-policy v2) that header is rc.1 or rc.2 while the VM
 * moves to rc.2, and a kept list is served in the version it was answered in;
 * the key names the version this build speaks (rc.2), so no entry an rc.1
 * build kept is ever read.
 *
 * For how long: 60 seconds as it is (LIST_SECONDS), then, changed on purpose
 * 2026-09-28 (speed wave, item 7, the owner's OK), up to 15 minutes
 * (STALE_SECONDS) retained while the request that found it older goes on
 * to the Worker. That visitor waits at most REFRESH_WAIT_MS for this same
 * refresh, receiving its newer validated answer without another polling cycle;
 * a slow or failed refresh leaves the dated cached list in place. Others hit
 * the cache while this single refresh is in flight. A visitor who came
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
 *
 * Changed 2026-10-01 (audit A6, the owner's OK): a kept list younger than
 * WAIT_AFTER_SECONDS (5 minutes) is served at once once it is past its 60
 * seconds, while the request that found it refreshes it behind; only an older
 * one waits up to REFRESH_WAIT_MS for that refresh, as #280 made every stale
 * one wait. The list is chosen once a day: a visitor who came after a quiet
 * minute waited 0.55 to 1.0 s for nothing (simulated on the compiled Function).
 *
 * Added 2026-10-01 (audit B1): evidence of when and why the list loses slots
 * during the day, without asking anyone. Whenever a valid answer passes with a
 * listId or revision this isolate has not seen, one JSON line goes to the
 * Function's log (`wrangler pages deployment tail`): the list, its status, how
 * many pools it names against the size its rules ask for, every withdrawn pool
 * with its reason and time, and when it was served. Nothing else is logged, and
 * nothing about a visitor.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeCache, type EdgeRuntime } from './publicEdge'
import { ROBINHOOD_ID } from '../../src/config/chainIdentity'

export type { EdgeCache } from './publicEdge'

/** What this route needs from api-contracts/read-v5/runtime.mjs. */
export interface FeaturedContract {
  CONTRACT_VERSION: string
  /** Every version an answer may carry: rc.1 and rc.2 during the transition. */
  CONTRACT_VERSIONS: readonly string[]
  validateRequest(route: 'featured-pools', value: unknown): boolean
  validateResponse(route: 'featured-pools', value: unknown): boolean
}

export interface FeaturedRuntime extends EdgeRuntime {
  contract: FeaturedContract
  cache: EdgeCache | null
  /** Where the list's evidence line goes (B1): console.log unless a test gives its own. */
  log?: (line: string) => void
  /** The last list this isolate logged, `listId#revision`: this module's own unless a test gives one. */
  logged?: { last: string | null }
}

export const FEATURED_PATH = '/api/read/v5/featured-pools'
/** How long a kept list is served as it is (§10.6). */
export const LIST_SECONDS = 60
/** How long a kept list is served at all, refreshed in the background once LIST_SECONDS old (speed wave, item 7). */
export const STALE_SECONDS = 15 * 60
/** Below the browser's 1.5 s featured deadline; does not add a gateway read. */
export const REFRESH_WAIT_MS = 1_000
/** A kept list at least this old waits REFRESH_WAIT_MS for its refresh; a younger one is served at once (A6, 2026-10-01). */
export const WAIT_AFTER_SECONDS = 5 * 60

/**
 * The synthetic GET is scoped to the validated app origin: preview never reads or replaces production entries.
 * Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G10): and to the chain the list is of
 * (Robinhood Chain's: read-v5's featured pools are its), so no other chain's list can ever be served from it. Entries
 * kept under the key before are never read again and lapse within their 15 minutes.
 */
export const cacheKey = (version: string, origin = APP_ORIGIN, chainId: number = ROBINHOOD_ID) => `${origin}/api/read/v5/cache/${chainId}/${encodeURIComponent(version)}/featured-pools`

const LOGGED: { last: string | null } = { last: null }

interface ListShape {
  status?: unknown
  listId?: unknown
  revision?: unknown
  servedAt?: unknown
  rules?: { size?: unknown } | null
  pools?: unknown[]
  withdrawn?: Array<{ poolId?: unknown; reason?: unknown; at?: unknown }>
}

/**
 * The evidence line for a valid answer (B1), or null when this isolate has logged the same listId and revision
 * already. Pool ids are cut to their first eight digits: enough to tell them apart in a tail.
 */
export function featuredEvidence(text: string, version: string, logged: { last: string | null }): string | null {
  let list: ListShape
  try {
    list = JSON.parse(text) as ListShape
  } catch {
    return null
  }
  const id = `${String(list.listId ?? null)}#${String(list.revision ?? null)}`
  if (logged.last === id) return null
  logged.last = id
  const short = (poolId: unknown) => (typeof poolId === 'string' ? poolId.slice(0, 10) : null)
  return JSON.stringify({
    event: 'featured_list',
    contract: version,
    listId: list.listId ?? null,
    revision: list.revision ?? null,
    status: list.status ?? null,
    pools: Array.isArray(list.pools) ? list.pools.length : null,
    size: list.rules && typeof list.rules === 'object' ? (list.rules.size ?? null) : null,
    withdrawn: Array.isArray(list.withdrawn) ? list.withdrawn.map((entry) => [short(entry.poolId), entry.reason ?? null, entry.at ?? null]) : [],
    servedAt: list.servedAt ?? null,
  })
}

export function answerFeatured(request: Request, env: BridgeEnv, rt: FeaturedRuntime): Promise<Response> {
  const { contract } = rt
  const valid = (text: string) => {
    try {
      return contract.validateResponse('featured-pools', JSON.parse(text))
    } catch {
      return false
    }
  }
  const log = rt.log ?? ((line: string) => console.log(line))
  return answerFromEdge(request, env, rt, {
    path: FEATURED_PATH,
    version: contract.CONTRACT_VERSION,
    versions: contract.CONTRACT_VERSIONS,
    keyOf: (body, origin) => (contract.validateRequest('featured-pools', body) ? cacheKey(contract.CONTRACT_VERSION, origin) : null),
    answers: (_body, text) => valid(text),
    freshSeconds: LIST_SECONDS,
    staleSeconds: STALE_SECONDS,
    refreshWaitMs: REFRESH_WAIT_MS,
    waitAfterSeconds: WAIT_AFTER_SECONDS,
    onAnswer: (text, version) => {
      const line = featuredEvidence(text, version, rt.logged ?? LOGGED)
      if (line !== null) log(line)
    },
  })
}
