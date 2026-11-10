/**
 * The stored overview at the edge: POST /api/read/v3/overview, answered by the read Worker through the fixed forwarder,
 * an answer kept for a few seconds, then served stale behind (publicEdge.ts has the rules). Added 2026-10-01 (audit A7 b and A14, the
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
 * newest each time. (Changed on purpose 2026-10-30, below: such an answer is kept too, for a few seconds.)
 *
 * For how long: OVERVIEW_SECONDS as it is, then up to OVERVIEW_STALE_SECONDS in all while the request that found it
 * older refreshes it behind. Every kept answer says how old it is (X-Domino-Edge-Age), and the page dates its figures
 * by when the edge received it, so a kept figure is never younger on screen than it is. The overview's own times are
 * the store's (`generatedAt`), so nothing in it claims to be newer than it is either.
 *
 * Changed on purpose 2026-10-30 (launch capacity study, item 4: at launch load the provider falls behind, almost no
 * answer is settled, so the edge kept nothing, every Home load and catch-up ask reached the VM's four stored slots, and
 * a VM or tunnel outage past 30 s left first-time visitors with no figures at all):
 *   - every answer worth keeping is kept (usefulOverview): a settled one, as before, for OVERVIEW_SECONDS as it is; one
 *     still settling (a pool or token still being collected, refreshing, failed, or without its provider figures) for
 *     OVERVIEW_SETTLING_SECONDS, so a burst of identical loads meets the edge, not the VM, and each page's catch-up asks
 *     find it stale and wait briefly for the figures coming. An answer with nothing to show (pools or tokens listed,
 *     none with a value yet, or pools asked by id and none listed) is passed on and never kept: it would only hold back
 *     the figures being collected, and it never replaces a copy that has some, neither as a refresh nor, past
 *     OVERVIEW_STALE_SECONDS, for the visitor (publicEdge.ts: the kept copy stands in for it);
 *   - a kept answer is served at once while it refreshes behind, up to OVERVIEW_STALE_SECONDS (two minutes since the
 *     final review, below; it was 30 s). One at least OVERVIEW_WAIT_AFTER_SECONDS old (the old 30 s), and one still
 *     settling as soon as it is stale, waits up to OVERVIEW_REFRESH_WAIT_MS for that refresh, so a visitor after a quiet
 *     spell, or a catch-up ask, meets the newer answer whenever the VM gives it in time;
 *   - up to OVERVIEW_ERROR_SECONDS (fifteen minutes) it stands in for the VM's answer when that is a failure: a 408, a
 *     429, a 5xx, or none within OVERVIEW_ERROR_WAIT_MS (publicEdge.ts, `stale-if-error`);
 *   - after a failed read of a question the VM is let alone for REFRESH_GUARD_MS in the isolate while the kept copy is
 *     served (publicEdge.ts);
 *   - identical misses stay coalesced per isolate (publicEdge.ts, F7).
 * Unchanged: the key, the request checks, and that only a 200 read-v3's runtime accepts for the very question is kept.
 *
 * Changed on purpose 2026-10-30 (QA round 2, final review edge-1): the page dates every figure by X-Domino-Edge-Age, and an
 * APR estimate whose market age (the provider's own, plus that) is past the payload's maxStaleSeconds, 300 s, is expired
 * as it arrives (lib/read/aprEstimate.ts): the page puts a stand-in in its place, or none, and asks DEX Screener about
 * each token pair. Served at once for ten minutes, and past them after a second, a kept copy reached a page whose VM was
 * healthy but slower than a second with every APR already expired, for a minute. Now:
 *   - OVERVIEW_STALE_SECONDS is two minutes (it was ten): a copy served at once leaves room within those 300 s for the
 *     provider's own age and one page refresh (a minute) before the next answer replaces it;
 *   - past it, the request that asks the VM waits up to OVERVIEW_ERROR_WAIT_MS (5 s) before the kept copy stands in (it
 *     was OVERVIEW_REFRESH_WAIT_MS, a second), so a VM that is merely slow gives the current figures. A failure (a 408, a
 *     429, a 5xx, the forwarder's 503) still has the copy stand in as soon as it comes, and while a key is guarded the
 *     copy is served at once, as before.
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
/** How long a kept settled overview is served as it is. */
export const OVERVIEW_SECONDS = 10
/**
 * (2026-10-30) How long a kept overview still settling is served as it is. Below the page's first catch-up wait
 * (lib/read/marketsProvider.ts CATCH_UP_FLOOR_MS, 2.5 s; review of 2026-10-30, it was 5 s): a burst of identical loads
 * shares one copy, and each page's first catch-up already finds it stale, so the request that refreshes it waits up to
 * OVERVIEW_REFRESH_WAIT_MS for the figures coming rather than getting the same copy back and asking again 3.5 s later.
 */
export const OVERVIEW_SETTLING_SECONDS = 2
/**
 * How long a kept overview is served at once, refreshed behind once it is no longer fresh. Changed on purpose 2026-10-30
 * (launch item 4): ten minutes; it was 30 s. Changed on purpose 2026-10-30 (QA round 2, final review edge-1): two
 * minutes, so the APR of a copy served at once is still within the page's 300 s (the estimate's maxStaleSeconds,
 * lib/read/aprEstimate.ts) with the provider's own age and one page refresh added.
 */
export const OVERVIEW_STALE_SECONDS = 2 * 60
/** (2026-10-30) A kept overview at least this old waits OVERVIEW_REFRESH_WAIT_MS for its refresh; a younger one is served at once. */
export const OVERVIEW_WAIT_AFTER_SECONDS = 30
/** (2026-10-30) How long a kept overview stands in for a failure of the VM's (stale-if-error), in all. */
export const OVERVIEW_ERROR_SECONDS = 15 * 60
/**
 * (2026-10-30) The longest a request whose kept overview is stale waits for its refresh before the kept one is served;
 * no extra upstream request.
 */
export const OVERVIEW_REFRESH_WAIT_MS = 1_000
/**
 * (2026-10-30, QA round 2, final review edge-1) The longest a request whose kept overview is past OVERVIEW_STALE_SECONDS
 * waits for the VM before that overview stands in for it (publicEdge.ts `errorWaitMs`; no extra upstream request, and the
 * answer, when it comes, is kept behind). It was OVERVIEW_REFRESH_WAIT_MS, so a VM slower than a second had a copy of up
 * to fifteen minutes stand in, its APRs expired on arrival. A failure still has the copy stand in as soon as it comes.
 */
export const OVERVIEW_ERROR_WAIT_MS = 5_000

interface Asked { token?: string | null; poolIds?: string[]; afterPoolId?: string | null; revision?: number | null; limit?: number }

/** read-v3's overview `limit` when a request names none (its request schema's default). */
export const OVERVIEW_DEFAULT_LIMIT = 24

/**
 * The question, in one spelling: the token, the pools in their order, the page and the limit, lowercase where they are hex.
 *
 * Changed on purpose 2026-11-07 (edge hardening): spellings the producer answers alike are one question, so a visitor
 * cannot make each spelling of the app's own question one more read of the VM:
 *   - pools asked by id: the limit is no part of it. The producer lists exactly the pools asked, in their order, whatever
 *     the limit (backend/public_observations.py overview: it bounds a token's page only; the request's own rule already
 *     holds the list within it), and no screen sends one (lib/read/marketsProvider.ts,
 *     components/read/screens/PoolWorkspace.tsx and screens/PoolDetail.tsx ask `{ poolIds }` alone). Every answer served
 *     from the key is still checked against the very request (read-v3's matchesRequest, publicEdge.ts);
 *   - a token's pages: a limit left out is the schema's default, 24, the one limit the app sends
 *     (components/read/screens/StoredTokenExplorer.tsx).
 * Nothing else is joined. The revision stays part of it, so a request naming one the catalogue is not at (a refusal) never
 * leads a miss real visitors' requests would wait on.
 */
export function overviewQuestion(asked: Asked): string {
  const token = asked.token?.toLowerCase() ?? null
  return JSON.stringify([
    token,
    (asked.poolIds ?? []).map((poolId) => poolId.toLowerCase()),
    asked.afterPoolId?.toLowerCase() ?? null,
    asked.revision ?? null,
    token === null ? null : asked.limit ?? OVERVIEW_DEFAULT_LIMIT,
  ])
}

/** The synthetic GET names the validated app origin, the contract version and the question. */
export const overviewKey = (version: string, asked: Asked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v3/cache/${encodeURIComponent(version)}/overview/${encodeURIComponent(overviewQuestion(asked))}`

interface Acquisition { status?: unknown; refreshing?: unknown; reason?: unknown }
interface Entry { value?: { market?: { market?: { status?: unknown } } } | null; acquisition?: Acquisition }

const settled = (acquisition: Acquisition | undefined) => acquisition?.status === 'ready' && acquisition.refreshing === false && acquisition.reason === null

/** An overview answer's pools and tokens, and how many pools it was asked for by id, or null when it is not one. */
function entriesOf(text: string): { pools: Entry[]; tokens: Entry[]; requested: number } | null {
  try {
    const data = JSON.parse(text) as { pools?: Entry[]; tokens?: Entry[]; requestedPoolIds?: unknown }
    const pools = data.pools ?? []
    const tokens = data.tokens ?? []
    const requested = Array.isArray(data.requestedPoolIds) ? data.requestedPoolIds.length : 0
    return Array.isArray(pools) && Array.isArray(tokens) ? { pools, tokens, requested } : null
  } catch {
    return null
  }
}

const settledEntries = ({ pools, tokens }: { pools: Entry[]; tokens: Entry[] }) =>
  pools.every((pool) => settled(pool.acquisition) && pool.value != null && pool.value.market?.market?.status === 'available')
  && tokens.every((token) => settled(token.acquisition) && token.value != null)

/** Whether an overview answer is settled: every pool and token collected, and every pool's provider figures `available`. */
export function settledOverview(text: string): boolean {
  const entries = entriesOf(text)
  return entries !== null && settledEntries(entries)
}

/**
 * (2026-10-30) Whether an overview answer is worth keeping: settled (an empty page included, as before), or with at least
 * one pool or token that has a value. One that lists pools or tokens, none with a value yet, has nothing to show; so has
 * one asked for pools by id that lists none of them (review of 2026-10-30: it read as settled, and could replace a copy
 * with figures).
 */
export function usefulOverview(text: string): boolean {
  const entries = entriesOf(text)
  if (entries === null) return false
  if (entries.requested > 0 && entries.pools.length === 0) return false
  return settledEntries(entries) || entries.pools.some((pool) => pool.value != null) || entries.tokens.some((token) => token.value != null)
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
    keep: usefulOverview,
    settling: (text) => !settledOverview(text),
    settlingSeconds: OVERVIEW_SETTLING_SECONDS,
    freshSeconds: OVERVIEW_SECONDS,
    staleSeconds: OVERVIEW_STALE_SECONDS,
    errorSeconds: OVERVIEW_ERROR_SECONDS,
    refreshWaitMs: OVERVIEW_REFRESH_WAIT_MS,
    errorWaitMs: OVERVIEW_ERROR_WAIT_MS,
    waitAfterSeconds: OVERVIEW_WAIT_AFTER_SECONDS,
  })
}
