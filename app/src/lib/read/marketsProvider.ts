/**
 * Where the Selected pools table and the ticker get their rows.
 *
 * Components depend on this interface, never on a read source directly. The
 * app holds one provider, shared through context, so the ticker and the table
 * render one result set from one load. Rows come from validated reads only;
 * there is no sample or placeholder row anywhere.
 *
 * A load is lean, on rugged97's read budget (#45), and paced by the shared
 * scheduler, one read at a time. Which routes it uses is the deployment's
 * call: the source's capabilities answer is asked first, without a POST and
 * without a place in the queue, so a route that is not listed costs nothing.
 *
 *   1. markets-snapshot, when listed: one read for every selected pool, whose
 *      stored entries become rows at once (marketsSnapshot.ts). A failed
 *      answer is never shown; it sends the table to step 3 for five minutes.
 *   2. Token metadata for those rows, each distinct token once.
 *   3. pool-market without price history, for each pool the snapshot did not
 *      answer for well enough, or for every pool when it is not used. V2
 *      carries the backend estimate in that same read. Each row is on screen
 *      as soon as its read answers, named from the catalogue's labels, and
 *      the tokens it still needs are read right after it, so the rows
 *      complete one by one (#138 §5). A token shared by several rows is read
 *      once. Until a row's token reads have settled the row says so
 *      (`tokensPending`): not yet read is not the same as read without
 *      decimals.
 *   4. pool-metrics, one per row, when listed: listing it is the read
 *      service's consent to the extra reads. Its qualified figures take
 *      precedence over the provider's; a failed read leaves the provider's
 *      figures and says why in the row's title only.
 *
 * Only an answer about the page itself stops a load: the gate, access, live
 * data not connected, or switched off other than for one route. The pools'
 * own market reads, and the capabilities checks asked before them, also stop
 * it on a contract header this page does not accept. A hop's refusal (502
 * upstream_contract_mismatch) stops nothing: from a pool's own read it is that
 * row's problem, and from a capabilities check it is as if the route were not
 * listed, so the pools' own reads go on and ask the capabilities again (a
 * failed answer is never kept). Anything else a token or pool-metrics read
 * comes back with, a payload the Worker or the gateway refused included,
 * stays with its row.
 *
 * With nothing listed but the lean routes, that is N pool-market and U token
 * POSTs for N pools and U distinct tokens. Token metadata that read as
 * available is reused in memory for at most five minutes, retaining its
 * original observation time. The optional V3 bundle supplies markets,
 * metadata and APR together. An empty selection reads nothing at all.
 *
 * A read never shortens the table. Each pool's last good row is kept, and a
 * pool whose read fails keeps that row on screen, dated and marked stale,
 * beside the reason, as docs/API_COMPATIBILITY.md asks. A failed payload
 * itself is never shown.
 *
 * Home and Markets have no Retry. While a screen holds `recoverQuietly`, the
 * provider asks again on its own, quietly and only while the page can be
 * seen, and only for what a busy service or a flapping hop kept from the rows:
 *
 *   - a read still busy after R-1 (that pool's market read, that token or
 *     that pool-metrics read alone), or a pool's market read or a token read
 *     that a hop refused (502 upstream_contract_mismatch, which a gateway that
 *     does not stamp its own mid-hop failures sends for a hop that is only
 *     flapping: transient.ts), never the table. A first load whose pools all
 *     met such a refusal, at the capabilities GET their reads wait for or at
 *     their own reads, has nothing on screen but the catalogue, and its pools
 *     are asked again the same way. After the service's wait, 4 s at the
 *     least, doubling each time, within ±25% and never sooner than the
 *     service asked; four times a visit;
 *   - a row whose provider figures are unavailable because the provider was
 *     busy or rate limited: that pool's market read alone, after the read
 *     service's 60 s fresh window plus up to a quarter of it; three times a
 *     visit for each pool. Where the rows came from the stored overview, the
 *     overview is what is asked again (changed 2026-09-28, speed wave, item
 *     2): one stored read of about 65 ms for the table, where the pool's own
 *     read is a provider read of about 4.9 s that held the queue.
 *
 * When the last viewer leaves while a read runs, it is cancelled 2 s later,
 * not at once: a screen that follows straight away (Home to Markets) joins it
 * instead of starting it over.
 *
 * Added 2026-09-25 (r4/metrics), from the owner's Home on production, where
 * ETH/USDG and PONS/USDG said "Unavailable" for a minute while Markets, read
 * later, had their figures:
 *
 *   - every read of a load is asked `priority: 'first'` (scheduler.ts), so the
 *     table, the ticker and Home wait for no Markets card's history read; a
 *     refresh of rows already settled on screen, the catch-up asks included,
 *     is not (changed 2026-09-28, speed wave, item 11): it jumped ahead of the
 *     next page's own reads and spent the budget before them;
 *   - a stored overview that serves a pool without its provider figures is
 *     asked again soon, instead of a minute later, only where they are
 *     coming (`catchUpInMs`): the provider gave figures for that pool before
 *     (they aged past the store's five minutes, or its last ask missed), the
 *     store's last collection did not fail (a failed one backs off for up to
 *     five minutes and is not brought forward), and its next collection runs
 *     now (a lease held) or within CATCH_UP_HORIZON_MS. The overview itself
 *     marks its pools wanted, which brings that collection within five
 *     seconds (backend/migrations/026_public_demand.sql). The ask goes at
 *     that collection plus CATCH_UP_MARGIN_MS, CATCH_UP_FLOOR_MS at the
 *     soonest, the floor 1.4 times longer at each ask in a row (asks at
 *     about 6.5, 10, 15 and 22 s while a collection runs late).
 *     Meanwhile such a row says its figures are coming (`figuresPending`),
 *     not that they are unavailable: nothing has failed yet. It stops
 *     waiting, and says Unavailable as it is, when a collection published
 *     since it began brought none, or when its next ask would fall past
 *     CATCH_UP_WINDOW_MS from the answer it began with; it waits again only
 *     once it has caught up or stopped being behind. Revised 2026-09-25
 *     after review: the first cut also waited for a pool whose collection had
 *     failed (three minutes of placeholder) and for one the provider never
 *     covered (twenty seconds on every visit).
 *
 * Added 2026-09-27 (r6/marketsdata), from the owner's Home on production,
 * where the figures sometimes took very long and USDG/U sat on loading bars.
 * Measured with production's latency in the harness
 * (tests/support/markets-latency.mjs), the first figures waited for the
 * featured list's answer, then the capabilities, then the overview, one
 * after the other (1.7 s typical, 2.9 s when the list is slow), every visit
 * started from nothing, and a first load that failed was never asked again:
 *
 *   - with this browser's copy of the last overview (marketsPaint.ts), the
 *     first load does not wait for the list: it reads the pools the copy
 *     names beside the list's first read and follows the list once it
 *     answers: a list with other pools starts the load over for them at
 *     once, and a row read before the list answered that does not bind to
 *     its entry leaves the list. Without a copy it waits for the list, as
 *     before, with the capabilities asked meanwhile (reading the embedded
 *     list's pools first cost a read, and a flash of other pools, whenever
 *     the list names others, as the served list will);
 *   - this browser's copy of the last overview paints the rows before the
 *     first answer, each figure as old as it is, marked as coming
 *     (`figuresPending`) where it has none, and the answer replaces them;
 *   - a row whose figures are coming shows the ones this page last had for
 *     its pool, dated and marked stale, rather than a loading bar;
 *   - a row with none to show shows a placeholder for CATCH_UP_SHOWN_MS at
 *     the most, then says what it has while the page keeps asking to the end
 *     of CATCH_UP_WINDOW_MS (a placeholder used to stand for up to 25 s),
 *     and waits afresh only once it has caught up (an answer that merely
 *     found it not behind brought the placeholder back at every minute);
 *   - a stored load that read nothing is asked again after 5 s, then 15 s,
 *     45 s, and less often up to eight minutes, while the page can be seen (the
 *     first overview met a gateway down for a moment: no figures until a
 *     reload, measured).
 *
 * Measured after, the same way (median of three): Home's first figures at
 * 1.6 s on a first visit (1.7 s before; the rest is the list's and the
 * store's own time), 0.2 s on a later visit (1.6 s before, 2.7 s and 3.5 s
 * when the list or the store was slow), 7.4 s after a first overview that
 * failed (never before).
 *
 * Changed 2026-09-28, from the owner's Home on production, the first day of
 * the daily list: ETH/NOTE and PONS/USDG said Unavailable within seconds, the
 * overview was asked at 12:53:13, :16 and :19, and then not before the
 * minute. The rule above waited only for a pool whose provider figures the
 * store had once kept (`ageSeconds` set), and stopped at the first collection
 * published without figures, even one the provider had rate limited. The
 * store serves `ageSeconds` null whenever its collector holds no figures for
 * the pool at all (backend/market_cache.py `_result`): never fetched since the
 * collector started, and every call since refused, rate limited or failed. A
 * pool never collected has no stored value at all (acquisition `pending`).
 * Both are collected within five seconds of this very request as well, so:
 *
 *   - a pool whose figures are coming is one with none on hand (no stored
 *     value, or provider figures unavailable) whose store's last collection
 *     did not fail and whose next one runs now or within
 *     CATCH_UP_HORIZON_MS, whatever `ageSeconds` says (catchUpInMs);
 *   - a pool with no stored value shows its placeholder in the catalogue row
 *     (`placeholders`) under the same CATCH_UP_SHOWN_MS as a read row;
 *   - a collection the provider was busy or rate limited for (providerWasBusy)
 *     does not end the wait: the next one, seconds later while the pool is
 *     wanted, may bring the figures, so the asks go on to the end of
 *     CATCH_UP_WINDOW_MS. A collection that brought none for any other reason
 *     (the provider does not list the pool, say) still ends it at once, so
 *     such a pool costs a visit an ask or two and a placeholder of a few
 *     seconds (6.5 s when the store collects on time, CATCH_UP_SHOWN_MS at the
 *     most), not the twenty seconds that made the review of 2026-09-25 leave
 *     it out.
 *
 * A row still unavailable after the window is asked again with the ordinary
 * refresh, once a minute while the page can be seen (a hidden page waits
 * until it can be), in place and quietly; nothing else changes.
 */
import type { PoolMarketResponse, SnapshotPoolEntry, VerifiedPool } from 'api-contracts/read-v1/types'
import type { StoredPool } from 'api-contracts/read-v3/types'
import type { Market, MarketsResult, Metric } from '../markets'
import type { PaintedOverview, PaintMemory } from './marketsPaint'
import { createSnapshotMemo, planSnapshot, SNAPSHOT_MAX_POOLS, type SnapshotMemo } from './marketsSnapshot'
import { realClock, type Clock } from './pipeline'
import { TOKEN_METADATA_CACHE_MS } from './publicMetadataCache'
import { overviewRows, storedPoolRead, storedTokenRead } from './publicOverview'
import { projectMarketRow, projectSnapshotRow } from './project'
import { reroute, type FailedOutcome, type ReadOutcome, type ReadRequests, type ReadSource, type RouteCheck } from './types'

export interface MarketProblem {
  poolId: string
  outcome: FailedOutcome
  /** A token read's problem: that token, lowercase. The first pool that needed it carries it. */
  token?: string
}

export interface Retained {
  result: MarketsResult
  /** Client clock, ms, when the retained rows were read. */
  receivedAt: number
}

export type MarketsState =
  /** `retrying` is the failure a refresh is trying to get past, still on screen meanwhile. */
  | { phase: 'loading'; previous: MarketsResult | null; retrying: FailedOutcome | null }
  | {
      phase: 'ready'
      result: MarketsResult
      problems: MarketProblem[]
      acquiring?: boolean
      /** Pools with no row yet whose figures are coming: their catalogue rows show a placeholder, lowercase (see the header). */
      placeholders?: readonly string[]
    }
  /** Nothing new to show. `retained` is the last good read, already marked stale. */
  | { phase: 'failed'; failure: FailedOutcome; retained: Retained | null }

export interface MarketsProvider {
  readonly kind: 'fixture' | 'bridge'
  getSnapshot(): MarketsState
  subscribe(listener: () => void): () => void
  /** Starts the first load if none has started. */
  ensure(): void
  refresh(): void
  /**
   * While held, what a busy service or a flapping hop kept from the rows is
   * asked again on its own, quietly and bounded (see the header). Returns the
   * release. Home and Markets hold it; the read lab, with its own Refresh and
   * Retry, does not. A provider without it never asks again on its own.
   */
  recoverQuietly?(): () => void
}

/** States about the page itself: whatever else this page asks meets them too. */
export const isPageWide = (outcome: FailedOutcome) =>
  outcome.state === 'not_connected' ||
  outcome.state === 'gate_required' ||
  outcome.state === 'gate_unavailable' ||
  outcome.state === 'access_required' ||
  (outcome.state === 'disabled' && outcome.reason !== 'route_not_enabled')

/** States that stop the table at its pools' own market reads: the page's, or a contract this page does not speak. */
export const isBlocking = (outcome: FailedOutcome) => isPageWide(outcome) || outcome.state === 'incompatible'

/** A hop refusing a read's payload, or the capabilities answer a read waits for: 502 upstream_contract_mismatch, never the page's own contract. */
const isHopRefusal = (outcome: FailedOutcome) => outcome.state === 'incompatible' && outcome.reason === 'upstream_contract_mismatch'

/**
 * What stops the table at one pool's market read, or at a capabilities check
 * asked before the pools' reads. A hop refusing that pool's payload, or that
 * check (502 upstream_contract_mismatch), is not the page's problem. A
 * contract header this page does not accept meets every read, so it stops the
 * table.
 */
export const stopsTable = (outcome: FailedOutcome) => isBlocking(outcome) && !isHopRefusal(outcome)

/**
 * What a quiet re-ask asks again (see the header): a read a busy service
 * refused, and a read a hop refused, whose answers can pass when asked later
 * (transient.ts). Anything else stays as it is: the rows already say what is
 * unavailable, and a reload asks again.
 */
export const asksAgainQuietly = (outcome: FailedOutcome) => outcome.state === 'busy' || isHopRefusal(outcome)

type MarketObservation = PoolMarketResponse['market']

/**
 * Provider figures missing only because the provider was busy or rate limited: a later read can bring them. Kept as it
 * was on 2026-10-01 (audit V1): `provider_unavailable` still ends a catch-up wait (a collection that brought nothing),
 * and the row then shows what this browser last saw, DEX Screener's or today's selection's figures instead of
 * "Unavailable" (lib/read/figureFallback.ts), so a refusal no longer empties it either way.
 */
export const providerWasBusy = (market: MarketObservation) =>
  market.status === 'unavailable' && (market.reason === 'provider_capacity_busy' || market.reason === 'provider_rate_limited' || market.cache.status === 'rate_limited')

/** How long a load still running waits, once its last viewer has left, before it is cancelled. */
export const LEAVE_GRACE_MS = 2_000
/** Quiet re-asks of what a busy service or a refusing hop kept from the rows, per visit. */
export const BUSY_RECOVERY_ATTEMPTS = 4
/** Quiet re-asks of a row whose provider was busy, per pool per visit. */
export const PROVIDER_BUSY_ATTEMPTS = 3
/** The read service's fresh window for provider figures, which a busy provider's row waits out before it is read again. */
export const PROVIDER_BUSY_WAIT_MS = 60_000
/**
 * A pool's next collection further away than this is not waited for. The store brings a wanted pool's within five
 * seconds (backend/migrations/026_public_demand.sql); the rest is margin.
 */
export const CATCH_UP_HORIZON_MS = 10_000
/** After the producer's next attempt, how long a collection is given to publish before the overview is asked again. */
export const CATCH_UP_MARGIN_MS = 1_500
/** The first catch-up is never asked sooner than this after the answer before it; each ask in a row CATCH_UP_BACKOFF times longer. */
export const CATCH_UP_FLOOR_MS = 2_500
export const CATCH_UP_BACKOFF = 1.4
/**
 * How long a pool's row waits for figures from the answer it began waiting with. The collector takes four pools a
 * tick, twelve seconds each at the most (backend/manage_public_data.py), so a fifth pool can publish well after the
 * first four.
 */
export const CATCH_UP_WINDOW_MS = 25_000
/**
 * How long a row whose figures are coming shows a placeholder where they will land, from the answer it began waiting
 * with: only while the next ask falls within it. Past it the row says what it has, while the page keeps asking to the
 * end of CATCH_UP_WINDOW_MS. Added 2026-09-27 (r6/marketsdata, the owner: USDG/U sat on loading bars on Home).
 */
export const CATCH_UP_SHOWN_MS = 8_000

/**
 * How far off a stored pool's figures are, when they are coming: in MILLISECONDS of server time from the answer
 * (`nextAttemptAt - generatedAt`, never this browser's clock), 0 while a collection runs. Null when they are not
 * coming soon: fresh figures on hand, or provider figures rejected; a collection that failed (`reason` set: the store backs
 * it off for up to five minutes and a request does not bring it forward); a next collection further off than
 * CATCH_UP_HORIZON_MS, or none named; a rejected pool. Changed 2026-09-28 (see the header): a pool with no stored
 * value yet, and one whose collector holds no figures for it (`ageSeconds` null), are coming too.
 */
export function catchUpInMs(entry: StoredPool, generatedAt: number): number | null {
  const { value, acquisition } = entry
  if (acquisition.status === 'rejected' || acquisition.reason !== null) return null
  if (value !== null && value.market.market.status !== 'unavailable' && value.market.market.status !== 'stale') return null
  if (acquisition.refreshing) return 0
  if (acquisition.nextAttemptAt === null) return null
  const inMs = Math.max(0, acquisition.nextAttemptAt - generatedAt) * 1000
  return inMs <= CATCH_UP_HORIZON_MS ? inMs : null
}

/**
 * The wait before quiet re-ask `attempt` (from 0) of what a busy service or a
 * refusing hop kept from the rows: the Retry-After (none for a hop), 4 s at
 * the least, doubling each time, then drawn within ±25% so tabs told the same
 * do not all come back at once, and never shorter than the Retry-After itself.
 */
export function busyRecoveryDelayMs(retryAfterSeconds: number, attempt: number, random: () => number): number {
  const base = Math.max(retryAfterSeconds, 4) * 1000 * 2 ** attempt
  return Math.max(retryAfterSeconds * 1000, Math.round(base * (0.75 + 0.5 * random())))
}

/** The wait before a busy provider's row is read again: the read service's 60 s fresh window, plus up to a quarter of it. */
export const providerBusyDelayMs = (random: () => number) => Math.round(PROVIDER_BUSY_WAIT_MS * (1 + 0.25 * random()))

/** Whether the page can be seen, and word when that changes. */
export interface PageVisibility {
  hidden(): boolean
  /** Calls `listener` on every change until the function it returns is called. */
  onChange(listener: () => void): () => void
}

/** The document's visibility; always visible where there is no document. */
export const documentVisibility: PageVisibility = {
  hidden: () => typeof document !== 'undefined' && document.hidden,
  onChange: (listener) => {
    if (typeof document === 'undefined') return () => undefined
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/** One kept row made stale: every figure that was current becomes stale, dated to its own observation or, failing that, to when it was read. */
export function retainRowAsStale(row: Market, receivedAtMs: number): Market {
  const readAt = Math.floor(receivedAtMs / 1000)
  const age = (m: Metric): Metric => (m.state === 'qualified' || m.state === 'provider' ? { ...m, state: 'stale', asOf: m.asOf ?? readAt } : m)
  // A kept row is asked again by nobody: figures it was waiting for are not coming with it.
  const { figuresPending: _waiting, ...kept } = row
  return {
    ...kept,
    tvlUsd: age(row.tvlUsd),
    volume24hUsd: age(row.volume24hUsd),
    feeAprPercent: age(row.feeAprPercent),
    ...(row.lpFees24hUsd ? { lpFees24hUsd: age(row.lpFees24hUsd) } : {}),
    ...(row.timeWeightedTvlUsd ? { timeWeightedTvlUsd: age(row.timeWeightedTvlUsd) } : {}),
    ...(row.feeAprEstimate ? { feeAprEstimate: { ...row.feeAprEstimate, retained: true } } : {}),
  }
}

/**
 * Rows kept after a failed refresh. Every figure that was current becomes
 * stale, dated to its own observation or, failing that, to when it was read.
 */
export function retainAsStale(result: MarketsResult, receivedAtMs: number): MarketsResult {
  return { ...result, markets: result.markets.map((row) => retainRowAsStale(row, receivedAtMs)) }
}

/**
 * A row whose figures are coming, with the ones `earlier` had where it has none: stale and dated to their own
 * observation (retainRowAsStale), its APR estimate kept as retained. Added 2026-09-27 (r6/marketsdata): a loading bar
 * stood where this page already knew the figure.
 */
export function keepFigures(row: Market, earlier: Market, receivedAtMs: number): Market {
  const old = retainRowAsStale(earlier, receivedAtMs)
  const pick = (now: Metric, then: Metric) => (now.state === 'unavailable' && then.state === 'stale' ? then : now)
  const estimate = row.feeAprEstimate?.data?.feeAprEstimate24hPercent == null && old.feeAprEstimate?.data ? { feeAprEstimate: old.feeAprEstimate } : {}
  return { ...row, tvlUsd: pick(row.tvlUsd, old.tvlUsd), volume24hUsd: pick(row.volume24hUsd, old.volume24hUsd), ...estimate }
}

export interface LoadedMarkets {
  rows: Market[]
  problems: MarketProblem[]
  blocking: FailedOutcome | null
  aborted: boolean
}

/** The one pool-market request the table sends: price history explicitly off, because the table draws no chart. */
export const tableMarketRequest = (poolId: string): ReadRequests['pool-market'] => ({ poolId, includePriceHistory: false })

type OkRead<R extends 'token' | 'pool-market' | 'markets-snapshot'> = Extract<ReadOutcome<R>, { state: 'ok' }>

/** What a load keeps between loads, and which of the optional routes it may use. A bare load keeps nothing and uses none. */
export interface LoadOptions {
  /**
   * Token reads kept for the provider's life, by lowercase address: only `ok`
   * answers whose metadata read as available. A failed or partial read is
   * asked again on the next load. Absent: nothing is kept.
   */
  tokens?: Map<string, OkRead<'token'>>
  /** When the snapshot last failed. Absent: markets-snapshot is never asked. */
  snapshot?: SnapshotMemo
  /** Read each row's pool-metrics when the capabilities list the route. Absent or false: never asked. */
  metrics?: boolean
  /** The additive stored bundle, preferred when its namespace advertises it. */
  overview?: boolean
  /**
   * Whether the provider asks the overview again in time for a stored pool whose figures are coming (`catchUpInMs`,
   * given here), and whether its row shows a placeholder meanwhile (`'shown'`, the row says `figuresPending`) or what
   * it has (`'asked'`). False or absent: the row says what it has, Unavailable.
   */
  catchUp?: (entry: StoredPool, inMs: number) => 'shown' | 'asked' | false
  /** Filled by each overview read: the pools the provider asks again for (catchUp), lowercase. */
  coming?: Set<string>
  /** The overview's capabilities check already asked for this load (the first one's, beside the list): used once. */
  overviewCheck?: Promise<RouteCheck>
  /**
   * Whether a pool's own read matches the list's entry for it (featured pools v1 §11.3): a row whose read does not
   * is left out of the rows, and named in `unbound`. Absent: every read row stands.
   */
  binds?: (poolId: string, pool: VerifiedPool) => boolean
  /** Every pool a read named, as read, by lowercase id: what a list that answers later is bound again against. */
  seen?: Map<string, VerifiedPool>
  /** A refresh of rows already settled on screen: its reads are not asked first (speed wave, item 11). */
  inPlace?: boolean
}

/** A row's own read: the pool's market read, or its entry in the stored snapshot. */
type RowSource = { kind: 'market'; outcome: OkRead<'pool-market'> } | { kind: 'snapshot'; outcome: OkRead<'markets-snapshot'>; entry: SnapshotPoolEntry }

const currenciesOf = (row: RowSource) => (row.kind === 'market' ? row.outcome.data.pool.currencies : row.entry.pool.currencies)
const observationOf = (row: RowSource): MarketObservation => (row.kind === 'market' ? row.outcome.data.market : row.entry.market)
const key = (id: string) => id.toLowerCase()

/** The reads a table's rows stand on, by lowercase pool id or token address, and what failed among them. */
interface Ledger {
  sources: Map<string, RowSource>
  metrics: Map<string, ReadOutcome<'pool-metrics'>>
  tokens: Map<string, ReadOutcome<'token'>>
  problems: MarketProblem[]
}

/** What a quiet re-ask reads again, lowercase: pools' market reads, tokens, pools' pool-metrics. */
export interface RecoveryPlan {
  markets: readonly string[]
  tokens: readonly string[]
  metrics: readonly string[]
}

interface Load extends LoadedMarkets {
  ledger: Ledger
  /** Pools whose own market read, stored entry or pool-metrics this load read. */
  read: Set<string>
  acquiring?: boolean
  /**
   * When the producer says it will try again, as a delay in MILLISECONDS, taken
   * entirely in server time: `nextAttemptAt - generatedAt`, both from the same
   * reply. Never `nextAttemptAt` against this browser's clock — a machine ten
   * minutes fast would schedule nonsense (figures.ts: times come only from the
   * payload). Null when the producer named no time.
   */
  acquisitionInMs?: number | null
  /** A lease is held: an attempt is in flight right now, so `nextAttemptAt` is already behind. */
  acquisitionRunning?: boolean
  stored?: boolean
  /**
   * The rows that wait for figures (`figuresPending`): the soonest of their collections, in MILLISECONDS of server
   * time from the answer (0 while one runs). Null: no row waits.
   */
  catchUpInMs?: number | null
  /** Every pool of the stored overview whose figures are coming (`catchUpInMs`), lowercase, waiting or not; absent when no overview was read. */
  behind?: string[]
  /** Pools with no row whose figures are coming, shown as a placeholder (MarketsState `placeholders`), lowercase. */
  placeholders?: string[]
  /** Pools whose read did not bind to their entry (LoadOptions.binds), lowercase: they have no row. */
  unbound: string[]
  /** The stored overview this load read, as it came: what this browser keeps a copy of (marketsPaint.ts). */
  overview?: PaintedOverview
  /** The stored overview answered with no pool at all for the pools it was asked: no answer about them (audit V1). */
  empty?: boolean
}

/** One problem per read: a pool's market read, a pool's pool-metrics read, or a token. */
const problemKey = (problem: MarketProblem) => (problem.token ? `token:${problem.token}` : `${problem.outcome.route}:${key(problem.poolId)}`)

/**
 * The reads behind the table, strictly one after another, in the order the
 * header describes. Given the ledger of an earlier load and a plan, it is a
 * quiet re-ask instead: it starts from those reads and reads again only what
 * the plan names, then what that brings with it (the tokens of a row that
 * came back, and its pool-metrics where none was read).
 */
async function readMarkets(
  source: ReadSource,
  poolIds: readonly string[],
  signal: AbortSignal | undefined,
  onProgress: ((rows: Market[]) => void) | undefined,
  options: LoadOptions,
  again?: { ledger: Ledger; plan: RecoveryPlan },
): Promise<Load> {
  const ledger: Ledger = again
    ? { sources: new Map(again.ledger.sources), metrics: new Map(again.ledger.metrics), tokens: new Map(again.ledger.tokens), problems: [...again.ledger.problems] }
    : { sources: new Map(), metrics: new Map(), tokens: new Map(), problems: [] }
  const read = new Set<string>()
  /** Tokens to ask again that this load has not asked yet. Their failed answers stay in the ledger until the new ones land. */
  const tokensAgain = new Set(again?.plan.tokens ?? [])
  const metricsAgain = new Set(again?.plan.metrics ?? [])
  const pendingTokens = new Set<string>()
  const unbound: string[] = []
  /** Whether a read row may stand: it binds to its entry, or nothing asks. A row that does not is dropped here, before it is ever shown. */
  const bound = (poolId: string, pool: VerifiedPool) => {
    options.seen?.set(key(poolId), pool)
    if (!options.binds || options.binds(poolId, pool)) return true
    if (!unbound.includes(key(poolId))) unbound.push(key(poolId))
    return false
  }
  /** Pools whose figures the producer is about to collect, while the provider will ask again for them. */
  const figuresBehind = new Set<string>()
  // Every read of the table goes before any queued read that did not ask first: a Markets card's history, say. A
  // refresh of rows already settled on screen does not (changed 2026-09-28, speed wave, item 11): its catch-up asks
  // jumped ahead of the next page's reads and spent its budget first.
  const asked = options.inPlace ? { signal } : { signal, priority: 'first' as const }

  const setProblem = (problem: MarketProblem) => {
    const at = ledger.problems.findIndex((p) => problemKey(p) === problemKey(problem))
    if (at === -1) ledger.problems.push(problem)
    else ledger.problems[at] = problem
  }
  const dropProblem = (problem: Omit<MarketProblem, 'outcome'> & { route: string }) => {
    const wanted = problem.token ? `token:${problem.token}` : `${problem.route}:${key(problem.poolId)}`
    ledger.problems = ledger.problems.filter((p) => problemKey(p) !== wanted)
  }

  /** A row's token reads, by lowercase address: this ledger's, or metadata kept from an earlier load. */
  const tokensFor = (row: RowSource) => {
    const tokens = new Map<string, ReadOutcome<'token'>>()
    for (const address of currenciesOf(row).map(key)) {
      const outcome = ledger.tokens.get(address) ?? options.tokens?.get(address)
      if (outcome) tokens.set(address, outcome)
    }
    return tokens
  }
  /** Every row known so far, in table order. Until the load has settled, a row with a token still to read says so. */
  const rows = (settled: boolean): Market[] =>
    poolIds.flatMap((poolId) => {
      const row = ledger.sources.get(key(poolId))
      if (!row) return []
      const tokens = tokensFor(row)
      const reads = { metrics: ledger.metrics.get(key(poolId)) ?? null, tokens }
      const projected = row.kind === 'market' ? projectMarketRow({ market: row.outcome, ...reads }) : projectSnapshotRow({ snapshot: row.outcome, entry: row.entry, ...reads })
      const pending = (!settled && tokens.size < new Set(currenciesOf(row).map(key)).size) || currenciesOf(row).some((address) => pendingTokens.has(key(address)))
      const waiting = figuresBehind.has(key(poolId))
      return [pending || waiting ? { ...projected, ...(pending ? { tokensPending: true as const } : {}), ...(waiting ? { figuresPending: true as const } : {}) } : projected]
    })
  const emit = () => onProgress?.(rows(false))
  const finish = (blocking: FailedOutcome | null, aborted = false): Load => ({ rows: rows(true), problems: ledger.problems, blocking, aborted, ledger, read, unbound })

  /** Whether this load reads a token: asked again and not read again yet, or neither read nor kept. */
  const wanted = (address: string) => tokensAgain.has(address) || (!ledger.tokens.has(address) && !options.tokens?.has(address))

  async function readToken(poolId: string, currency: string): Promise<Load | null> {
    const address = key(currency)
    tokensAgain.delete(address)
    const outcome = await source.read('token', { token: currency }, asked)
    if (outcome.state === 'aborted') return finish(null, true)
    ledger.tokens.set(address, outcome)
    dropProblem({ poolId, token: address, route: 'token' })
    if (outcome.state !== 'ok') {
      if (isPageWide(outcome)) return finish(outcome)
      // The first pool that needed it carries the problem; a pool sharing the token shows it unread.
      setProblem({ poolId, token: address, outcome })
    } else if (outcome.data.asset.readStatus === 'available') {
      options.tokens?.set(address, outcome)
    }
    // Read or given up on, the token has settled, and the rows that wait for it with it.
    emit()
    return null
  }

  /** The tokens one row still needs, in its currencies' order. */
  async function readTokensOf(poolId: string): Promise<Load | null> {
    const row = ledger.sources.get(key(poolId))
    if (!row) return null
    for (const currency of currenciesOf(row)) {
      if (!wanted(key(currency))) continue
      const stopped = await readToken(poolId, currency)
      if (stopped) return stopped
    }
    return null
  }

  if (poolIds.length === 0) return finish(null)

  // The stored overview includes metadata and V2 estimates in one bounded
  // response. Once advertised, a data failure is its own answer, never an
  // excuse to fan out provider reads. Older deployments keep the V1/V2 path.
  if (!again && options.overview && source.supportsStoredReads && source.routeEnabled && poolIds.length <= 24) {
    const early = options.overviewCheck
    options.overviewCheck = undefined
    const check = await (early ?? source.routeEnabled('overview', { signal }))
    if (check.state === 'failed') {
      if (check.outcome.state === 'aborted') return finish(null, true)
      if (stopsTable(check.outcome)) return finish(check.outcome)
      for (const poolId of poolIds) setProblem({ poolId, outcome: check.outcome })
      return finish(null)
    } else if (check.state === 'enabled') {
      const overview = await source.read('overview', { poolIds: poolIds.map(key) }, asked)
      if (overview.state === 'aborted') return finish(null, true)
      if (overview.state !== 'ok') {
        if (stopsTable(overview)) return finish(overview)
        for (const poolId of poolIds) setProblem({ poolId, outcome: overview })
        return finish(null)
      }
      // An answer with no pool at all for the pools asked (production, 2026-10-01: 330 bytes, pools []) says nothing
      // about them: the rows stay as they were, the copy of the last overview is kept, and it is asked again soon.
      if (overview.data.pools.length === 0) return { ...finish(null), stored: true, empty: true }
      for (const entry of overview.data.tokens) {
        const outcome = storedTokenRead(entry, overview.data.generatedAt, overview.provenance)
        if (!outcome) { if (entry.acquisition.status === 'pending') pendingTokens.add(key(entry.address)); continue }
        ledger.tokens.set(key(entry.address), outcome)
        if (outcome.data.asset.readStatus === 'available') options.tokens?.set(key(entry.address), outcome)
      }
      for (const entry of overview.data.pools) {
        const outcome = storedPoolRead(entry, overview.data.generatedAt, overview.provenance)
        if (!outcome || !bound(entry.poolId, outcome.data.pool)) continue
        ledger.sources.set(key(entry.poolId), { kind: 'market', outcome })
        read.add(key(entry.poolId))
      }
      // Pools served without their provider figures that are coming (see the header): this very request marked them
      // wanted. Their rows wait for the figures instead of calling them unavailable where the provider will ask again
      // in time; the others say what they have.
      const behind: string[] = []
      let soonest: number | null = null
      options.coming?.clear()
      for (const entry of overview.data.pools) {
        const inMs = catchUpInMs(entry, overview.data.generatedAt)
        if (inMs === null || unbound.includes(key(entry.poolId))) continue
        behind.push(key(entry.poolId))
        const wait = options.catchUp?.(entry, inMs)
        if (!wait) continue
        options.coming?.add(key(entry.poolId))
        if (wait === 'shown') figuresBehind.add(key(entry.poolId))
        soonest = soonest === null ? inMs : Math.min(soonest, inMs)
      }
      emit()
      const waiting = [...overview.data.pools, ...overview.data.tokens].filter((entry) => entry.acquisition.status === 'pending')
      // The soonest any pending entry will be tried, so one slow row never holds the others.
      const due = waiting.map((entry) => entry.acquisition.nextAttemptAt).filter((at): at is number => typeof at === 'number')
      return {
        ...finish(null), stored: true, overview,
        acquiring: waiting.length > 0,
        acquisitionRunning: waiting.some((entry) => entry.acquisition.refreshing),
        acquisitionInMs: due.length ? Math.max(0, Math.min(...due) - overview.data.generatedAt) * 1000 : null,
        catchUpInMs: soonest,
        behind,
        placeholders: [...figuresBehind].filter((id) => !ledger.sources.has(id)),
      }
    }
  }

  // 1. The stored snapshot, when listed and not failing lately. A quiet re-ask never asks it.
  let markets: readonly string[] = again ? poolIds.filter((poolId) => again.plan.markets.includes(key(poolId))) : poolIds
  const memo = options.snapshot
  if (!again && memo && source.routeEnabled && poolIds.length <= SNAPSHOT_MAX_POOLS && memo.allows()) {
    const check = await source.routeEnabled('markets-snapshot', { signal })
    if (check.state === 'failed') {
      if (check.outcome.state === 'aborted') return finish(null, true)
      // What the table's first read would have met, said for the pools as it always was, after one capabilities GET.
      // Anything else, a hop refusing the GET included, is the snapshot not listed: the pools' own reads ask again.
      if (stopsTable(check.outcome)) return finish(reroute(check.outcome, 'pool-market'))
    } else if (check.state === 'enabled') {
      const snapshot = await source.read('markets-snapshot', { poolIds: poolIds.map(key) }, asked)
      if (snapshot.state === 'aborted') return finish(null, true)
      if (snapshot.state === 'ok') {
        memo.succeeded()
        const plan = planSnapshot(snapshot.data, poolIds)
        for (const [poolId, entry] of plan.entries) {
          if (!bound(poolId, entry.pool)) continue
          ledger.sources.set(poolId, { kind: 'snapshot', outcome: snapshot, entry })
          read.add(poolId)
        }
        markets = plan.refresh
        if (ledger.sources.size > 0) emit()
      } else {
        // Never shown or said: the pools are read on demand instead, and the snapshot is left alone for a while.
        memo.failed()
      }
    }
  }

  // 2. Token metadata for the stored rows already on screen.
  if (!again) {
    for (const poolId of poolIds) {
      const stopped = await readTokensOf(poolId)
      if (stopped) return stopped
    }
  }

  // 3. The pools' own market reads, each row's tokens right after it.
  for (const poolId of markets) {
    const market = await source.read('pool-market', tableMarketRequest(poolId), asked)
    if (market.state === 'aborted') return finish(null, true)
    if (market.state !== 'ok') {
      if (stopsTable(market)) return finish(market)
      // Switched off on the server, so for every pool: with nothing on screen that stops the table;
      // rows already on screen stay, beside the reason.
      if (market.state === 'disabled' && ledger.sources.size === 0) return finish(market)
      setProblem({ poolId, outcome: market })
      if (market.state === 'disabled') break
      continue
    }
    dropProblem({ poolId, route: 'pool-market' })
    if (!bound(poolId, market.data.pool)) continue
    ledger.sources.set(key(poolId), { kind: 'market', outcome: market })
    read.add(key(poolId))
    // The row now, named from the catalogue until its tokens land right after it.
    emit()
    const stopped = await readTokensOf(poolId)
    if (stopped) return stopped
  }

  // 4. Tokens asked again that no row read again above. Each leaves the set as it is read: deleting the entry
  //    being visited is safe while iterating a Set.
  for (const address of tokensAgain) {
    const owner = poolIds.find((poolId) => {
      const row = ledger.sources.get(key(poolId))
      return row !== undefined && currenciesOf(row).some((currency) => key(currency) === address)
    })
    const row = owner === undefined ? undefined : ledger.sources.get(key(owner))
    const currency = row ? currenciesOf(row).find((c) => key(c) === address) : undefined
    if (owner === undefined || currency === undefined) {
      // No row needs it any more.
      tokensAgain.delete(address)
      dropProblem({ poolId: owner ?? '', token: address, route: 'token' })
      continue
    }
    const stopped = await readToken(owner, currency)
    if (stopped) return stopped
  }

  // 5. Domino's own 24h history for each row, when the deployment lists it: every row in a load; in a quiet
  //    re-ask, the reads asked again and the rows that came back without one.
  const history = poolIds.filter((poolId) => {
    const id = key(poolId)
    if (!ledger.sources.has(id)) return false
    return !again || metricsAgain.has(id) || (read.has(id) && !ledger.metrics.has(id))
  })
  if (options.metrics && source.routeEnabled && history.length > 0) {
    const check = await source.routeEnabled('pool-metrics', { signal })
    if (check.state === 'failed') {
      if (check.outcome.state === 'aborted') return finish(null, true)
      // As at the snapshot's check: a hop refusing the GET is the route not listed, and the rows stay.
      if (stopsTable(check.outcome)) return finish(check.outcome)
    } else if (check.state === 'enabled') {
      for (const poolId of history) {
        const outcome = await source.read('pool-metrics', { poolId }, asked)
        if (outcome.state === 'aborted') return finish(null, true)
        // Only the page stops the load here. Any other answer, a payload refused as incompatible included, is this row's.
        if (outcome.state !== 'ok' && isPageWide(outcome)) return finish(outcome)
        // Switched off on the server after all: as if it were not listed, for every row.
        if (outcome.state === 'disabled') break
        // A busy service is asked again on its own, this read alone (recoverQuietly); any other failure, a hop's
        // refusal included, keeps the provider's figures and says why in the row's title only.
        dropProblem({ poolId, route: 'pool-metrics' })
        if (outcome.state === 'busy') setProblem({ poolId, outcome })
        ledger.metrics.set(key(poolId), outcome)
        read.add(key(poolId))
        emit()
      }
    }
  }

  return finish(null)
}

/**
 * The reads behind the table, strictly one after another, in the order the
 * header describes: each starts once the one before it has settled, so a
 * page-wide answer stops the rest, and a disabled pool-market route, which is
 * disabled for every pool, stops them too. A token shared by several pools is
 * read once for the whole table. `onProgress` has every row known so far, in
 * table order, after each read that adds or changes one.
 */
export async function loadSelectedPools(
  source: ReadSource,
  poolIds: readonly string[],
  signal?: AbortSignal,
  onProgress?: (rows: Market[]) => void,
  options: LoadOptions = {},
): Promise<LoadedMarkets> {
  const { rows, problems, blocking, aborted } = await readMarkets(source, poolIds, signal, onProgress, options)
  return { rows, problems, blocking, aborted }
}

/**
 * A list of pools that can change while the page is open (bridgeMarkets.ts: the featured pools list,
 * lib/read/featuredList.ts). The provider asks it to bring itself up to date before each load, the first and every
 * refresh (never a quiet re-ask), reads the pools it names then, drops a row whose read does not bind to its entry,
 * and follows the list when it changes between loads: pools that left it leave the rows at once, and a list with new
 * pools is read.
 */
export interface PoolList {
  /** The pools on screen now, in the order the rows keep. */
  ids(): readonly string[]
  /** Brings the list up to date: its first read (`first`), or a refresh's. Never rejects. */
  update(first: boolean, signal: AbortSignal): Promise<unknown>
  /** Whether a pool's own read matches the list's entry for it. */
  binds(poolId: string, pool: VerifiedPool): boolean
  /** Rows whose read did not bind: the list lets them go. */
  unbind(poolIds: readonly string[]): void
  /** Word when the pools on screen change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export interface ReadMarketsOptions {
  source: ReadSource
  /** The pools to read, in the order the rows keep; with `pools`, only until the list answers. */
  poolIds: readonly string[]
  /** A list of pools that can change (PoolList). Absent: `poolIds`, fixed. */
  pools?: PoolList
  kind: 'fixture' | 'bridge'
  /** Shown beside the rows: the fixture build says they are fixtures. */
  notice?: string
  now?: () => number
  /** The monotonic clock the snapshot's retry wait is counted on: the clock's unless a test gives its own. */
  monotonic?: () => number
  /** The timers and jitter of the leave grace and the quiet re-asks, and the clocks `now` and `monotonic` default to. */
  clock?: Clock
  /** Whether the page can be seen, for the quiet re-asks: the document's unless a test gives its own. */
  visibility?: PageVisibility
  /** Successful visible data is revalidated at this interval; zero keeps a
   * diagnostic/fixture provider manually driven. Failures back off to 8x. */
  refreshMs?: number
  /** This browser's copy of the last overview (marketsPaint.ts): the deployable build's table only. */
  paint?: PaintMemory
}

/** A stored load that read nothing is asked again this long after, then three times longer each time, up to eight refreshes. */
export const FAILED_RETRY_MS = 5_000

export function createReadMarketsProvider({ source, poolIds: initialIds, pools, kind, notice, now, monotonic, clock = realClock, visibility = documentVisibility, refreshMs = 0, paint }: ReadMarketsOptions): MarketsProvider {
  /** The pools read now, in row order: `initialIds`, or the list's (`pools`) as it changes. */
  let poolIds: readonly string[] = pools ? pools.ids() : initialIds
  /**
   * When the list was last brought up to date (monotonic), null before its first answer is asked for. A load asks it
   * again only once a whole refresh interval has passed: a catch-up for figures that are coming, seconds after the
   * last load, reads the markets alone.
   */
  let listedAt: number | null = null
  const listEveryMs = refreshMs > 0 ? refreshMs : 60_000
  /** While a load brings the list up to date: its own changes are read by that load, not followed here. */
  let updating = false
  /** The list gained pools while a load ran for the old ones: read again once it settles. */
  let reloadAfter = false
  const wall = now ?? (() => clock.now())
  const steady = monotonic ?? (() => clock.monotonic())
  const resultOf = (markets: Market[]): MarketsResult => ({ source: kind === 'bridge' ? 'live' : kind, chainId: 4663, network: 'Robinhood Chain', markets, notice })

  let state: MarketsState = { phase: 'loading', previous: null, retrying: null }
  let controller: AbortController | null = null
  /** The read running: a load, or a quiet re-ask with the settled state it started from. */
  let running: { kind: 'load' } | { kind: 'again' | 'refresh'; from: MarketsState } | null = null
  let started = false
  /** The last settled load's reads, unless a page-wide answer ended it: what a quiet re-ask starts from. */
  let ledger: Ledger | null = null
  /** Each pool's last good row, and when the load that read it settled. */
  const kept = new Map<string, { row: Market; receivedAt: number }>()
  const listeners = new Set<() => void>()
  // Kept for the provider's life, which is the page's: token metadata that read as available, and
  // when the snapshot last failed. Both in memory only. Optional routes are used where they are listed.
  const memory: LoadOptions = { tokens: new Map(), snapshot: createSnapshotMemo(steady), metrics: true, overview: true, seen: new Map(), coming: new Set() }
  let cancelGrace: (() => void) | null = null
  // This browser's copy of the last overview (marketsPaint.ts): its rows stand until the first answer, as old as they
  // are and waiting where they have no figure, and its pools are the first ones asked.
  const copy = paint?.load() ?? null
  // Past its 15 minutes and up to a day, the copy still names the pools to read beside the list's first read, and shows
  // nothing (audit A7 a, 2026-10-01; marketsPaint.ts `prefetch`).
  const ahead = copy === null && pools ? (paint?.prefetch?.() ?? null) : null
  /** The copy's rows are on screen, and a load keeps them as they are until it settles. */
  let painting = copy !== null
  if (copy) {
    const rows = overviewRows(copy, (poolId, pool) => (memory.seen!.set(key(poolId), pool), !pools || pools.binds(poolId, pool)))
    for (const row of rows) kept.set(key(row.poolId), { row, receivedAt: copy.provenance.receivedAt })
    if (pools) poolIds = copy.data.requestedPoolIds
    state = { phase: 'loading', previous: resultOf(rows.map((row) => ({ ...row, figuresPending: true as const }))), retrying: null }
  } else if (ahead) poolIds = ahead
  /** Loads in a row that read nothing, for the wait before the next (FAILED_RETRY_MS). */
  let emptyLoads = 0
  /** The last settled load read the stored overview: its busy provider rows are asked again through it (speed wave, item 2). */
  let lastStored = false

  // The quiet re-asks: how many this visit, and when the next is due, on the monotonic clock their timers run on.
  let holders = 0
  let recoveryAttempts = 0
  let recoveryDueAt: number | null = null
  const providerBusy = new Map<string, { attempts: number; dueAt: number | null }>()
  let cancelTimer: (() => void) | null = null
  let cancelVisible: (() => void) | null = null
  let cancelRefreshVisibility: (() => void) | null = null
  let refreshDueAt: number | null = null
  let refreshFailures = 0
  /**
   * The pools whose figures are coming (see the header), by lowercase id: when this page first saw each behind (the
   * answer's arrival, monotonic), the store's observation of it then, and whether its row has stopped waiting.
   */
  const behindSince = new Map<string, { since: number; observedAt: number | null; over: boolean }>()
  /** Catch-up asks in a row; each waits at least CATCH_UP_BACKOFF times as long as the one before. */
  let catchUpAsks = 0
  // The same interval for stored and live loads (changed 2026-09-24): a settled
  // stored overview used to be asked again every 5 s, about eleven extra reads a
  // minute through the tab's one queue and its 30-a-minute budget, ahead of the
  // Markets cards. A load still acquiring keeps its own 5 s floor below.
  const activeRefreshMs = refreshMs

  /** Never ask faster than this, whatever the producer's schedule says. */
  const ACQUISITION_FLOOR_MS = 5000
  /** The wait before the next catch-up ask, for a collection `inMs` away in server time. */
  const catchUpIntervalMs = (inMs: number) => Math.max(Math.round(CATCH_UP_FLOOR_MS * CATCH_UP_BACKOFF ** catchUpAsks), inMs + CATCH_UP_MARGIN_MS)

  /**
   * Whether a behind pool's row waits for its figures (LoadOptions.catchUp), asked as its answer arrives: not once
   * a collection published since it began waiting brought none (unless the provider was busy or rate limited for
   * it: the next collection may bring them; changed 2026-09-28), nor when the ask that would bring them falls past
   * CATCH_UP_WINDOW_MS from the answer it began waiting with, or at the ordinary refresh, nor while no screen holds
   * the quiet re-asks. It shows a placeholder only while that ask falls within CATCH_UP_SHOWN_MS.
   */
  const catchUpWaits = (entry: StoredPool, inMs: number): 'shown' | 'asked' | false => {
    // Only a screen holding the quiet re-asks (the table) has this provider ask again on its own.
    if (holders === 0) return false
    const id = key(entry.poolId)
    const at = clock.monotonic()
    const seen = behindSince.get(id)
    if (seen?.over) return false
    const collected = seen !== undefined && (entry.observedAt ?? -1) > (seen.observedAt ?? -1) && !(entry.value && providerWasBusy(entry.value.market.market))
    const since = seen?.since ?? at
    const interval = catchUpIntervalMs(inMs)
    const over = collected || interval >= activeRefreshMs || at - since + interval > CATCH_UP_WINDOW_MS
    behindSince.set(id, { since, observedAt: seen ? seen.observedAt : entry.observedAt, over })
    // Stale figures remain visible with their original ages while an imminent collection is read again. Never turn
    // a valid old figure into a loading mask, extend its usable lifetime, or poll beyond the existing catch-up window.
    if (!over && entry.value?.market.market.status === 'stale') return 'asked'
    return over ? false : at - since + interval <= CATCH_UP_SHOWN_MS ? 'shown' : 'asked'
  }

  const nextRefresh = (failed: boolean, hasData: boolean, acquiring = false, schedule?: { inMs: number | null; running: boolean }, catchUp: number | null = null) => {
    if (refreshMs <= 0 || (!hasData && !acquiring)) { refreshDueAt = null; return }
    refreshFailures = failed ? Math.min(refreshFailures + 1, 3) : 0
    // While acquiring, the producer publishes when it will try again; use that
    // instead of a guess. A lease in flight means the published time is already
    // past, so fall to the floor. Bounded by the ordinary interval either way,
    // so a row backed off for an hour does not park a timer for an hour.
    const acquisitionMs = schedule?.running || schedule?.inMs == null
      ? ACQUISITION_FLOOR_MS
      : Math.min(activeRefreshMs, Math.max(ACQUISITION_FLOOR_MS, schedule.inMs))
    // Rows waiting for figures are asked again just after the producer's collection (catchUpIntervalMs), not a
    // minute later, whatever else is due.
    const interval = acquiring ? Math.min(acquisitionMs, catchUp ?? Infinity) : catchUp ?? activeRefreshMs * 2 ** refreshFailures
    refreshDueAt = clock.monotonic() + interval * (1 + clock.random() * 0.1)
  }

  const set = (next: MarketsState) => {
    state = next
    if (next.phase !== 'loading') painting = false
    for (const listener of listeners) listener()
    if (next.phase !== 'loading') plan()
  }

  /** A row whose figures are coming, with the ones this page last had for its pool where it has none (keepFigures). */
  const withKept = (row: Market) => {
    const good = (row.figuresPending || memory.coming!.has(key(row.poolId))) && kept.get(key(row.poolId))
    return good ? keepFigures(row, good.row, good.receivedAt) : row
  }

  /** Every pool's kept row, stale and dated, in table order; null when none was ever read. */
  function retained(): Retained | null {
    let receivedAt = -Infinity
    const markets = poolIds.flatMap((poolId) => {
      const good = kept.get(key(poolId))
      if (!good) return []
      receivedAt = Math.max(receivedAt, good.receivedAt)
      return [retainRowAsStale(good.row, good.receivedAt)]
    })
    return markets.length > 0 ? { result: resultOf(markets), receivedAt } : null
  }

  /**
   * The rows to keep on screen while a read runs. Only a refresh of rows that
   * are current right now keeps them as they are. Rows retained after a
   * failure, or left over from a read that nobody waited for, stay stale and
   * dated: a retry is not a new observation.
   */
  function rowsWhileLoading(): MarketsResult | null {
    if (state.phase === 'ready') return state.result
    if (state.phase === 'failed') return state.retained?.result ?? null
    if (controller || painting) return state.previous
    return retained()?.result ?? null
  }

  async function run(again?: RecoveryPlan, background = false) {
    const from = state
    const quiet = again !== undefined && ledger !== null
    // A quiet re-ask of settled rows keeps them settled: rows land in place, and nothing else on the page moves.
    const inPlace = (quiet || background) && from.phase === 'ready'
    const previous = rowsWhileLoading()
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    running = quiet ? { kind: 'again', from } : background ? { kind: 'refresh', from } : { kind: 'load' }
    stopTimer()
    // Metadata retained by the provider follows the shared public cache's
    // maximum age too; refreshing a row cannot make stale decimals eternal.
    for (const [address, read] of memory.tokens ?? []) {
      const at = read.provenance.receivedMonotonic
      const age = at === undefined ? wall() - read.provenance.receivedAt : steady() - at
      if (age >= TOKEN_METADATA_CACHE_MS || age < 0) memory.tokens?.delete(address)
    }
    const retrying = from.phase === 'failed' ? from.failure : from.phase === 'loading' ? from.retrying : null
    if (!inPlace) set({ phase: 'loading', previous, retrying })
    // Rows whose figures are coming wait for them only where this provider asks again on its own.
    memory.catchUp = refreshMs > 0 ? catchUpWaits : undefined
    // A check asked for a load that never read (cancelled while it waited for the list) is never another load's.
    memory.overviewCheck = undefined
    memory.inPlace = inPlace
    if (pools) {
      // The list (featured pools v1 §11.1): its answer, then the markets of its pools. With this browser's copy of the
      // last overview, the page's first load does not wait: it reads the pools the copy names (the list this browser
      // last saw) beside the list's first read, and follows the list once it answers (followList). Without one it waits
      // for the list, never reading pools the list may not name, with the capabilities asked meanwhile.
      const first = listedAt === null
      const beside = first && (copy !== null || ahead !== null)
      if (!quiet && (first || clock.monotonic() - (listedAt ?? 0) >= listEveryMs)) {
        listedAt = clock.monotonic()
        const update = pools.update(first, mine.signal)
        if (!beside) {
          if (first && memory.overview && source.supportsStoredReads && source.routeEnabled) memory.overviewCheck = source.routeEnabled('overview', { signal: mine.signal })
          updating = true
          try {
            await update
          } finally {
            updating = false
          }
          if (mine.signal.aborted || controller !== mine) return
        }
      }
      if (!beside) poolIds = pools.ids()
      memory.binds = (poolId, pool) => pools.binds(poolId, pool)
    }
    const loaded = await readMarkets(
      source,
      poolIds,
      mine.signal,
      (rows) => {
        if (mine.signal.aborted || controller !== mine) return
        const updated = new Map(rows.map((row) => [key(row.poolId), row]))
        const markets = poolIds.flatMap((poolId) => {
          const read = updated.get(key(poolId))
          const row = read ? withKept(read) : previous?.markets.find((m) => key(m.poolId) === key(poolId))
          return row ? [row] : []
        })
        set(inPlace && from.phase === 'ready' ? { ...from, result: resultOf(markets) } : { phase: 'loading', retrying, previous: resultOf(markets) })
      },
      memory,
      quiet && ledger && again ? { ledger, plan: again } : undefined,
    )
    if (mine.signal.aborted || controller !== mine) return
    controller = null
    running = null
    if (loaded.blocking) {
      // Never asked again on its own: nothing a quiet re-ask could start from.
      ledger = null
      // Auth/config/contract failures require a new page decision. Do not
      // keep polling behind an expired gate or a disabled deployment.
      refreshDueAt = null
      set({ phase: 'failed', failure: loaded.blocking, retained: retained() })
      return
    }
    ledger = loaded.ledger
    if (!quiet) lastStored = loaded.stored === true
    const at = wall()
    const rows = loaded.rows.map(withKept)
    for (const row of rows) {
      const id = key(row.poolId)
      kept.set(id, { row, receivedAt: loaded.read.has(id) ? at : (kept.get(id)?.receivedAt ?? at) })
    }
    // An empty overview (audit V1): every pool keeps its last good row, stale and dated, as below, and the overview is
    // asked again soon, as after one that read nothing.
    if (loaded.empty && !quiet) refreshDueAt = refreshMs > 0 ? clock.monotonic() + Math.min(FAILED_RETRY_MS * 3 ** emptyLoads++, refreshMs * 8) : null
    const failure = rows.length === 0 && loaded.problems.length > 0 ? loaded.problems[0].outcome : null
    if (failure) {
      // Nothing read from the stored overview (one read for every row): asked again soon, then less and less often
      // (FAILED_RETRY_MS), while the page can be seen. A lean load is a read per pool on the provider's lane, and its
      // failures keep their rule: a reload asks again.
      if (!quiet && failure.route === 'overview') refreshDueAt = refreshMs > 0 ? clock.monotonic() + Math.min(FAILED_RETRY_MS * 3 ** emptyLoads++, refreshMs * 8) : null
      else if (!quiet) nextRefresh(true, kept.size > 0)
      set({ phase: 'failed', failure, retained: retained() })
      settledLoad(loaded.unbound)
      return
    }
    if (!loaded.empty) emptyLoads = 0
    if (!quiet && loaded.overview) paint?.save(loaded.overview)
    // A pool with no row from these reads keeps its last good one, stale and dated, in its place.
    const markets = poolIds.flatMap((poolId) => {
      const row = rows.find((m) => key(m.poolId) === key(poolId))
      if (row) return [row]
      const good = kept.get(key(poolId))
      return good ? [retainRowAsStale(good.row, good.receivedAt)] : []
    })
    // A pool waits afresh the next time it is behind only once it has caught up (its own figures came back); a
    // catch-up is asked while rows wait. Changed 2026-09-27 (r6/marketsdata): a pool merely not behind in one answer
    // (its next collection a little further off) used to wait afresh at every minute, a placeholder coming back each time.
    if (loaded.behind) {
      for (const id of behindSince.keys()) {
        const row = rows.find((m) => key(m.poolId) === id)
        const caughtUp = row !== undefined && !loaded.behind.includes(id) && (row.tvlUsd.state !== 'unavailable' || row.volume24hUsd.state !== 'unavailable')
        if (caughtUp) behindSince.delete(id)
      }
    }
    const catchUp = !quiet && loaded.catchUpInMs != null ? catchUpIntervalMs(loaded.catchUpInMs) : null
    if (!quiet) catchUpAsks = catchUp === null ? 0 : catchUpAsks + 1
    if (!quiet && !loaded.empty) nextRefresh(loaded.problems.length > 0, markets.length > 0, loaded.acquiring, { inMs: loaded.acquisitionInMs ?? null, running: loaded.acquisitionRunning === true }, catchUp)
    set({ phase: 'ready', result: resultOf(markets), problems: loaded.problems, ...(loaded.acquiring ? { acquiring: true } : {}), ...(loaded.placeholders?.length ? { placeholders: loaded.placeholders } : {}) })
    settledLoad(loaded.unbound)
  }

  /** After a load settles: rows that did not bind leave the list, and a list that gained pools meanwhile is read. */
  function settledLoad(unbound: readonly string[]) {
    if (pools && unbound.length > 0) pools.unbind(unbound)
    if (!reloadAfter || controller) return
    reloadAfter = false
    void run(undefined, state.phase === 'ready')
  }

  /**
   * The list changed: pools that left it leave the rows now; a list with new pools is read, at once when the first
   * load is still out for other pools. A pool read before the list answered that the list now names as another pool
   * leaves the list.
   */
  function followList() {
    if (!pools || updating) return
    const stray = [...memory.seen!].flatMap(([id, pool]) => (pools.binds(id, pool) ? [] : [id]))
    if (stray.length > 0) {
      // Let go before the list is told: its change calls this again.
      for (const id of stray) memory.seen!.delete(id)
      pools.unbind(stray)
    }
    const next = pools.ids()
    if (next.map(key).join() === poolIds.map(key).join()) return
    const was = new Set(poolIds.map(key))
    const removals = next.every((id) => was.has(key(id)))
    poolIds = next
    if (controller) {
      // A load running for the old pools maps its rows through `poolIds` as they land; new pools need a load of their own.
      if (!removals && running?.kind === 'load') void run()
      else if (!removals) reloadAfter = true
      return
    }
    if (!started) return
    if (removals && state.phase === 'ready') {
      const wanted = new Set(next.map(key))
      set({ ...state, result: resultOf(state.result.markets.filter((row) => wanted.has(key(row.poolId)))) })
      return
    }
    void run(undefined, state.phase === 'ready')
  }
  pools?.subscribe(followList)

  function stopTimer() {
    cancelTimer?.()
    cancelTimer = null
    cancelVisible?.()
    cancelVisible = null
  }

  /**
   * What a busy service or a refusing hop kept from the last settled reads, and the longest wait asked for; null when
   * nothing. The rows of a failed load count too: a load whose pools were all refused has its reads here to ask again.
   */
  function recoverableParts(): { plan: RecoveryPlan; waitSeconds: number } | null {
    if (!ledger || state.phase === 'loading') return null
    const parts = ledger.problems.filter((p) => asksAgainQuietly(p.outcome))
    if (parts.length === 0) return null
    return {
      // A hop's refusal asks for no wait of its own: the least wait applies.
      waitSeconds: Math.max(0, ...parts.map((p) => (p.outcome.state === 'busy' ? p.outcome.retryAfterSeconds : 0))),
      plan: {
        markets: parts.filter((p) => !p.token && p.outcome.route === 'pool-market').map((p) => key(p.poolId)),
        tokens: parts.flatMap((p) => (p.token ? [p.token] : [])),
        metrics: parts.filter((p) => !p.token && p.outcome.route === 'pool-metrics').map((p) => key(p.poolId)),
      },
    }
  }

  /** The rows on screen whose provider figures are unavailable because the provider was busy or rate limited. */
  function providerBusyPools(): string[] {
    const reads = ledger
    if (!reads || state.phase !== 'ready') return []
    return poolIds.map(key).filter((id) => {
      const row = reads.sources.get(id)
      return row !== undefined && providerWasBusy(observationOf(row))
    })
  }

  /** Plans the next quiet re-ask from the settled state, while someone holds them and nothing is running. */
  function plan() {
    stopTimer()
    if (holders === 0 || controller) return
    const at = clock.monotonic()
    const parts = recoverableParts()
    if (!parts) {
      recoveryAttempts = 0
      recoveryDueAt = null
    } else if (recoveryDueAt === null && recoveryAttempts < BUSY_RECOVERY_ATTEMPTS) {
      recoveryDueAt = at + busyRecoveryDelayMs(parts.waitSeconds, recoveryAttempts, clock.random)
    }
    const waiting = new Set(providerBusyPools())
    for (const [id, entry] of providerBusy) if (!waiting.has(id)) entry.dueAt = null
    for (const id of waiting) {
      const entry = providerBusy.get(id) ?? { attempts: 0, dueAt: null }
      if (entry.dueAt === null && entry.attempts < PROVIDER_BUSY_ATTEMPTS) entry.dueAt = at + providerBusyDelayMs(clock.random)
      providerBusy.set(id, entry)
    }
    const due = [refreshDueAt, recoveryDueAt, ...[...providerBusy.values()].map((entry) => entry.dueAt)].filter((dueAt): dueAt is number => dueAt !== null)
    if (due.length === 0) return
    cancelTimer = clock.timer(Math.max(0, Math.min(...due) - at), askAgain)
  }

  /** Asks again what is due, in one quiet re-ask; while the page cannot be seen, the moment it can again. */
  function askAgain() {
    cancelTimer = null
    if (holders === 0 || controller) return
    if (visibility.hidden()) {
      cancelVisible = visibility.onChange(() => {
        if (visibility.hidden()) return
        cancelVisible?.()
        cancelVisible = null
        askAgain()
      })
      return
    }
    const at = clock.monotonic()
    // A full background revalidation also covers due recovery work. Running
    // both would duplicate provider reads and spend the same client budget.
    if (refreshDueAt !== null && refreshDueAt <= at) {
      refreshDueAt = null
      void run(undefined, true)
      return
    }
    const markets = new Set<string>()
    const tokens = new Set<string>()
    const metrics = new Set<string>()
    const parts = recoverableParts()
    if (parts && recoveryDueAt !== null && recoveryDueAt <= at) {
      for (const id of parts.plan.markets) markets.add(id)
      for (const address of parts.plan.tokens) tokens.add(address)
      for (const id of parts.plan.metrics) metrics.add(id)
      recoveryAttempts += 1
      recoveryDueAt = null
    }
    for (const [id, entry] of providerBusy) {
      if (entry.dueAt === null || entry.dueAt > at) continue
      markets.add(id)
      entry.attempts += 1
      entry.dueAt = null
    }
    if (markets.size + tokens.size + metrics.size === 0) {
      plan()
      return
    }
    // Rows the stored overview gave are asked again through it: one stored read for the table (about 65 ms), where a
    // pool's own market read is a provider read of about 4.9 s. Changed 2026-09-28 (speed wave, item 2).
    if (lastStored) {
      void run(undefined, true)
      return
    }
    void run({ markets: [...markets], tokens: [...tokens], metrics: [...metrics] })
  }

  return {
    kind,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      cancelGrace?.()
      cancelGrace = null
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || !controller || cancelGrace) return
        // Nobody is looking any more. Cancelled only if nobody comes back soon: the next screen joins the read.
        cancelGrace = clock.timer(LEAVE_GRACE_MS, () => {
          cancelGrace = null
          if (listeners.size > 0 || !controller) return
          const was = running
          controller.abort()
          controller = null
          running = null
          if (was?.kind === 'again' || was?.kind === 'refresh') {
            // A quiet re-ask nobody waited for is as if it had not run; the next visit plans it again.
            state = was.from
            if (was.kind === 'refresh') refreshDueAt = clock.monotonic()
            plan()
          } else {
            // A load nobody waited for starts again for the next viewer.
            started = false
          }
        })
      }
    },
    ensure() {
      if (started) return
      started = true
      void run()
    },
    refresh() {
      started = true
      void run()
    },
    recoverQuietly() {
      holders += 1
      if (holders === 1) {
        // A new visit, with its own re-asks.
        recoveryAttempts = 0
        recoveryDueAt = null
        providerBusy.clear()
        if (refreshMs > 0) cancelRefreshVisibility = visibility.onChange(() => {
          if (visibility.hidden() && running?.kind === 'refresh') {
            const from = running.from
            controller?.abort()
            controller = null
            running = null
            // Resume later with the original data still dated as observed.
            refreshDueAt = clock.monotonic()
            set(from)
          } else if (!visibility.hidden()) plan()
        })
        plan()
      }
      let held = true
      return () => {
        if (!held) return
        held = false
        holders -= 1
        if (holders === 0) {
          stopTimer()
          cancelRefreshVisibility?.()
          cancelRefreshVisibility = null
        }
      }
    },
  }
}
