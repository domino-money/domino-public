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
 *   unavailable  No usable observation, even when a value was retained.
 *   rejected     The observation failed an identity check. Never shown.
 *   placeholder  A curated sample, always labelled as one.
 *
 * `source` is carried through to the UI so sample rows are always labelled
 * as such. Do not render these rows without that label.
 */
import { compare, formatUsdCompact, ratio, toFixed } from './read/decimal'
import type { TokenDisplay } from './read/types'

export type MetricState =
  | 'qualified'
  | 'provider'
  | 'stale'
  | 'partial'
  | 'reference'
  | 'absent'
  | 'unavailable'
  | 'rejected'
  | 'placeholder'

/** Who reported a provider figure. Absent for Domino's own history and for samples. */
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
  | { kind: 'absent'; reason?: string }
  /** A calculated value that is not current: reference analytics or an incomplete window. */
  | { kind: 'not_current'; reason?: string; basis: 'reference' | 'partial' }
  | { kind: 'value'; text: string; stale: boolean; sample: boolean; asOf?: number; source?: MetricSource }

/**
 * The one rule for turning a metric into something on screen.
 *
 * An unavailable or rejected metric is shown as unavailable even when it
 * still carries a retained value, a stale one shows its value with its
 * original time, a provider figure names its provider, and a placeholder is
 * marked as a sample. Reference and partial values never reach a cell as a
 * number. Nothing here is decided by whether `value` happens to be null.
 */
export function presentMetric(metric: Metric, format: (m: Metric) => string = compactUsd): Presented {
  switch (metric.state) {
    case 'unavailable':
      return { kind: 'unavailable', reason: metric.reason }
    case 'rejected':
      return { kind: 'unavailable', reason: metric.reason, rejected: true }
    case 'absent':
      return { kind: 'absent', reason: metric.reason }
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
    sample: metric.state === 'placeholder',
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
  volume30dUsd: Metric
  feeAprPercent: Metric
  /** Where a read row came from. Absent on samples. */
  provenance?: MarketProvenance
}

export interface MarketProvenance {
  block: number
  /** The provider observation's own state, and its cache age as reported. */
  market: { status: 'available' | 'stale' | 'unavailable' | 'rejected'; cacheAgeSeconds: number | null }
  metrics: { freshness: 'fresh' | 'stale'; ageSeconds: number } | null
  /** Package fixture files behind the row, fixture transport only. */
  fixtures: string[]
}

export interface MarketsResult {
  source: 'placeholder' | 'fixture' | 'live'
  chainId: number
  network: string
  markets: Market[]
  /** Present for placeholder and fixture data; the UI must show it. */
  notice?: string
}

const placeholder = (value: string): Metric => ({ value, state: 'placeholder' })

type SampleSymbol = 'WETH' | 'ETH' | 'USDG' | 'MARLIN' | 'TRADOOR' | 'CRUMBS'
const sampleToken = (symbol: SampleSymbol): TokenDisplay => ({ origin: 'sample', symbol, artwork: symbol, address: null })

function sample(poolId: string, base: SampleSymbol, quote: SampleSymbol, feePips: number, figures: [string, string, string, string]): Market {
  const [tvl, volume24h, volume30d, apr] = figures
  return {
    key: `4663:${poolId}`,
    poolId,
    base,
    quote,
    tokens: { base: sampleToken(base), quote: sampleToken(quote) },
    feePips,
    protocol: 'v4',
    tvlUsd: placeholder(tvl),
    volume24hUsd: placeholder(volume24h),
    volume30dUsd: placeholder(volume30d),
    feeAprPercent: placeholder(apr),
  }
}

/**
 * Pairs built from tokens that exist on Robinhood Chain. The WETH/USDG pool id
 * is a real one from the backend's validation set; the figures next to every
 * pair are invented for layout and are labelled as such until the read bridge
 * can serve qualified numbers.
 */
const SAMPLE: Market[] = [
  sample('0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6', 'WETH', 'USDG', 500, ['10450000', '37060000', '812000000', '150.92']),
  sample('0x00000000000000000000000000000000000000000000000000000000000000a2', 'ETH', 'USDG', 3000, ['3170000', '550470', '16400000', '22.52']),
  sample('0x00000000000000000000000000000000000000000000000000000000000000a3', 'MARLIN', 'USDG', 9000, ['1330000', '1430000', '39100000', '84.05']),
  sample('0x00000000000000000000000000000000000000000000000000000000000000a4', 'TRADOOR', 'USDG', 10000, ['582710', '533910', '12800000', '68.27']),
  sample('0x00000000000000000000000000000000000000000000000000000000000000a5', 'CRUMBS', 'USDG', 10000, ['509470', '752400', '9300000', '24.54']),
]

export function listMarkets(): MarketsResult {
  return {
    source: 'placeholder',
    chainId: 4663,
    network: 'Robinhood Chain',
    markets: SAMPLE,
    notice: 'Sample figures for layout. Live numbers arrive once the read bridge and a qualified USD price source exist.',
  }
}

/** Compact money formatting for table cells. Never invents precision. */
export function compactUsd(metric: Metric): string {
  if (metric.value === null) return 'Unavailable'
  return formatUsdCompact(metric.value) ?? 'Unavailable'
}

/** A percentage to two places, from the decimal string. */
export const percentText = (metric: Metric) => (metric.value === null ? null : toFixed(metric.value, 2))

const USABLE: ReadonlySet<MetricState> = new Set(['qualified', 'provider', 'stale', 'placeholder'])

/**
 * Daily volume over TVL, the turnover figure exchanges show next to APR.
 *
 * A ratio is only as good as its weakest operand. An operand that is not
 * usable (unavailable, rejected, absent, reference or partial) makes it
 * unavailable even when that operand still carries a retained value. Both
 * operands must share a basis: a provider's volume over Domino's TVL, or two
 * providers, is no ratio at all. A stale operand makes it stale, dated to the
 * oldest observation involved. A sample operand makes it a sample. A measured
 * zero volume is 0.00, never "<0.01", which would read as a small positive
 * number. The division is exact, on the decimal strings.
 */
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
    sample: inputs.some((input) => input.state === 'placeholder'),
    // Only claim a time when every stale operand has one.
    asOf: staleTimes.length > 0 && known.length === staleTimes.length ? Math.min(...known) : undefined,
    ...(volume.source ? { source: volume.source } : {}),
  }
}

/** A pool's APR as the ticker writes it, through the same state rule as every other figure. */
export const aprLabel = (metric: Metric): Presented =>
  presentMetric(metric, (m) => {
    const text = percentText(m)
    return text === null ? 'Unavailable' : `${text}% APR`
  })

export const feeTierLabel = (pips: number) => `${(pips / 10_000).toFixed(2)}%`

/** The fee as a row shows it: a fixed tier, or dynamic when the pool's hook sets it. */
export const feeLabel = (market: Pick<Market, 'feePips'>) => (market.feePips === null ? 'Dynamic fee' : feeTierLabel(market.feePips))
