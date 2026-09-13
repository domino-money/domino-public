/**
 * Where the Selected pools table and the ticker get their rows.
 *
 * Components depend on this interface, never on a read source directly. The
 * app holds one provider, shared through context, so the ticker and the table
 * render one result set from one load. Rows come from validated reads only;
 * there is no sample or placeholder row anywhere.
 *
 * The load is lean, on rugged97's read budget (#45): per selected pool, one
 * pool-market read that explicitly does not ask for price history, then each
 * distinct token once, only for pools that answered. V2 includes the backend
 * estimate in that same market read; qualified historical APR is separate.
 * Capabilities are shared once per namespace, then N + U POSTs for N pools
 * and U distinct tokens, sent
 * one after another. There is no client cache: every load reads again. An
 * empty selection reads nothing at all.
 *
 * When a refresh fails, the last good rows stay on screen dated and marked
 * stale, beside the reason, as docs/API_COMPATIBILITY.md asks. A failed
 * payload itself is never shown.
 */
import type { Market, MarketsResult, Metric } from '../markets'
import { projectMarketRow } from './project'
import type { FailedOutcome, ReadOutcome, ReadRequests, ReadSource } from './types'

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
  readonly kind: 'fixture' | 'bridge'
  getSnapshot(): MarketsState
  subscribe(listener: () => void): () => void
  /** Starts the first load if none has started. */
  ensure(): void
  refresh(): void
}

/** States that say nothing can be read on this screen, whichever pool is asked about. */
export const isBlocking = (outcome: FailedOutcome) =>
  outcome.state === 'not_connected' ||
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
      feeAprPercent: age(row.feeAprPercent),
      ...(row.feeAprEstimate ? { feeAprEstimate: { ...row.feeAprEstimate, retained: true } } : {}),
    })),
  }
}

export interface LoadedMarkets {
  rows: Market[]
  problems: MarketProblem[]
  blocking: FailedOutcome | null
  aborted: boolean
}

/** The one pool-market request the table sends: price history explicitly off, because the table draws no chart. */
export const tableMarketRequest = (poolId: string): ReadRequests['pool-market'] => ({ poolId, includePriceHistory: false })

/**
 * The reads behind the table, strictly one after another: each starts once
 * the one before it has settled, so a blocking answer stops the rest, and a
 * disabled pool-market route, which is disabled for every pool, stops them
 * too. A token shared by several pools is read once for the whole table.
 */
export async function loadSelectedPools(source: ReadSource, poolIds: readonly string[], signal?: AbortSignal, onProgress?: (rows: Market[]) => void): Promise<LoadedMarkets> {
  const rows: Market[] = []
  const problems: MarketProblem[] = []
  const tokenReads = new Map<string, ReadOutcome<'token'>>()
  const stopped = (blocking: FailedOutcome | null, aborted = false): LoadedMarkets => ({ rows, problems, blocking, aborted })

  for (const poolId of poolIds) {
    const market = await source.read('pool-market', tableMarketRequest(poolId), { signal })
    if (market.state === 'aborted') return stopped(null, true)
    if (market.state !== 'ok') {
      if (isBlocking(market) || market.state === 'disabled') return stopped(market)
      problems.push({ poolId, outcome: market })
      continue
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
    rows.push(projectMarketRow({ market, metrics: null, tokens }))
    onProgress?.([...rows])
  }
  return stopped(null)
}

export interface ReadMarketsOptions {
  source: ReadSource
  /** The pools to read, in the order the rows keep. */
  poolIds: readonly string[]
  kind: 'fixture' | 'bridge'
  /** Shown beside the rows: the fixture build says they are fixtures. */
  notice?: string
  now?: () => number
}

export function createReadMarketsProvider({ source, poolIds, kind, notice, now = () => Date.now() }: ReadMarketsOptions): MarketsProvider {
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
    const loaded = await loadSelectedPools(source, poolIds, mine.signal, (rows) => {
      if (mine.signal.aborted || controller !== mine) return
      const updated = new Map(rows.map((row) => [row.poolId, row]))
      const retainedRows = previous?.markets ?? []
      const combined = poolIds.flatMap((poolId) => {
        const row = updated.get(poolId) ?? retainedRows.find((m) => m.poolId === poolId)
        return row ? [row] : []
      })
      set({ phase: 'loading', retrying, previous: { source: kind === 'bridge' ? 'live' : kind, chainId: 4663, network: 'Robinhood Chain', markets: combined, notice } })
    })
    if (mine.signal.aborted || controller !== mine) return
    controller = null
    const retained = lastGood ? { result: retainAsStale(lastGood.result, lastGood.receivedAt), receivedAt: lastGood.receivedAt } : null
    const failure = loaded.blocking ?? (loaded.rows.length === 0 && loaded.problems.length > 0 ? loaded.problems[0].outcome : null)
    if (failure) {
      set({ phase: 'failed', failure, retained })
      return
    }
    const result: MarketsResult = {
      source: kind === 'bridge' ? 'live' : kind,
      chainId: 4663,
      network: 'Robinhood Chain',
      markets: loaded.rows,
      notice,
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
