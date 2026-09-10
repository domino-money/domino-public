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

export type MetricState = 'qualified' | 'unavailable' | 'placeholder'

export interface Metric {
  /** Decimal string, or null when the value is not established. */
  value: string | null
  state: MetricState
  reason?: string
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

/** Daily volume over TVL, the turnover figure exchanges show next to APR. */
export function turnover(m: Market): string {
  if (m.volume24hUsd.value === null || m.tvlUsd.value === null) return 'Unavailable'
  const r = Number(m.volume24hUsd.value) / Number(m.tvlUsd.value)
  if (!Number.isFinite(r)) return 'Unavailable'
  return r < 0.01 ? '<0.01' : r.toFixed(2)
}

export const feeTierLabel = (pips: number) => `${(pips / 10_000).toFixed(2)}%`
