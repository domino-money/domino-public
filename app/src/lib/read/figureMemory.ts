/**
 * The last good figures this browser saw for each pool, with their time (audit V1, 2026-10-01).
 *
 * In production the same pool's TVL and APR came and went within minutes: the read service's market data provider
 * refuses now and then (rate limited, busy, unavailable), and every refusal replaced a good figure on Home, the ticker
 * and Markets with "Unavailable". What a page saw last is kept here instead, in memory and in this browser
 * (localStorage, one key), so a refusal for the moment shows the last figure, dated and marked as not current
 * (figureFallback.ts), on this visit and the next.
 *
 * Kept per pool: the provider's TVL and 24h volume with when the read service retrieved them, and the read service's
 * APR estimate with when its inputs were retrieved. Only figures as the read service gave them, never one this page
 * worked out or took from another source. At most MAX_POOLS pools, none older than KEPT_MAX_AGE_S. Every storage
 * access may throw (a private window, blocked site data), and none is needed.
 */
import type { Market } from '../markets'
import type { StorageLike } from './cardSeries'

export const FIGURES_KEY = 'domino-figures:v1'
/** Nothing older than a day is kept or given out. */
export const KEPT_MAX_AGE_S = 24 * 3600
const MAX_POOLS = 64

export interface KeptFigures {
  /** Decimal strings, USD, as the read service reported them; null when it had none. */
  tvl: string | null
  volume: string | null
  /** Unix seconds: when the read service retrieved them. */
  at: number
  /** The read service's APR estimate, a decimal percent; null when it had none. */
  apr: string | null
  /** Unix seconds: when the estimate's inputs were retrieved. */
  aprAt: number | null
}

const DECIMAL = /^\d{1,24}(\.\d{1,24})?$/
const POOL_ID = /^0x[0-9a-f]{64}$/

function valid(entry: unknown): entry is KeptFigures {
  const e = entry as KeptFigures | null
  const decimal = (value: unknown) => value === null || (typeof value === 'string' && DECIMAL.test(value))
  const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  return typeof e === 'object' && e !== null && decimal(e.tvl) && decimal(e.volume) && time(e.at) && decimal(e.apr) && (e.aprAt === null || time(e.aprAt))
}

/** A row's figures worth keeping: the read service's own provider TVL and volume, and its estimate while it is one. Null when none. */
export function goodFigures(row: Market): Partial<KeptFigures> | null {
  const own = (metric: Market['tvlUsd']) =>
    (metric.state === 'provider' || metric.state === 'stale') && metric.source === 'GeckoTerminal' && metric.fallback === undefined && metric.value !== null && metric.asOf !== undefined && DECIMAL.test(metric.value)
      ? { value: metric.value, at: metric.asOf } : null
  const tvl = own(row.tvlUsd)
  const volume = own(row.volume24hUsd)
  const estimate = row.feeAprEstimate?.retained ? null : row.feeAprEstimate?.data
  const aprAt = estimate ? (estimate.provenance.retrievedAt ?? estimate.provenance.evaluatedAt) : null
  const apr = estimate && estimate.status === 'available' && estimate.reasons.length === 0 && estimate.feeAprEstimate24hPercent !== null && DECIMAL.test(estimate.feeAprEstimate24hPercent) && aprAt !== null
    ? { apr: estimate.feeAprEstimate24hPercent, aprAt } : null
  if (!tvl && !volume && !apr) return null
  const at = Math.max(tvl?.at ?? 0, volume?.at ?? 0)
  return { ...(tvl || volume ? { tvl: tvl?.value ?? null, volume: volume?.value ?? null, at } : {}), ...apr }
}

export interface FigureMemory {
  recall(poolId: string): KeptFigures | null
  /** Keeps what is newer than what is kept: the TVL and volume together, the estimate on its own. */
  remember(poolId: string, figures: Partial<KeptFigures>): void
}

export function createFigureMemory(storage: () => StorageLike | null, now: () => number = Date.now): FigureMemory {
  let pools: Map<string, KeptFigures> | null = null
  const store = () => {
    try {
      return storage()
    } catch {
      return null
    }
  }
  const nowSeconds = () => Math.floor(now() / 1000)
  const young = (entry: KeptFigures) => nowSeconds() - Math.max(entry.at, entry.aprAt ?? 0) <= KEPT_MAX_AGE_S
  const load = (): Map<string, KeptFigures> => {
    if (pools) return pools
    pools = new Map()
    try {
      const raw = store()?.getItem(FIGURES_KEY)
      const kept = raw ? (JSON.parse(raw) as { v?: unknown; pools?: Record<string, unknown> }) : null
      if (kept?.v === 1 && kept.pools && typeof kept.pools === 'object') {
        for (const [poolId, entry] of Object.entries(kept.pools)) if (POOL_ID.test(poolId) && valid(entry) && young(entry)) pools.set(poolId, entry)
      }
    } catch {
      // Unreadable: this visit starts from nothing, as it always did.
    }
    return pools
  }
  const save = (map: Map<string, KeptFigures>) => {
    try {
      store()?.setItem(FIGURES_KEY, JSON.stringify({ v: 1, pools: Object.fromEntries(map) }))
    } catch {
      // Full or blocked: kept in memory for this visit.
    }
  }
  return {
    recall(poolId) {
      const entry = load().get(poolId.toLowerCase())
      return entry && young(entry) ? entry : null
    },
    remember(poolId, figures) {
      const key = poolId.toLowerCase()
      if (!POOL_ID.test(key)) return
      const map = load()
      const was = map.get(key) ?? null
      const next: KeptFigures = was ? { ...was } : { tvl: null, volume: null, at: 0, apr: null, aprAt: null }
      let changed = false
      if (figures.at !== undefined && figures.at > next.at && (figures.tvl != null || figures.volume != null)) {
        next.tvl = figures.tvl ?? null
        next.volume = figures.volume ?? null
        next.at = figures.at
        changed = true
      }
      if (figures.apr != null && figures.aprAt != null && figures.aprAt > (next.aprAt ?? 0)) {
        next.apr = figures.apr
        next.aprAt = figures.aprAt
        changed = true
      }
      if (!changed || !valid({ ...next, at: next.at || next.aprAt || 0 })) return
      if (next.at === 0) next.at = next.aprAt ?? 0
      map.delete(key)
      map.set(key, next)
      while (map.size > MAX_POOLS) map.delete(map.keys().next().value!)
      save(map)
    },
  }
}

/**
 * This page's memory, kept in this browser's localStorage by the deployable build alone, as the copy of the last
 * overview is (appPaint.ts): the test builds keep nothing in the browser, so their memory lasts the visit.
 */
export const figureMemory = createFigureMemory(() => (typeof __DOMINO_POOL_SET__ !== 'undefined' && __DOMINO_POOL_SET__ === 'selected' && typeof localStorage !== 'undefined' ? localStorage : null))
