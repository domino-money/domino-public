/**
 * The daily featured pools list (featured-pools v1 §11, read-v5): how the app
 * reads it, what it believes of it, and which list the page shows.
 *
 * The list is one POST, /api/read/v5/featured-pools with the body `{}`, asked
 * first in the app's one scheduled queue (`priority: 'first'`, on the stored
 * lane, scheduler.ts) and given 1.5 s. It never asks the v5 capabilities
 * first: the POST's own answer says whether the route is on, and a route
 * that is off answers route_not_available. The answer must pass the
 * contract's runtime (api-contracts/read-v5/runtime.mjs, the Worker's own),
 * and then the app's own checks, pool by pool: no hooks, a fixed fee,
 * `hookless_fixed_fee`, no token that reads as a main token on another
 * contract (config/mainTokens.ts), no symbol with the text of a web address
 * (the selector's own rule), and nothing in FEATURED_DENY. A pool that fails
 * them is left out; the rest of the list stands.
 *
 * Which list, always by the server's clock (never this browser's):
 *
 *   current or repaired, servedAt <= validUntil        the server's, "Top pools · last 24h" (`server`)
 *   carried_over or manual, or stale up to 72 h        the server's, the neutral title (`server_neutral`)
 *   none, route off, older than 72 h, invalid, any     the embedded list, the neutral title (`bundled`)
 *   other failure, the 1.5 s passed, nothing kept
 *
 * The Home is never empty: the embedded list (config/selectedPools.ts with
 * its labels) stands in whenever the server's cannot, and paints the rows
 * while the first answer is on its way. Nothing is kept in the browser's
 * storage.
 *
 * Read again with the markets' 60 s refresh, a new answer changes the list on
 * screen only this way: the same listId changes nothing but the title; pools
 * that left the list leave at once; `none` or a route that is off switch to
 * the embedded list at once (how a rollback reaches open tabs); valid new pools
 * enter at once after the surviving pools in their existing order. A reorder
 * alone waits for a remount after 30 minutes; a failure keeps the list.
 *
 * Changed 2026-09-28 (speed wave, item 8): a first read that found no answer
 * (its deadline passed, the service was busy, an edge page) put the embedded
 * list on screen for 30 minutes, the served list waiting for a remount: the
 * wrong pools on Home, the ticker, Markets and a link, for half an hour. Now
 * the embedded list a failure that can clear by itself put up is provisional
 * (an invalid list is not asked again): the list is asked again a few
 * seconds on (FEATURED_RETRY_MS), and the first answer that comes takes the
 * screen at once, as a first answer does. And a page with no copy of the last
 * overview in this browser (marketsPaint.ts), whose first load waits for the
 * list, gives that first read 3.5 s (FEATURED_FIRST_DEADLINE_MS) rather than
 * 1.5 s, so a slow list is not taken for none.
 *
 * Changed 2026-10-01 (audit B1, B2, B3):
 *   - the list says how many pools its rules ask for (`size`, the answer's rules.size), so a short list can say so
 *     honestly ("4 of 6 today") instead of looking whole;
 *   - each withdrawal keeps its reason (`withdrawnReasons`). New position refuses a link only to a pool withdrawn for
 *     safety (`withdrawn`: every reason but SOFT_WITHDRAWALS, a pool's figures unavailable or its volume gone); one
 *     that left only because its figures were unavailable is preselected as any other pool;
 *   - every read made while the embedded list only holds the place (the first, and each read again after a first that
 *     found no answer) has FEATURED_FIRST_DEADLINE_MS (`placeholder`); only a refresh of a served list keeps 1.5 s.
 *
 * Pure and Node-safe: the runtime is handed in, never imported, so the node
 * tests compile this file and give it the very same runtime.
 */
import type * as V5 from 'api-contracts/read-v5/runtime.mjs'
import type { VerifiedPool } from 'api-contracts/read-v1/types'
import type { FeaturedPool, FeaturedPoolsResponse } from 'api-contracts/read-v5/runtime.mjs'
import { mainTokenAt, readsAsMainToken } from '../../config/mainTokens'
import { UNSAFE_SYMBOL_TEXT, unsafeSymbol } from '../symbolReading'
import { SELECTED_POOL_CATALOGUE, catalogueTokens, type PoolCatalogueEntry } from '../../config/selectedPoolCatalogue'
import { createBridgeSource, type BridgeOptions } from './bridgeSource'
import type { PoolList } from './marketsProvider'
import { realClock, type Clock } from './pipeline'
import { fixedFeePercent } from './screens/fee'
import { isTransient } from './screens/transient'
import type { ReadOutcome, ReadResponses, ReadRoute, ReadSource, ReadValidators } from './types'

export type FeaturedRuntime = Pick<typeof V5, 'CONTRACT_VERSION' | 'CONTRACT_VERSIONS' | 'ERROR_STATUS_BY_CODE' | 'validateRequest' | 'validateResponse' | 'validateError' | 'matchesRequest'>

export const FEATURED_ROUTE = 'featured-pools' as const
/** The list's whole read, from the moment it is asked: past it, the embedded list. */
export const FEATURED_DEADLINE_MS = 1_500
/** The first read's, on a page that waits for the list (no copy of the last overview in this browser). */
export const FEATURED_FIRST_DEADLINE_MS = 3_500
/** After a first read that found no answer, the list is asked again this long on, then this long after each (see the header). */
export const FEATURED_RETRY_MS: readonly number[] = [3_000, 6_000, 12_000]
/** A list served this long after it was generated is not shown at all (§11.2). */
export const FEATURED_MAX_AGE_SECONDS = 72 * 3600
/** A list with new pools or a new order waits until the one on screen is this old and a screen showing it mounts. */
export const FEATURED_REMOUNT_MS = 30 * 60_000

/**
 * Pools a featured list never shows, lowercase: the owner's emergency brake on
 * this side of the wire. Empty; an entry here drops that pool from any list the
 * service sends, and nothing else.
 */
export const FEATURED_DENY: ReadonlySet<string> = new Set<string>([])

/** Where the list on screen came from: the server's list with its criterion, the server's list without it, or the embedded one. */
export type FeaturedSource = 'server' | 'server_neutral' | 'bundled'

/** Why the app left a pool of a valid answer out. */
export type FeaturedDropReason = 'denied' | 'hooked' | 'fee_mode' | 'integration_class' | 'unsafe_symbol' | 'look_alike'

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000'

/**
 * Text a symbol never holds, and whether a symbol holds it (lib/symbolReading.ts since 2026-10-01): the selector's own
 * rule (backend/featured_pools.py UNSAFE_SYMBOL_TEXT, `token_symbol_unsafe`), checked again here, as spec §11.9 asks:
 * "claim.x.io" is a string the runtime lets through. Added 2026-09-26 after review; a format character counts too
 * since 2026-10-01 (audit I2): a bidirectional control can reorder the text around it on screen.
 */
export { UNSAFE_SYMBOL_TEXT, unsafeSymbol }

/** The app's own checks of one pool of a valid answer: null when it may be shown. */
export function featuredPoolProblem(pool: FeaturedPool): FeaturedDropReason | null {
  const key = pool.poolKey
  if (FEATURED_DENY.has(pool.poolId.toLowerCase())) return 'denied'
  if (key.hooks.toLowerCase() !== ZERO_HOOKS) return 'hooked'
  if (key.feeMode !== 'fixed' || !Number.isSafeInteger(key.fee_pips) || key.fee_pips < 0 || key.fee_pips >= 1_000_000) return 'fee_mode'
  if (pool.integrationClass !== 'hookless_fixed_fee') return 'integration_class'
  if (pool.tokens.some((token) => unsafeSymbol(token.symbol))) return 'unsafe_symbol'
  if (pool.tokens.some((token) => readsAsMainToken(token.symbol, token.address))) return 'look_alike'
  return null
}

export interface ValidFeatured {
  answer: FeaturedPoolsResponse
  /** The answer's pools the app shows, in the answer's order. */
  pools: readonly FeaturedPool[]
  dropped: readonly { poolId: string; reason: FeaturedDropReason }[]
}

/** An answer the app shows the pools of: the pools that pass the app's own checks, and why the others did not. */
export function keptPools(answer: FeaturedPoolsResponse): ValidFeatured {
  const pools: FeaturedPool[] = []
  const dropped: { poolId: string; reason: FeaturedDropReason }[] = []
  for (const pool of answer.pools) {
    const reason = featuredPoolProblem(pool)
    if (reason) dropped.push({ poolId: pool.poolId, reason })
    else pools.push(pool)
  }
  return { answer, pools, dropped }
}

/** The contract's runtime, then the app's own checks: null when the runtime refuses the answer. */
export function validateFeatured(runtime: Pick<FeaturedRuntime, 'validateResponse'>, payload: unknown): ValidFeatured | null {
  try {
    if (!runtime.validateResponse(FEATURED_ROUTE, payload)) return null
  } catch {
    return null
  }
  return keptPools(payload as FeaturedPoolsResponse)
}

/**
 * The runtime as the read pipeline's validators: the answer must pass it
 * whole, a request is exactly `{}`, and an error is read-v1's. The list is
 * asked in the runtime's version (rc.2) and taken in any it accepts: rc.1 too
 * while the VM moves to rc.2 (featured-policy v2, 2026-09-28).
 */
export function featuredValidators(runtime: FeaturedRuntime): ReadValidators {
  return {
    CONTRACT_VERSION: runtime.CONTRACT_VERSION,
    CONTRACT_VERSIONS: runtime.CONTRACT_VERSIONS,
    ERROR_STATUS_BY_CODE: runtime.ERROR_STATUS_BY_CODE,
    assertResponse<R extends keyof ReadResponses>(route: R, payload: unknown): ReadResponses[R] {
      if (route === FEATURED_ROUTE && validateFeatured(runtime, payload)) return payload as ReadResponses[R]
      throw new Error('featured_pools_response_contract')
    },
    validateRequest: (route: ReadRoute, payload: unknown): boolean => route === FEATURED_ROUTE && runtime.validateRequest(FEATURED_ROUTE, payload),
    validateError: (status: number, payload: unknown) => runtime.validateError(status, payload),
    matchesRequest: (route: ReadRoute, request: unknown, response: unknown) => route === FEATURED_ROUTE && runtime.matchesRequest(request, response),
  } as ReadValidators
}

/**
 * The app's source with the list's route beside it: `featured-pools` goes to
 * the same-origin bridge's v5 namespace as one POST, with no capabilities GET
 * before it; every other route goes on to `legacy` unchanged.
 */
export function createFeaturedReadSource(legacy: ReadSource, options: Omit<BridgeOptions, 'namespace' | 'validators' | 'askCapabilities'>, runtime: FeaturedRuntime): ReadSource {
  const source = createBridgeSource({ ...options, namespace: 'v5', validators: featuredValidators(runtime), askCapabilities: false })
  return {
    transport: legacy.transport,
    ...(legacy.supportsStoredReads ? { supportsStoredReads: true as const } : {}),
    read: (route, request, opts) => (route === FEATURED_ROUTE ? source.read(route, request, opts) : legacy.read(route, request, opts)),
    ...(legacy.routeEnabled
      ? { routeEnabled: (route: ReadRoute, opts?: Parameters<NonNullable<ReadSource['routeEnabled']>>[1]) => (route === FEATURED_ROUTE ? Promise.resolve({ state: 'enabled' as const }) : legacy.routeEnabled!(route, opts)) }
      : {}),
  }
}

/** The list's read: first in the queue, 1.5 s from now (or `deadlineMs`). */
export function readFeaturedList(source: ReadSource, { signal, clock = realClock, deadlineMs = FEATURED_DEADLINE_MS }: { signal?: AbortSignal; clock?: Clock; deadlineMs?: number } = {}): Promise<ReadOutcome<'featured-pools'>> {
  return source.read(FEATURED_ROUTE, {}, { priority: 'first', signal, deadlineAt: clock.monotonic() + deadlineMs })
}

/** A pool the list withdrew, lowercase, with the answer's reason. */
export interface Withdrawal {
  poolId: string
  reason: string
}

/**
 * Withdrawals that say nothing about a pool's safety: its figures were unavailable, or its volume went away. A link
 * to such a pool opens New position as any other pool's does (audit B2, the owner's OK, 2026-10-01). Every other
 * reason, and any reason this build does not know, is refused from a link (featured pools v1 §11.5).
 */
export const SOFT_WITHDRAWALS: ReadonlySet<string> = new Set(['estimate_unavailable', 'volume_collapse'])

/** What an answer means for the list, before the rules of §11.2 are applied. */
export type FeaturedAnswer =
  /** A valid list (not `none`), with the pools the app shows. */
  | { kind: 'list'; valid: ValidFeatured; withdrawn: readonly Withdrawal[] }
  /** `none`, or the route is off or not there at all: the embedded list, at once. */
  | { kind: 'off'; withdrawn: readonly Withdrawal[] }
  /**
   * Anything else: an invalid answer, another refusal, a busy service, the 1.5 s passed. `passing` when it can clear
   * by itself (transient.ts: the deadline, a busy service, an edge page): only such a first failure is asked again.
   */
  | { kind: 'failed'; passing?: true }

const withdrawnOf = (answer: FeaturedPoolsResponse): Withdrawal[] => answer.withdrawn.map((entry) => ({ poolId: entry.poolId.toLowerCase(), reason: entry.reason }))

/**
 * An outcome of the list's read as the list sees it. The data of an `ok`
 * outcome has passed the runtime already (featuredValidators); the app's
 * checks run here.
 */
export function answerOf(outcome: ReadOutcome<'featured-pools'>): FeaturedAnswer {
  if (outcome.state === 'ok') {
    const answer = outcome.data
    if (answer.status === 'none') return { kind: 'off', withdrawn: withdrawnOf(answer) }
    return { kind: 'list', valid: keptPools(answer), withdrawn: withdrawnOf(answer) }
  }
  // route_not_available (404), the build's live data off, the deployment with no forwarder for v5: the route is off.
  if (outcome.state === 'disabled' || outcome.state === 'not_connected') return { kind: 'off', withdrawn: [] }
  return isTransient(outcome) ? { kind: 'failed', passing: true } : { kind: 'failed' }
}

/** The list's title (§11.7, option B): the criterion only for a `server` list; the neutral title of today otherwise. */
export const featuredTitle = (source: FeaturedSource) => (source === 'server' ? 'Top pools · last 24h' : 'Selected pools')

/** The list on screen. `entries` is never empty. */
export interface FeaturedList {
  source: FeaturedSource
  entries: readonly PoolCatalogueEntry[]
  /** The server's listId; null for the embedded list. */
  listId: string | null
  /** How many pools the list's rules ask for (its rules.size); null for the embedded list or a list without rules. */
  size?: number | null
}

/** The embedded list: config/selectedPools.ts with its labels. */
export const BUNDLED_LIST: FeaturedList = Object.freeze({ source: 'bundled', entries: SELECTED_POOL_CATALOGUE, listId: null, size: null })

/** Bundled artwork for a token by its exact address: the main tokens', else the embedded list's; none for any other token. */
function artworkAt(address: string) {
  const main = mainTokenAt(address)
  if (main) return main.artwork
  return catalogueTokens().find((token) => token.address === address.toLowerCase())?.artwork ?? null
}

/** A pool of a valid answer as a row names it before its read lands: its symbols (untrusted text), its fee, its addresses. */
export function entryOf(pool: FeaturedPool): PoolCatalogueEntry {
  const [token0, token1] = pool.tokens
  const poolId = pool.poolId.toLowerCase()
  return {
    poolId,
    labels: [token0.symbol, token1.symbol],
    artwork: [artworkAt(token0.address), artworkAt(token1.address)],
    addresses: [pool.poolKey.currency0.toLowerCase(), pool.poolKey.currency1.toLowerCase()],
    fee: fixedFeePercent(pool.poolKey.fee_pips),
    sourceUrl: `https://app.uniswap.org/explore/pools/robinhood/${poolId}`,
    ...(pool.source === 'pinned' ? { pinned: true as const } : {}),
    ...(pool.rankInputs ? { rankApr: pool.rankInputs.rankApr, selection: { tvlUsd: pool.rankInputs.reportedLiquidityUsd, volume24hUsd: pool.rankInputs.volume24hUsd, apr: pool.rankInputs.freshApr, evaluatedAt: pool.rankInputs.evaluatedAt } } : {}),
    poolKey: {
      currency0: pool.poolKey.currency0.toLowerCase(),
      currency1: pool.poolKey.currency1.toLowerCase(),
      fee_pips: pool.poolKey.fee_pips,
      tick_spacing: pool.poolKey.tick_spacing,
      hooks: pool.poolKey.hooks.toLowerCase(),
    },
  }
}

/**
 * Whether a pool's own read (the overview's, a snapshot's or a pool-market read) is the pool its list entry names
 * (§11.3): the same pool key, currencies and a hookless fixed fee. An entry of the embedded list carries no key: its
 * pool id is the whole of what it names, and every read is bound to that id already.
 */
export function bindsToEntry(entry: PoolCatalogueEntry | undefined, pool: VerifiedPool): boolean {
  const want = entry?.poolKey
  if (!want) return true
  const key = pool.poolKey
  const currencies = pool.currencies.map((currency) => currency.toLowerCase())
  return pool.integrationClass === 'hookless_fixed_fee' && key.feeMode === 'fixed'
    && key.currency0.toLowerCase() === want.currency0 && key.currency1.toLowerCase() === want.currency1
    && key.fee_pips === want.fee_pips && key.tick_spacing === want.tick_spacing && key.hooks.toLowerCase() === want.hooks
    && currencies.length === 2 && currencies[0] === want.currency0 && currencies[1] === want.currency1
}

/** The list an answer puts on screen by itself (§11.2), as on a page's first read. */
export function listFrom(answer: FeaturedAnswer): FeaturedList {
  if (answer.kind !== 'list') return BUNDLED_LIST
  const { answer: body, pools } = answer.valid
  const { servedAt, generatedAt, validUntil } = body
  // Every time is the server's own. A list without them, or older than 72 h when served, is not shown.
  if (pools.length === 0 || generatedAt === null || validUntil === null || servedAt > generatedAt + FEATURED_MAX_AGE_SECONDS) return BUNDLED_LIST
  const current = (body.status === 'current' || body.status === 'repaired') && servedAt <= validUntil
  // The criterion title only for a list that names the rules it was ranked by. The method line that spelled them out
  // under the title was removed 2026-09-28 (the owner: "Não precisa ter essa descrição"); the docs page says how.
  return { source: current && body.rules !== null ? 'server' : 'server_neutral', entries: pools.map(entryOf), listId: body.listId, size: body.rules?.size ?? null }
}

/**
 * How many of the pools a served list's rules ask for it shows, when it shows fewer (audit B1, the owner's OK,
 * 2026-10-01): "4 of 6 today". Null for a whole list, the embedded one, or one without rules.
 */
export function shortCount(list: Pick<FeaturedList, 'source' | 'entries' | 'size'>): { shown: number; size: number } | null {
  if (list.source === 'bundled' || typeof list.size !== 'number' || list.size <= 0) return null
  return list.entries.length < list.size ? { shown: list.entries.length, size: list.size } : null
}

const idsOf = (list: FeaturedList) => list.entries.map((entry) => entry.poolId)

/** Whether `next` is `list` with some pools left out and the rest in the same order. */
function onlyRemovals(list: readonly string[], next: readonly string[]): boolean {
  let at = 0
  for (const id of next) {
    at = list.indexOf(id, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/** The list on screen and the one waiting for its turn, after a refresh's answer (see the header). */
export function nextList(shown: FeaturedList, waiting: FeaturedList | null, answer: FeaturedAnswer): { shown: FeaturedList; waiting: FeaturedList | null } {
  if (answer.kind === 'failed') return { shown, waiting }
  const candidate = listFrom(answer)
  if (candidate.source === 'bundled') return { shown: BUNDLED_LIST, waiting: null }
  if (shown.source === 'bundled') return { shown: candidate, waiting: null }
  // The same list: its pools and order stay; its title follows the answer (a list gone stale says so).
  if (candidate.listId === shown.listId) return { shown: { ...shown, source: candidate.source, size: candidate.size ?? null }, waiting: null }
  const ids = idsOf(candidate)
  if (onlyRemovals(idsOf(shown), ids)) return { shown: candidate, waiting: null }
  // Replacements cannot wait for a remount: remove departed pools, keep survivors
  // in their existing order, and append only the newly admitted, validated entries.
  const before = new Set(idsOf(shown))
  const added = candidate.entries.filter((entry) => !before.has(entry.poolId))
  const kept = shown.entries.flatMap((entry) => candidate.entries.filter((next) => next.poolId === entry.poolId))
  if (added.length) return { shown: { ...candidate, entries: [...kept, ...added] }, waiting: null }
  if (kept.length === 0) return { shown: candidate, waiting: null }
  if (kept.length < shown.entries.length) return { shown: { ...shown, entries: kept }, waiting: candidate }
  return { shown, waiting: candidate }
}

/** The list as the page holds it. */
export interface FeaturedSnapshot extends FeaturedList {
  /** Whether the first answer is in (or given up on). Before it, the embedded list stands in. */
  settled: boolean
  /**
   * Pools removed by a safety rule in the last seven days, lowercase: New position refuses them from a link (§11.5).
   * Since 2026-10-01 (audit B2) only the safety ones: a pool withdrawn for SOFT_WITHDRAWALS is not in it.
   */
  withdrawn: ReadonlySet<string>
  /** Every withdrawal of the last answer, lowercase pool id to the answer's reason (audit B2). */
  withdrawnReasons?: ReadonlyMap<string, string>
}

export interface FeaturedStore {
  getSnapshot(): FeaturedSnapshot
  subscribe(listener: () => void): () => void
  /**
   * The page's first read of the list, once; every later call waits for that same read. Resolves to the list as it
   * is when it resolves, a refresh's changes since included (a pool withdrawn by a later answer, above all), never a
   * copy kept from the first answer (fixed 2026-09-26 after review). Never rejects.
   */
  ensure(): Promise<FeaturedSnapshot>
  /** Reads the list again and applies the refresh rules (the header). Never rejects. */
  refresh(signal?: AbortSignal): Promise<FeaturedSnapshot>
  /** A screen that shows the list mounted: a list waiting for its turn takes it once the one on screen is 30 min old. */
  remount(): void
  /** Rows whose read did not bind to their entry (§11.3): they leave the list; with none left, the embedded list. */
  unbind(poolIds: readonly string[]): void
}

const NO_WITHDRAWN: ReadonlySet<string> = new Set()
const NO_REASONS: ReadonlyMap<string, string> = new Map()

/**
 * The page's one list. `read` asks the list once and says what came back; it
 * never throws (readFeaturedList and answerOf, in the app).
 */
export function createFeaturedStore({ read, clock = realClock }: {
  /** `placeholder`: the embedded list only holds the place while this read is out (B3): it gets the longer deadline. */
  read: (signal?: AbortSignal, placeholder?: boolean) => Promise<FeaturedAnswer>
  clock?: Clock
}): FeaturedStore {
  let snapshot: FeaturedSnapshot = { ...BUNDLED_LIST, settled: false, withdrawn: NO_WITHDRAWN, withdrawnReasons: NO_REASONS }
  let waiting: FeaturedList | null = null
  /** When the pools on screen were put there, on the monotonic clock. */
  let shownAt = clock.monotonic()
  let first: Promise<void> | null = null
  const listeners = new Set<() => void>()
  /** The embedded list is on screen only because no answer has come yet: the first one that comes takes the screen. */
  let provisional = false
  let retries = 0
  let cancelRetry: (() => void) | null = null
  /** While provisional, the list is asked again FEATURED_RETRY_MS on, a few times. */
  const retry = () => {
    cancelRetry?.()
    cancelRetry = null
    if (!provisional || retries >= FEATURED_RETRY_MS.length) return
    cancelRetry = clock.timer(FEATURED_RETRY_MS[retries++], () => {
      cancelRetry = null
      void refresh()
    })
  }

  /** Puts `shown` on screen, and tells the page only when something it shows changed. */
  const publish = (shown: FeaturedList, withdrawn: Withdrawn) => {
    const ids = idsOf(shown).join()
    if (ids !== idsOf(snapshot).join()) shownAt = clock.monotonic()
    const reasons = [...withdrawn.reasons].join()
    const same = snapshot.settled && ids === idsOf(snapshot).join() && shown.listId === snapshot.listId && shown.source === snapshot.source
      && (shown.size ?? null) === (snapshot.size ?? null) && reasons === [...(snapshot.withdrawnReasons ?? NO_REASONS)].join()
    if (same) return
    snapshot = { source: shown.source, entries: shown.entries, listId: shown.listId, size: shown.size ?? null, settled: true, withdrawn: withdrawn.safety, withdrawnReasons: withdrawn.reasons }
    for (const listener of listeners) listener()
  }
  type Withdrawn = { safety: ReadonlySet<string>; reasons: ReadonlyMap<string, string> }
  // A failure says nothing about removals: the ones known stay.
  const withdrawnFrom = (answer: FeaturedAnswer): Withdrawn => answer.kind === 'failed'
    ? { safety: snapshot.withdrawn, reasons: snapshot.withdrawnReasons ?? NO_REASONS }
    : { safety: new Set(answer.withdrawn.filter((entry) => !SOFT_WITHDRAWALS.has(entry.reason)).map((entry) => entry.poolId)), reasons: new Map(answer.withdrawn.map((entry) => [entry.poolId, entry.reason])) }
  const kept = (): Withdrawn => ({ safety: snapshot.withdrawn, reasons: snapshot.withdrawnReasons ?? NO_REASONS })
  // A read made while the embedded list only holds the place has the longer deadline (B3).
  const safely = (signal?: AbortSignal, placeholder = false) => read(signal, placeholder).catch((): FeaturedAnswer => ({ kind: 'failed' }))

  function ensure(): Promise<FeaturedSnapshot> {
    first ??= safely(undefined, true).then((answer) => {
      publish(listFrom(answer), withdrawnFrom(answer))
      provisional = answer.kind === 'failed' && answer.passing === true
      retry()
    })
    return first.then(() => snapshot)
  }

  async function refresh(signal?: AbortSignal): Promise<FeaturedSnapshot> {
    if (!snapshot.settled) return ensure()
    const answer = await safely(signal, provisional || snapshot.source === 'bundled')
    if (signal?.aborted) return snapshot
    if (provisional && answer.kind !== 'failed') {
      // The first answer since a first read that found none: it takes the screen, as a first answer does.
      provisional = false
      retry()
      waiting = null
      publish(listFrom(answer), withdrawnFrom(answer))
      return snapshot
    }
    const next = nextList(snapshot, waiting, answer)
    waiting = next.waiting
    publish(next.shown, withdrawnFrom(answer))
    // A failure that cannot clear by itself (an invalid list) is not asked again on the list's own.
    if (provisional && answer.kind === 'failed' && !answer.passing) provisional = false
    if (provisional && !cancelRetry) retry()
    return snapshot
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ensure,
    refresh,
    remount() {
      if (!waiting || !snapshot.settled || clock.monotonic() - shownAt < FEATURED_REMOUNT_MS) return
      const adopted = waiting
      waiting = null
      publish(adopted, kept())
    },
    unbind(poolIds) {
      if (poolIds.length === 0 || snapshot.source === 'bundled') return
      const gone = new Set(poolIds.map((id) => id.toLowerCase()))
      const kept = snapshot.entries.filter((entry) => !gone.has(entry.poolId))
      if (kept.length === snapshot.entries.length) return
      // The list waiting for its turn is the service's; a row that did not bind leaves it too.
      if (waiting) waiting = { ...waiting, entries: waiting.entries.filter((entry) => !gone.has(entry.poolId)) }
      if (waiting && waiting.entries.length === 0) waiting = null
      publish(kept.length > 0 ? { ...snapshot, entries: kept } : BUNDLED_LIST, { safety: snapshot.withdrawn, reasons: snapshot.withdrawnReasons ?? NO_REASONS })
    },
  }
}

/**
 * The store as the markets provider follows it (marketsProvider.ts PoolList): the list is brought up to date before
 * each load, a read row must bind to its entry, and a row that does not leaves the list.
 */
export function poolListOf(store: FeaturedStore): PoolList {
  return {
    ids: () => store.getSnapshot().entries.map((entry) => entry.poolId),
    update: (first, signal) => (first ? store.ensure() : store.refresh(signal)),
    binds: (poolId, pool) => bindsToEntry(store.getSnapshot().entries.find((entry) => entry.poolId === poolId.toLowerCase()), pool),
    unbind: (poolIds) => store.unbind(poolIds),
    subscribe: (listener) => store.subscribe(listener),
  }
}

/** A store for a build that never reads the list (the fixture and test builds): the embedded list, settled. */
export function bundledStore(): FeaturedStore {
  const snapshot: FeaturedSnapshot = { ...BUNDLED_LIST, settled: true, withdrawn: NO_WITHDRAWN, withdrawnReasons: NO_REASONS }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    ensure: () => Promise.resolve(snapshot),
    refresh: () => Promise.resolve(snapshot),
    remount: () => undefined,
    unbind: () => undefined,
  }
}
