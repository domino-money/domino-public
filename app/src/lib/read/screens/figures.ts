/**
 * Issue #13: provider figures, attributed.
 *
 * A provider figure is shown with who reported it and when it was retrieved,
 * as the payload says, and nothing more: never as current, qualified or
 * reconciled. Only pool-metrics with `usableAsCurrent24h` makes a figure
 * qualified, and that decision stays in slice A's projection. Times come only
 * from the payload, never from this browser's clock, so the same reply reads
 * the same everywhere. GeckoTerminal (pool-market) and DexScreener (pools)
 * are different providers and are never combined.
 */
import type { PoolActivityResponse, PoolMarketResponse, ProviderMetrics } from 'api-contracts/read-v1/types'
import { formatUsdCompact, parseDecimal } from '../decimal'
import { reasonText } from '../describe'
import { presentMetric, turnover, type Market, type Metric, type Presented } from '../../markets'

export type ProviderId = 'geckoterminal' | 'dexscreener'

export const PROVIDER_NAME: Record<ProviderId, string> = { geckoterminal: 'GeckoTerminal', dexscreener: 'DexScreener' }

export type AttributedFigure =
  | { state: 'attributed'; value: string; zero: boolean; provider: ProviderId; retrievedAt: number; cacheAgeSeconds: number | null }
  | { state: 'attributed_stale'; value: string; zero: boolean; provider: ProviderId; retrievedAt: number; cacheAgeSeconds: number | null; refreshReason: string | null }
  | { state: 'not_reported'; provider: ProviderId }
  | { state: 'unavailable'; provider: ProviderId; reason: string }
  | { state: 'rejected'; provider: ProviderId; reason: string }

function valued(text: string): { value: string; zero: boolean } | null {
  const parsed = parseDecimal(text)
  const value = formatUsdCompact(text)
  return parsed && value ? { value, zero: parsed.coefficient === 0n } : null
}

/** DexScreener figures on a pools-route candidate. Always null in the catalogue route. */
export function figureFromProviderMetrics(metrics: ProviderMetrics | null, pick: 'liquidity' | 'volume', conflict: boolean): AttributedFigure {
  const provider = 'dexscreener' as const
  if (metrics === null) return { state: 'unavailable', provider, reason: 'no_provider_figures' }
  if (conflict) return { state: 'rejected', provider, reason: 'provider_currency_mismatch' }
  const raw = pick === 'liquidity' ? metrics.reportedLiquidityUsd : metrics.volume24hUsd
  if (raw === null) return { state: 'not_reported', provider }
  const v = valued(raw)
  if (!v) return { state: 'unavailable', provider, reason: 'invalid_quantity' }
  return { state: 'attributed', ...v, provider, retrievedAt: metrics.retrievedAt, cacheAgeSeconds: null }
}

/** GeckoTerminal figures from pool-market. The envelope's status decides, never a non-null cache age. */
export function figureFromMarket(market: PoolMarketResponse['market'], pick: 'liquidity' | 'volume'): AttributedFigure {
  const provider = 'geckoterminal' as const
  if (market.status === 'rejected') return { state: 'rejected', provider, reason: market.reason }
  if (market.status === 'unavailable' || market.data === null) return { state: 'unavailable', provider, reason: market.reason ?? 'provider_unavailable' }
  const raw = pick === 'liquidity' ? market.data.reportedLiquidityUsd : market.data.volume24hUsd
  if (raw === null) return { state: 'not_reported', provider }
  const v = valued(raw)
  if (!v) return { state: 'unavailable', provider, reason: 'invalid_quantity' }
  const base = { ...v, provider, retrievedAt: market.data.retrievedAt, cacheAgeSeconds: market.cache.ageSeconds }
  // A stale envelope is still a retained observation; a reason describes why no fresher observation is available.
  return market.status === 'stale' ? { state: 'attributed_stale', ...base, refreshReason: market.reason } : { state: 'attributed', ...base }
}

/** A payload time in UTC, the same text in every browser: "00:16:50 UTC, 1970-01-01". */
export function utcTime(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString()
  return `${iso.slice(11, 19)} UTC, ${iso.slice(0, 10)}`
}

/**
 * When a provider's figures for one pool were retrieved, as a sentence: the
 * pools route gives DexScreener figures no cache age, so the payload's
 * retrieval time, in UTC, is the only age there is. Never the client clock.
 */
export function retrievalNote(provider: ProviderId, retrievedAt: number): string {
  return `${PROVIDER_NAME[provider]} figures retrieved ${utcTime(retrievedAt)}. Provider-reported, not reconciled with chain data.`
}

/** Where a figure came from. Never says current, live, updated or qualified. */
export function provenanceText(figure: AttributedFigure): { short: string; long: string } {
  const name = PROVIDER_NAME[figure.provider]
  const tail = 'Provider-reported, not reconciled with chain data.'
  switch (figure.state) {
    case 'attributed': {
      const age = figure.cacheAgeSeconds === null ? '' : ` · cache ${figure.cacheAgeSeconds} s`
      return { short: `${name}${age}`, long: `Reported by ${name}, retrieved ${utcTime(figure.retrievedAt)}. ${tail}` }
    }
    case 'attributed_stale':
      return {
        short: `${name} · stale`,
        long: `Reported by ${name}, retrieved ${utcTime(figure.retrievedAt)}. This observation is stale${figure.refreshReason === null ? '' : ` (${reasonText(figure.refreshReason)})`}. ${tail}`,
      }
    case 'not_reported':
      return { short: `${name} · not reported`, long: `${name} was retrieved but reported no value for this figure. ${tail}` }
    case 'unavailable':
      return { short: `${name} · unavailable`, long: `Nothing usable was retrieved from ${name} (${reasonText(figure.reason)}). ${tail}` }
    case 'rejected':
      return { short: `${name} · rejected`, long: `What was retrieved from ${name} failed an identity check (${reasonText(figure.reason)}) and is not shown. ${tail}` }
    default:
      return figure satisfies never
  }
}

export interface ActivityFacts {
  window: 'covered' | 'young'
  /** Seconds of the 24h window the pool has existed for, from the payload alone. */
  observedSeconds: number
  /** A young pool's age, from verified discovery data; null when the pool is older than the window. */
  age: { seconds: number; basis: 'observedSeconds' | 'snapshot_minus_initializedAt' } | null
  swaps: number
  stale: boolean
  block: number
  initializedBlock: number
  feeAccounting: 'reconciled' | 'unavailable'
}

/**
 * Pool age and coverage from pool-activity. Its `feeApr` is always null and
 * its `volumeUsd` null, so neither ever becomes a figure here.
 */
export function activityFacts(d: PoolActivityResponse): ActivityFacts {
  const w = d.window24h
  const young = w.status === 'pool_younger_than_window'
  const derived = d.snapshot.timestamp - d.coverage.initializedAt
  return {
    window: young ? 'young' : 'covered',
    observedSeconds: w.observedSeconds,
    age: young ? (Math.trunc(w.observedSeconds) === w.observedSeconds ? { seconds: w.observedSeconds, basis: 'observedSeconds' } : { seconds: derived, basis: 'snapshot_minus_initializedAt' }) : null,
    swaps: w.swapEventCount,
    stale: d.freshness.status === 'stale',
    block: d.snapshot.number,
    initializedBlock: d.coverage.initializedBlock,
    feeAccounting: d.fees.accounting.status === 'unavailable' ? 'unavailable' : 'reconciled',
  }
}

/** Whether a table row's figures are Domino's qualified 24h ones. */
export const rowQualified = (row: Pick<Market, 'tvlUsd' | 'volume24hUsd' | 'feeAprPercent'>) =>
  [row.tvlUsd, row.volume24hUsd, row.feeAprPercent].some((metric) => metric.state === 'qualified')

/**
 * Volume over TVL in the read builds. From qualified operands it is slice A's
 * ratio. From provider operands, current or retained, it stays unavailable
 * until the open question on derived provider figures is answered: a ratio of
 * two unreconciled figures is a new claim neither provider made.
 */
export function turnoverCell(row: Pick<Market, 'volume24hUsd' | 'tvlUsd'>): Presented {
  if ([row.volume24hUsd, row.tvlUsd].some((metric) => metric.source !== undefined)) return { kind: 'unavailable', reason: 'derived_figure_pending_q8' }
  return turnover(row)
}

/** Why a presented figure shows no number, as a closed code; null for a number. */
export function presentedNoteCode(shown: Presented): string | null {
  if (shown.kind === 'value') return null
  return shown.reason ?? (shown.kind === 'not_current' ? shown.basis : shown.kind)
}

export const metricNoteCode = (metric: Metric) => presentedNoteCode(presentMetric(metric))

/** The id of the visible note a table cell points at with aria-describedby. */
export const figureNoteId = (code: string) => `figure-note-${code.replace(/[^a-z0-9_]/g, '')}`
