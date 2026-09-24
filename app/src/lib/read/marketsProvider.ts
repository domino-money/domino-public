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
 *     visit for each pool.
 *
 * When the last viewer leaves while a read runs, it is cancelled 2 s later,
 * not at once: a screen that follows straight away (Home to Markets) joins it
 * instead of starting it over.
 */
import type { PoolMarketResponse, SnapshotPoolEntry } from 'api-contracts/read-v1/types'
import type { Market, MarketsResult, Metric } from '../markets'
import { createSnapshotMemo, planSnapshot, SNAPSHOT_MAX_POOLS, type SnapshotMemo } from './marketsSnapshot'
import { realClock, type Clock } from './pipeline'
import { TOKEN_METADATA_CACHE_MS } from './publicMetadataCache'
import { storedPoolRead, storedTokenRead } from './publicOverview'
import { projectMarketRow, projectSnapshotRow } from './project'
import { reroute, type FailedOutcome, type ReadOutcome, type ReadRequests, type ReadSource } from './types'

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
  | { phase: 'ready'; result: MarketsResult; problems: MarketProblem[]; acquiring?: boolean }
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

/** Provider figures missing only because the provider was busy or rate limited: a later read can bring them. */
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
  return {
    ...row,
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
      return [pending ? { ...projected, tokensPending: true as const } : projected]
    })
  const emit = () => onProgress?.(rows(false))
  const finish = (blocking: FailedOutcome | null, aborted = false): Load => ({ rows: rows(true), problems: ledger.problems, blocking, aborted, ledger, read })

  /** Whether this load reads a token: asked again and not read again yet, or neither read nor kept. */
  const wanted = (address: string) => tokensAgain.has(address) || (!ledger.tokens.has(address) && !options.tokens?.has(address))

  async function readToken(poolId: string, currency: string): Promise<Load | null> {
    const address = key(currency)
    tokensAgain.delete(address)
    const outcome = await source.read('token', { token: currency }, { signal })
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
    const check = await source.routeEnabled('overview', { signal })
    if (check.state === 'failed') {
      if (check.outcome.state === 'aborted') return finish(null, true)
      if (stopsTable(check.outcome)) return finish(check.outcome)
      for (const poolId of poolIds) setProblem({ poolId, outcome: check.outcome })
      return finish(null)
    } else if (check.state === 'enabled') {
      const overview = await source.read('overview', { poolIds: poolIds.map(key) }, { signal })
      if (overview.state === 'aborted') return finish(null, true)
      if (overview.state !== 'ok') {
        if (stopsTable(overview)) return finish(overview)
        for (const poolId of poolIds) setProblem({ poolId, outcome: overview })
        return finish(null)
      }
      for (const entry of overview.data.tokens) {
        const outcome = storedTokenRead(entry, overview.data.generatedAt, overview.provenance)
        if (!outcome) { if (entry.acquisition.status === 'pending') pendingTokens.add(key(entry.address)); continue }
        ledger.tokens.set(key(entry.address), outcome)
        if (outcome.data.asset.readStatus === 'available') options.tokens?.set(key(entry.address), outcome)
      }
      for (const entry of overview.data.pools) {
        const outcome = storedPoolRead(entry, overview.data.generatedAt, overview.provenance)
        if (!outcome) continue
        ledger.sources.set(key(entry.poolId), { kind: 'market', outcome })
        read.add(key(entry.poolId))
      }
      emit()
      const waiting = [...overview.data.pools, ...overview.data.tokens].filter((entry) => entry.acquisition.status === 'pending')
      // The soonest any pending entry will be tried, so one slow row never holds the others.
      const due = waiting.map((entry) => entry.acquisition.nextAttemptAt).filter((at): at is number => typeof at === 'number')
      return {
        ...finish(null), stored: true,
        acquiring: waiting.length > 0,
        acquisitionRunning: waiting.some((entry) => entry.acquisition.refreshing),
        acquisitionInMs: due.length ? Math.max(0, Math.min(...due) - overview.data.generatedAt) * 1000 : null,
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
      const snapshot = await source.read('markets-snapshot', { poolIds: poolIds.map(key) }, { signal })
      if (snapshot.state === 'aborted') return finish(null, true)
      if (snapshot.state === 'ok') {
        memo.succeeded()
        const plan = planSnapshot(snapshot.data, poolIds)
        for (const [poolId, entry] of plan.entries) {
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
    const market = await source.read('pool-market', tableMarketRequest(poolId), { signal })
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
    ledger.sources.set(key(poolId), { kind: 'market', outcome: market })
    read.add(key(poolId))
    dropProblem({ poolId, route: 'pool-market' })
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
        const outcome = await source.read('pool-metrics', { poolId }, { signal })
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

export interface ReadMarketsOptions {
  source: ReadSource
  /** The pools to read, in the order the rows keep. */
  poolIds: readonly string[]
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
}

export function createReadMarketsProvider({ source, poolIds, kind, notice, now, monotonic, clock = realClock, visibility = documentVisibility, refreshMs = 0 }: ReadMarketsOptions): MarketsProvider {
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
  const memory: LoadOptions = { tokens: new Map(), snapshot: createSnapshotMemo(steady), metrics: true, overview: true }
  let cancelGrace: (() => void) | null = null

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
  // The same interval for stored and live loads (changed 2026-09-24): a settled
  // stored overview used to be asked again every 5 s, about eleven extra reads a
  // minute through the tab's one queue and its 30-a-minute budget, ahead of the
  // Markets cards. A load still acquiring keeps its own 5 s floor below.
  const activeRefreshMs = refreshMs

  /** Never ask faster than this, whatever the producer's schedule says. */
  const ACQUISITION_FLOOR_MS = 5000
  const nextRefresh = (failed: boolean, hasData: boolean, acquiring = false, schedule?: { inMs: number | null; running: boolean }) => {
    if (refreshMs <= 0 || (!hasData && !acquiring)) { refreshDueAt = null; return }
    refreshFailures = failed ? Math.min(refreshFailures + 1, 3) : 0
    // While acquiring, the producer publishes when it will try again; use that
    // instead of a guess. A lease in flight means the published time is already
    // past, so fall to the floor. Bounded by the ordinary interval either way,
    // so a row backed off for an hour does not park a timer for an hour.
    const acquisitionMs = schedule?.running || schedule?.inMs == null
      ? ACQUISITION_FLOOR_MS
      : Math.min(activeRefreshMs, Math.max(ACQUISITION_FLOOR_MS, schedule.inMs))
    const interval = acquiring ? acquisitionMs : activeRefreshMs * 2 ** refreshFailures
    refreshDueAt = clock.monotonic() + interval * (1 + clock.random() * 0.1)
  }

  const set = (next: MarketsState) => {
    state = next
    for (const listener of listeners) listener()
    if (next.phase !== 'loading') plan()
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
    if (controller) return state.previous
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
    const problemsBefore = from.phase === 'ready' ? from.problems : []
    if (!inPlace) set({ phase: 'loading', previous, retrying })
    const loaded = await readMarkets(
      source,
      poolIds,
      mine.signal,
      (rows) => {
        if (mine.signal.aborted || controller !== mine) return
        const updated = new Map(rows.map((row) => [key(row.poolId), row]))
        const markets = poolIds.flatMap((poolId) => {
          const row = updated.get(key(poolId)) ?? previous?.markets.find((m) => key(m.poolId) === key(poolId))
          return row ? [row] : []
        })
        set(inPlace ? { phase: 'ready', result: resultOf(markets), problems: problemsBefore } : { phase: 'loading', retrying, previous: resultOf(markets) })
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
    const at = wall()
    for (const row of loaded.rows) {
      const id = key(row.poolId)
      kept.set(id, { row, receivedAt: loaded.read.has(id) ? at : (kept.get(id)?.receivedAt ?? at) })
    }
    const failure = loaded.rows.length === 0 && loaded.problems.length > 0 ? loaded.problems[0].outcome : null
    if (failure) {
      if (!quiet) nextRefresh(true, kept.size > 0)
      set({ phase: 'failed', failure, retained: retained() })
      return
    }
    // A pool with no row from these reads keeps its last good one, stale and dated, in its place.
    const markets = poolIds.flatMap((poolId) => {
      const row = loaded.rows.find((m) => key(m.poolId) === key(poolId))
      if (row) return [row]
      const good = kept.get(key(poolId))
      return good ? [retainRowAsStale(good.row, good.receivedAt)] : []
    })
    if (!quiet) nextRefresh(loaded.problems.length > 0, markets.length > 0, loaded.acquiring, { inMs: loaded.acquisitionInMs ?? null, running: loaded.acquisitionRunning === true })
    set({ phase: 'ready', result: resultOf(markets), problems: loaded.problems, ...(loaded.acquiring ? { acquiring: true } : {}) })
  }

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
