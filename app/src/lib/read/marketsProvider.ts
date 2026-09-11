/**
 * Where the Top pools table and the ticker get their rows.
 *
 * Components depend on this interface, never on a read source directly. The
 * default build uses `sampleMarkets`: today's curated, labelled sample rows,
 * ready on the first render, with no request behind them. Fixture and bridge
 * builds use `createReadMarketsProvider`, which builds rows from three reads
 * per pool (pool-market, pool-metrics and each currency's token metadata).
 *
 * The curated sample is deliberately not dressed up as contract payloads: that
 * would mean inventing GeckoTerminal provenance, snapshots and cache ages for
 * figures nobody observed. Both providers meet at the view-model level.
 *
 * A read provider is a small store shared by every component on a screen, so
 * the ticker and the table cost one set of reads. When a refresh fails, the
 * last good rows stay on screen dated and marked stale, beside the reason,
 * as docs/API_COMPATIBILITY.md asks. A failed payload itself is never shown.
 */
import { listMarkets, type Market, type MarketsResult, type Metric } from '../markets'
import { projectMarketRow } from './project'
import { PRODUCER_PIN } from './pin'
import type { FailedOutcome, ReadOutcome, ReadSource } from './types'

export interface MarketProblem {
  poolId: string
  outcome: FailedOutcome
}

export interface Retained {
  result: MarketsResult
  /** Client clock, ms, when the retained rows were read. */
  receivedAt: number
}

export type MarketsState =
  /** `retrying` is the failure a refresh is trying to get past, still on screen meanwhile. */
  | { phase: 'loading'; previous: MarketsResult | null; retrying: FailedOutcome | null }
  | { phase: 'ready'; result: MarketsResult; problems: MarketProblem[] }
  /** Nothing new to show. `retained` is the last good read, already marked stale. */
  | { phase: 'failed'; failure: FailedOutcome; retained: Retained | null }

export interface MarketsProvider {
  readonly kind: 'sample' | 'fixture' | 'bridge'
  getSnapshot(): MarketsState
  subscribe(listener: () => void): () => void
  /** Starts the first load if none has started. */
  ensure(): void
  refresh(): void
}

const SAMPLE_STATE: MarketsState = { phase: 'ready', result: listMarkets(), problems: [] }

/** Today's landing: labelled sample rows, synchronously, and no request at all. */
export const sampleMarkets: MarketsProvider = {
  kind: 'sample',
  getSnapshot: () => SAMPLE_STATE,
  subscribe: () => () => undefined,
  ensure: () => undefined,
  refresh: () => undefined,
}

/** States that say nothing can be read on this screen, whichever pool is asked about. */
export const isBlocking = (outcome: FailedOutcome) =>
  outcome.state === 'gate_required' ||
  outcome.state === 'gate_unavailable' ||
  outcome.state === 'access_required' ||
  outcome.state === 'incompatible' ||
  (outcome.state === 'disabled' && outcome.reason !== 'route_not_enabled')

/**
 * Rows kept after a failed refresh. Every figure that was current becomes
 * stale, dated to its own observation or, failing that, to when it was read.
 */
export function retainAsStale(result: MarketsResult, receivedAtMs: number): MarketsResult {
  const readAt = Math.floor(receivedAtMs / 1000)
  const age = (m: Metric): Metric => (m.state === 'qualified' || m.state === 'provider' ? { ...m, state: 'stale', asOf: m.asOf ?? readAt } : m)
  return {
    ...result,
    markets: result.markets.map((row) => ({
      ...row,
      tvlUsd: age(row.tvlUsd),
      volume24hUsd: age(row.volume24hUsd),
      volume30dUsd: age(row.volume30dUsd),
      feeAprPercent: age(row.feeAprPercent),
    })),
  }
}

export interface LoadedMarkets {
  rows: Market[]
  problems: MarketProblem[]
  blocking: FailedOutcome | null
  aborted: boolean
}

/**
 * The reads behind the table, one pool at a time so a blocking answer stops
 * the rest. Token metadata is read once per address for the whole table.
 */
export async function loadMarkets(source: ReadSource, poolIds: readonly string[], signal?: AbortSignal): Promise<LoadedMarkets> {
  const rows: Market[] = []
  const problems: MarketProblem[] = []
  const tokenReads = new Map<string, ReadOutcome<'token'>>()
  const stopped = (blocking: FailedOutcome | null, aborted = false): LoadedMarkets => ({ rows, problems, blocking, aborted })

  for (const poolId of poolIds) {
    // No history flag: the table shows no chart, and the answer is bound to what was asked.
    const market = await source.read('pool-market', { poolId }, { signal })
    if (market.state === 'aborted') return stopped(null, true)
    if (market.state !== 'ok') {
      if (isBlocking(market)) return stopped(market)
      problems.push({ poolId, outcome: market })
      continue
    }
    const metrics = await source.read('pool-metrics', { poolId }, { signal })
    if (metrics.state === 'aborted') return stopped(null, true)
    if (metrics.state !== 'ok') {
      if (isBlocking(metrics)) return stopped(metrics)
      problems.push({ poolId, outcome: metrics })
    }
    const tokens = new Map<string, ReadOutcome<'token'>>()
    for (const currency of market.data.pool.currencies) {
      const key = currency.toLowerCase()
      let read = tokenReads.get(key)
      if (!read) {
        read = await source.read('token', { token: currency }, { signal })
        if (read.state === 'aborted') return stopped(null, true)
        if (read.state !== 'ok') {
          if (isBlocking(read)) return stopped(read)
          problems.push({ poolId, outcome: read })
        }
        tokenReads.set(key, read)
      }
      tokens.set(key, read)
    }
    rows.push(projectMarketRow({ market, metrics, tokens }))
  }
  return stopped(null)
}

const NOTICE = {
  fixture: `Contract fixtures from read-v1 ${PRODUCER_PIN.packages['read-v1'].version}, served through the real read pipeline. Not observations.`,
  bridge: undefined,
}

export interface ReadMarketsOptions {
  source: ReadSource
  poolIds: readonly string[]
  kind: 'fixture' | 'bridge'
  now?: () => number
}

export function createReadMarketsProvider({ source, poolIds, kind, now = () => Date.now() }: ReadMarketsOptions): MarketsProvider {
  let state: MarketsState = { phase: 'loading', previous: null, retrying: null }
  let lastGood: Retained | null = null
  let controller: AbortController | null = null
  let started = false
  const listeners = new Set<() => void>()

  const set = (next: MarketsState) => {
    state = next
    for (const listener of listeners) listener()
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
    return lastGood ? retainAsStale(lastGood.result, lastGood.receivedAt) : null
  }

  async function run() {
    const previous = rowsWhileLoading()
    controller?.abort()
    const mine = new AbortController()
    controller = mine
    const retrying = state.phase === 'failed' ? state.failure : state.phase === 'loading' ? state.retrying : null
    set({ phase: 'loading', previous, retrying })
    const loaded = await loadMarkets(source, poolIds, mine.signal)
    if (mine.signal.aborted || controller !== mine) return
    controller = null
    const retained = lastGood ? { result: retainAsStale(lastGood.result, lastGood.receivedAt), receivedAt: lastGood.receivedAt } : null
    const failure = loaded.blocking ?? (loaded.rows.length === 0 && loaded.problems.length > 0 ? loaded.problems[0].outcome : null)
    if (failure) {
      set({ phase: 'failed', failure, retained })
      return
    }
    const result: MarketsResult = {
      source: kind === 'fixture' ? 'fixture' : 'live',
      chainId: 4663,
      network: 'Robinhood Chain',
      markets: loaded.rows,
      notice: NOTICE[kind],
    }
    lastGood = { result, receivedAt: now() }
    set({ phase: 'ready', result, problems: loaded.problems })
  }

  return {
    kind,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        // Nobody is looking any more: cancel, and let the next viewer start again.
        if (listeners.size === 0 && controller) {
          controller.abort()
          controller = null
          started = false
        }
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
  }
}
