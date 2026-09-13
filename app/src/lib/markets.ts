/**
 * Pool market figures and the one rule for showing them.
 *
 * Amounts are decimal strings, never JS numbers, and a missing value is `null`
 * with a paired reason. Never a zero and never an invented figure. Every
 * figure carries a state, and the state decides what reaches the screen:
 *
 *   qualified    Domino's own history, usableAsCurrent24h. The only current 24h/APR figure.
 *   provider     Reported by a named provider, unreconciled. Shown with its name.
 *   stale        A retained value, shown with its original time.
 *   partial      Calculated over an incomplete window. Not current.
 *   reference    Reference analytics. Not current, never in a table cell.
 *   absent       Not reported inside a usable observation.
 *   unavailable  No usable observation, or a figure the read service does not
 *                provide yet (the pool APR today), even when a value was retained.
 *   rejected     The observation failed an identity check. Never shown.
 *
 * Every row is built from validated reads. There is no stand-in or placeholder
 * state: a figure nobody observed is unavailable, and says why.
 */
import { compare, formatUsdCompact, ratio, toFixed } from './read/decimal'
import type { TokenDisplay } from './read/types'
import type { AprEstimateObservation } from './read/aprEstimate'

export type MetricState =
  | 'qualified'
  | 'provider'
  | 'stale'
  | 'partial'
  | 'reference'
  | 'absent'
  | 'unavailable'
  | 'rejected'

/** Who reported a provider figure. Absent for Domino's own history. */
export type MetricSource = 'GeckoTerminal' | 'DexScreener'

export interface Metric {
  /**
   * Decimal string, or null when the value is not established. A non-null
   * value does not by itself mean the figure is current: an `unavailable`
   * metric may retain the last value it had, and a `stale` one always does.
   * `state` decides what is shown; `value` never does on its own.
   */
  value: string | null
  state: MetricState
  reason?: string
  /** Original observation time of a retained value, as a unix timestamp. */
  asOf?: number
  source?: MetricSource
}

export type Presented =
  | { kind: 'unavailable'; reason?: string; rejected?: boolean }
  /** Nothing reported, inside an observation that is itself usable. */
  | { kind: 'absent'; reason?: string; source?: MetricSource }
  /** A calculated value that is not current: reference analytics or an incomplete window. */
  | { kind: 'not_current'; reason?: string; basis: 'reference' | 'partial' }
  | {
      kind: 'value'
      text: string
      stale: boolean
      asOf?: number
      /** The provider that reported this figure. */
      source?: MetricSource
      /**
       * A figure Domino calculated from figures this provider reported. The
       * provider never reported it, so it is never attributed to it as `source`.
       */
      calculatedFrom?: MetricSource
    }

/**
 * The one rule for turning a metric into something on screen.
 *
 * An unavailable or rejected metric is shown as unavailable even when it
 * still carries a retained value, a stale one shows its value with its
 * original time, and a provider figure names its provider. Reference and
 * partial values never reach a cell as a number. Nothing here is decided by
 * whether `value` happens to be null.
 */
export function presentMetric(metric: Metric, format: (m: Metric) => string = compactUsd): Presented {
  switch (metric.state) {
    case 'unavailable':
      return { kind: 'unavailable', reason: metric.reason }
    case 'rejected':
      return { kind: 'unavailable', reason: metric.reason, rejected: true }
    case 'absent':
      // A null a provider reported is unavailable in that provider's name.
      return { kind: 'absent', reason: metric.reason, ...(metric.source ? { source: metric.source } : {}) }
    case 'reference':
    case 'partial':
      return { kind: 'not_current', reason: metric.reason, basis: metric.state }
    default:
      break
  }
  if (metric.value === null) return { kind: 'unavailable', reason: metric.reason }
  return {
    kind: 'value',
    text: format(metric),
    stale: metric.state === 'stale',
    asOf: metric.asOf,
    ...(metric.source ? { source: metric.source } : {}),
  }
}

export interface Market {
  /** `4663:<poolId>`, lowercase. Rows are keyed and merged by this, never by symbol. */
  key: string
  poolId: string
  /** Display labels only: never identity, never an artwork key. */
  base: string
  quote: string
  tokens: { base: TokenDisplay; quote: TokenDisplay }
  /** Fixed LP fee in pips, or null for a dynamic-fee pool. */
  feePips: number | null
  protocol: 'v4'
  tvlUsd: Metric
  volume24hUsd: Metric
  feeAprPercent: Metric
  /** Attributed backend estimate, never a qualified historical APR. */
  feeAprEstimate?: AprEstimateObservation
  /** Provider orientation, used to ask for a chart by a verified token address. */
  chartTokens?: { base: string; quote: string }
  /** The pool's own state at the block the row was read at: where its price comes from (lib/read/marketPrice.ts). */
  poolState?: MarketPoolState
  /** Where the row's figures came from. */
  provenance?: MarketProvenance
}

/**
 * A pool's state as the chain holds it at one block: the square-root price
 * and the tick, exactly as read, the tick spacing, and the two currencies in
 * the pool's own order. Strings and small integers only: the price itself is
 * worked out, and checked, in lib/read/marketPrice.ts.
 */
export interface MarketPoolState {
  /** Q64.96, the decimal string as read. */
  sqrtPriceX96: string
  tick: number
  tickSpacing: number
  /** The block the state was read at. */
  block: number
  /** Lowercase. */
  currency0: string
  /** Lowercase. */
  currency1: string
}

export interface MarketProvenance {
  /** The block at which the read service verified the pool on-chain. */
  block: number
  /** The provider observation: its own state, why it has no figures, and when they were retrieved. */
  market: {
    status: 'available' | 'stale' | 'unavailable' | 'rejected'
    /** Why there are no provider figures (unavailable, rejected), or why a stale one was kept. */
    reason: string | null
    /** Seconds since the read service retrieved the figures, as it reported them when it answered. Null when unknown. */
    cacheAgeSeconds: number | null
    /** How long the read service counts a retrieval as current. */
    freshForSeconds: number
    /** Client wall clock, ms, when that answer arrived. */
    receivedAt: number
    /** The monotonic clock (performance.now()), ms, when that answer arrived. Time on screen is counted on it when present. */
    receivedMonotonic?: number
  }
  /**
   * Domino's own pool-metrics history: its freshness, null when that read
   * failed, or `not_requested`, which every row of the lean table is.
   */
  metrics: { freshness: 'fresh' | 'stale'; ageSeconds: number } | 'not_requested' | null
  /** Package fixture files behind the row, fixture transport only. */
  fixtures: string[]
}

export interface MarketsResult {
  source: 'fixture' | 'live'
  chainId: number
  network: string
  markets: Market[]
  /** Present for rows read from contract fixtures; the UI must show it. */
  notice?: string
}

/** Compact money formatting for table cells. Never invents precision. */
export function compactUsd(metric: Metric): string {
  if (metric.value === null) return 'Unavailable'
  return formatUsdCompact(metric.value) ?? 'Unavailable'
}

/** A percentage to two places, from the decimal string. */
export const percentText = (metric: Metric) => (metric.value === null ? null : toFixed(metric.value, 2))

const USABLE: ReadonlySet<MetricState> = new Set(['qualified', 'provider', 'stale'])

/**
 * Daily volume over TVL, the turnover figure exchanges show next to APR.
 *
 * A ratio is only as good as its weakest operand. An operand that is not
 * usable (unavailable, rejected, absent, reference or partial) makes it
 * unavailable even when that operand still carries a retained value. Both
 * operands must share a basis: a provider's volume over Domino's TVL, or two
 * providers, is no ratio at all. A stale operand makes it stale, dated to the
 * oldest observation involved. A measured zero volume is 0.00, never "<0.01",
 * which would read as a small positive number. The division is exact, on the
 * decimal strings. The ratio is Domino's own calculation: when its operands
 * are a provider's, it says it was calculated from that provider's figures
 * (`calculatedFrom`), never that the provider reported it (`source`).
 */
/**
 * A row's figures as they read at `now`: a provider figure past the read
 * service's fresh window is stale, never current. Anything holding a market
 * open — the Top pools row, and the figures dialog it opens — projects it
 * through here on every tick, so what is on screen keeps ageing instead of
 * freezing at the moment it was opened.
 */
export function agedMarket(m: Market, now: Instant): Market {
  const p = m.provenance
  if (!p || !providerStale(p.market, now)) return m
  const aged = (metric: Metric): Metric => (metric.state === 'provider' ? { ...metric, state: 'stale' } : metric)
  return { ...m, tvlUsd: aged(m.tvlUsd), volume24hUsd: aged(m.volume24hUsd) }
}

export function turnover(m: Pick<Market, 'volume24hUsd' | 'tvlUsd'>): Presented {
  const inputs = [m.volume24hUsd, m.tvlUsd]
  const missing = inputs.find((input) => !USABLE.has(input.state) || input.value === null)
  if (missing) return { kind: 'unavailable', reason: missing.reason ?? missing.state }
  const [volume, tvl] = inputs
  if (volume.source !== tvl.source) return { kind: 'unavailable', reason: 'mixed_basis' }
  const exact = ratio(volume.value as string, tvl.value as string, 18)
  if (exact === null || compare(exact, '0') === -1) return { kind: 'unavailable', reason: 'turnover_undefined' }
  const staleTimes = inputs.filter((input) => input.state === 'stale').map((input) => input.asOf)
  const known = staleTimes.filter((time): time is number => time !== undefined)
  return {
    kind: 'value',
    text: compare(exact, '0') === 0 ? '0.00' : compare(exact, '0.01') === -1 ? '<0.01' : (toFixed(exact, 2) as string),
    stale: staleTimes.length > 0,
    // Only claim a time when every stale operand has one.
    asOf: staleTimes.length > 0 && known.length === staleTimes.length ? Math.min(...known) : undefined,
    ...(volume.source ? { calculatedFrom: volume.source } : {}),
  }
}

/**
 * A moment on this page's clocks: the wall clock, and the monotonic one
 * (performance.now()) where there is one. A bare number is a wall-clock
 * reading.
 */
export interface Instant {
  wall: number
  monotonic?: number
}

/** Both clocks, now. */
export const readNow = (): Instant => ({ wall: Date.now(), monotonic: typeof performance === 'undefined' ? undefined : performance.now() })

/**
 * Whole seconds since the answer arrived, never negative: on the monotonic
 * clock when both the answer and `now` were read on it, so no step of the
 * wall clock moves it, and on the wall clock otherwise.
 */
export function onScreenSeconds(market: MarketProvenance['market'], now: number | Instant): number {
  const at: Instant = typeof now === 'number' ? { wall: now } : now
  const ms =
    market.receivedMonotonic !== undefined && at.monotonic !== undefined ? at.monotonic - market.receivedMonotonic : at.wall - market.receivedAt
  return Math.max(0, Math.floor(ms / 1000))
}

/**
 * Seconds since the provider figures were retrieved, now: the age the read
 * service reported, plus the time since its answer arrived. Null when it
 * reported none.
 */
export function retrievedAgeSeconds(market: MarketProvenance['market'], now: number | Instant): number | null {
  if (market.cacheAgeSeconds === null) return null
  return market.cacheAgeSeconds + onScreenSeconds(market, now)
}

/**
 * The only way a provider figure is dated: when the read service retrieved
 * it. The provider's own update time is not known (no asOfTimestamp, no
 * asOfBlock), so a figure is never said to be "as of" or "updated at" a time.
 */
export function retrievedText(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'retrieval time unknown'
  return ageSeconds < 120 ? `retrieved ${ageSeconds} s ago` : `retrieved ${Math.floor(ageSeconds / 60)} min ago`
}

/**
 * Whether provider figures are stale on screen now: the read service said
 * so, or they have been on screen past its fresh window since. With no
 * reported age, the time since the answer arrived is a lower bound on it:
 * the figures are at least that old, so they still turn stale, while their
 * retrieval time is still said to be unknown.
 */
export function providerStale(market: MarketProvenance['market'], now: number | Instant): boolean {
  if (market.status === 'stale') return true
  if (market.status !== 'available') return false
  return (retrievedAgeSeconds(market, now) ?? onScreenSeconds(market, now)) > market.freshForSeconds
}

/** A pool's APR as the ticker writes it, through the same state rule as every other figure. */
export const aprLabel = (metric: Metric): Presented =>
  presentMetric(metric, (m) => {
    const text = percentText(m)
    return text === null ? 'Unavailable' : `${text}% APR`
  })

/**
 * A v4 pool whose hook sets the fee carries the sentinel 8388608 in its fee
 * field, not a rate. Divided as a rate it reads 838.86%, which is why it is
 * named here rather than left to arithmetic.
 */
/**
 * A fee is exact to the pip: 1 pip is 0.0001%, not 0.00%. Two decimals would
 * collapse every tier below 0.005% into the same text, so the digits are
 * written out rather than rounded.
 */
function fixedFeePercent(pips: number): string {
  if (Math.trunc(pips) !== pips || pips < 0) return 'Unknown fee'
  const whole = Math.floor(pips / 10_000)
  const fraction = String(pips % 10_000).padStart(4, '0')
  return `${whole}.${fraction.slice(0, 2) + fraction.slice(2).replace(/0+$/, '')}%`
}

export const DYNAMIC_FEE_PIPS = 8_388_608

export const feeTierLabel = (pips: number) => (pips === DYNAMIC_FEE_PIPS ? 'Dynamic' : fixedFeePercent(pips))

/** The fee as a row shows it: a fixed tier, or dynamic when the pool's hook sets it. */
export const feeLabel = (market: Pick<Market, 'feePips'>) => (market.feePips === null ? 'Dynamic fee' : feeTierLabel(market.feePips))
