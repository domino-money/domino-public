/**
 * Pool market data adapter.
 *
 * The shape mirrors what the read API will return, including its state
 * discriminators, so swapping `listMarkets` for a real call is the only change
 * needed. Amounts are decimal strings, never JS numbers, and a missing value is
 * `null` with a paired reason. Never a zero and never an invented figure.
 *
 * `source` is carried through to the UI so placeholder rows are always labelled
 * as such. Do not render these rows without that label.
 */

export type MetricState = 'qualified' | 'stale' | 'unavailable' | 'placeholder'

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
}

export type Presented =
  | { kind: 'unavailable'; reason?: string }
  | { kind: 'value'; text: string; stale: boolean; sample: boolean; asOf?: number }

/**
 * The one rule for turning a metric into something on screen.
 *
 * An unavailable metric is shown as unavailable even when it still carries
 * a retained value, a stale one shows its value with its original time, and
 * a placeholder is marked as a sample. Nothing here is decided by whether
 * `value` happens to be null.
 */
export function presentMetric(metric: Metric, format: (m: Metric) => string = compactUsd): Presented {
  if (metric.state === 'unavailable' || metric.value === null) {
    return { kind: 'unavailable', reason: metric.reason }
  }
  return {
    kind: 'value',
    text: format(metric),
    stale: metric.state === 'stale',
    sample: metric.state === 'placeholder',
    asOf: metric.asOf,
  }
}

export interface Market {
  poolId: string
  base: string
  quote: string
  feePips: number
  protocol: 'v4'
  tvlUsd: Metric
  volume24hUsd: Metric
  volume30dUsd: Metric
  feeAprPercent: Metric
}

export interface MarketsResult {
  source: 'placeholder' | 'live'
  chainId: number
  network: string
  markets: Market[]
  /** Present only for placeholder data; the UI must show it. */
  notice?: string
}

const placeholder = (value: string): Metric => ({ value, state: 'placeholder' })

/**
 * Pairs built from tokens that exist on Robinhood Chain. The WETH/USDG pool id
 * is a real one from the backend's validation set; the figures next to every
 * pair are invented for layout and are labelled as such until the read bridge
 * can serve qualified numbers.
 */
const SAMPLE: Market[] = [
  {
    poolId: '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    base: 'WETH',
    quote: 'USDG',
    feePips: 500,
    protocol: 'v4',
    tvlUsd: placeholder('10450000'),
    volume24hUsd: placeholder('37060000'),
    volume30dUsd: placeholder('812000000'),
    feeAprPercent: placeholder('150.92'),
  },
  {
    poolId: '0x00000000000000000000000000000000000000000000000000000000000000a2',
    base: 'ETH',
    quote: 'USDG',
    feePips: 3000,
    protocol: 'v4',
    tvlUsd: placeholder('3170000'),
    volume24hUsd: placeholder('550470'),
    volume30dUsd: placeholder('16400000'),
    feeAprPercent: placeholder('22.52'),
  },
  {
    poolId: '0x00000000000000000000000000000000000000000000000000000000000000a3',
    base: 'MARLIN',
    quote: 'USDG',
    feePips: 9000,
    protocol: 'v4',
    tvlUsd: placeholder('1330000'),
    volume24hUsd: placeholder('1430000'),
    volume30dUsd: placeholder('39100000'),
    feeAprPercent: placeholder('84.05'),
  },
  {
    poolId: '0x00000000000000000000000000000000000000000000000000000000000000a4',
    base: 'TRADOOR',
    quote: 'USDG',
    feePips: 10000,
    protocol: 'v4',
    tvlUsd: placeholder('582710'),
    volume24hUsd: placeholder('533910'),
    volume30dUsd: placeholder('12800000'),
    feeAprPercent: placeholder('68.27'),
  },
  {
    poolId: '0x00000000000000000000000000000000000000000000000000000000000000a5',
    base: 'CRUMBS',
    quote: 'USDG',
    feePips: 10000,
    protocol: 'v4',
    tvlUsd: placeholder('509470'),
    volume24hUsd: placeholder('752400'),
    volume30dUsd: placeholder('9300000'),
    feeAprPercent: placeholder('24.54'),
  },
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
  const n = Number(metric.value)
  if (!Number.isFinite(n)) return 'Unavailable'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

/**
 * Daily volume over TVL, the turnover figure exchanges show next to APR.
 *
 * A ratio is only as good as its weakest operand. An unavailable operand makes
 * it unavailable even when that operand still carries a retained value. A
 * stale operand makes it stale, dated to the oldest observation involved. A
 * sample operand makes it a sample. A measured zero volume is 0.00, never
 * "<0.01", which would read as a small positive number.
 */
export function turnover(m: Market): Presented {
  const inputs = [m.volume24hUsd, m.tvlUsd]
  const missing = inputs.find((input) => input.state === 'unavailable' || input.value === null)
  if (missing) return { kind: 'unavailable', reason: missing.reason }
  const ratio = Number(m.volume24hUsd.value) / Number(m.tvlUsd.value)
  if (!Number.isFinite(ratio) || ratio < 0) return { kind: 'unavailable', reason: 'turnover_undefined' }
  const staleTimes = inputs.filter((input) => input.state === 'stale').map((input) => input.asOf)
  const known = staleTimes.filter((time): time is number => time !== undefined)
  return {
    kind: 'value',
    text: ratio === 0 ? '0.00' : ratio < 0.01 ? '<0.01' : ratio.toFixed(2),
    stale: staleTimes.length > 0,
    sample: inputs.some((input) => input.state === 'placeholder'),
    // Only claim a time when every stale operand has one.
    asOf: staleTimes.length > 0 && known.length === staleTimes.length ? Math.min(...known) : undefined,
  }
}

/** A pool's APR as the ticker writes it, through the same state rule as every other figure. */
export const aprLabel = (metric: Metric): Presented =>
  presentMetric(metric, (m) => `${Number(m.value).toFixed(2)}% APR`)

export const feeTierLabel = (pips: number) => `${(pips / 10_000).toFixed(2)}%`
