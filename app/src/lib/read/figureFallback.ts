/**
 * What a pool's row shows when the read service's market data provider refused for the moment (audit V1, 2026-10-01).
 *
 * The read service's provider refuses now and then (rate limited, busy, unavailable), and every refusal used to
 * replace a good TVL and APR with "Unavailable", on Home, the ticker and Markets. A refused figure is now stood in for,
 * in this order, and only where there is one:
 *
 *   1. the last figure this browser saw for the pool (figureMemory.ts), while it is younger than KEPT_PREFERRED_S:
 *      the same source, so the row does not jump between two providers' numbers;
 *   2. DEX Screener's, retrieved in the last ten minutes (dexFigures.ts), attributed to it;
 *   3. the last figure this browser saw, up to a day old;
 *   4. the figures today's selection of Top pools was made with (featured list `rankInputs`), dated at the selection.
 *
 * Each stands-in figure keeps its source and the time it was observed (`asOf`), is marked as not current (stale) unless
 * it is DEX Screener's own fresh figure, and says all of it in its title (MetricCell). A refusal for good (a rejected
 * identity, a pool the provider does not list) is not stood in for. Nothing is ever worked out from nothing: the APR
 * stand-in is the read service's own estimate as last seen, today's selection's, or the read service's own method
 * (fixed LP fee × 24h volume ÷ TVL × 365, rowApr.ts) on DEX Screener's two figures, labelled an estimate.
 *
 * Pure: the inputs come in, the row goes out. lib/read/useFallback.ts hands it the browser's memory, DEX Screener's
 * figures and the list on screen.
 */
import type { FallbackApr, FigureFallback, Instant, Market, Metric } from '../markets'
import { presentAprEstimate } from './aprEstimate'
import type { DexPool } from './dexFigures'
import type { KeptFigures } from './figureMemory'
import { KEPT_MAX_AGE_S } from './figureMemory'
import { rowApr } from './screens/rowApr'
import type { AttributedFigure } from './screens/figures'
import { formatUsdCompact, parseDecimal } from './decimal'

/** A kept figure younger than this is shown before DEX Screener's: one source, no jumps between two providers' numbers. */
export const KEPT_PREFERRED_S = 30 * 60

/** The provider's refusals that a later read can clear: the only ones stood in for. */
export const PASSING_REFUSALS: ReadonlySet<string> = new Set(['provider_capacity_busy', 'provider_rate_limited', 'provider_unavailable'])

/**
 * Reasons an estimate is missing that a stand-in may fill: its market inputs were refused or are older than the
 * estimate's own limit. Anything else (hooks, a dynamic or directional fee, a rejected identity, no TVL reported) says
 * the method does not describe the pool, and nothing stands in.
 */
const PASSING_ESTIMATE: ReadonlySet<string> = new Set(['market_unavailable', 'market_data_expired', 'snapshot_expired', 'provider_observation_stale', 'market_cache_stale', 'retained_after_refresh_failure'])

/** Today's selection's figures for a featured pool (featured list `rankInputs`), as the list wrote them. */
export interface SelectionFigures {
  tvlUsd: string
  volume24hUsd: string
  apr: string
  /** Unix seconds: when the selection evaluated them. */
  evaluatedAt: number
}

export interface FallbackInputs {
  kept: KeptFigures | null
  dex: DexPool | null
  selection: SelectionFigures | null
  now: Instant
}

/** Whether a figure was refused for the moment: unavailable for a reason a later read can clear. */
export const refusedFigure = (metric: Metric) => metric.state === 'unavailable' && PASSING_REFUSALS.has(metric.reason ?? '')

const qualifiedApr = (row: Market) => row.feeAprPercent.value !== null && (row.feeAprPercent.state === 'qualified' || row.feeAprPercent.state === 'stale')

/** Whether the APR estimate a pool's row shows is missing for a reason a stand-in may fill (see PASSING_ESTIMATE). */
export function estimateRefused(row: Market, now: Instant): boolean {
  if (qualifiedApr(row) || row.integration === 'requires_separate_adapter' || (row.hooks !== undefined && !/^0x0{40}$/.test(row.hooks)) || row.feePips === null) return false
  const shown = presentAprEstimate(row.feeAprEstimate, now)
  if (shown.text !== null) return false
  if (refusedFigure(row.tvlUsd) || refusedFigure(row.volume24hUsd)) return true
  return shown.reasons.length > 0 && shown.reasons.every((reason) => PASSING_ESTIMATE.has(reason))
}

/** Whether a row has anything a stand-in may fill. */
export const needsFallback = (row: Market, now: Instant) => refusedFigure(row.tvlUsd) || refusedFigure(row.volume24hUsd) || estimateRefused(row, now)

const nowSeconds = (now: Instant) => Math.floor(now.wall / 1000)

type FigurePick = { basis: FigureFallback; tvl: string | null; volume: string | null; at: number }

/** The source a refused pair of figures stands in from, in the header's order; null when there is none. */
export function pickFigures(inputs: FallbackInputs): FigurePick | null {
  const at = nowSeconds(inputs.now)
  const kept = inputs.kept && (inputs.kept.tvl !== null || inputs.kept.volume !== null) && at - inputs.kept.at <= KEPT_MAX_AGE_S ? inputs.kept : null
  const keptPick: FigurePick | null = kept ? { basis: 'kept', tvl: kept.tvl, volume: kept.volume, at: kept.at } : null
  if (keptPick && at - keptPick.at <= KEPT_PREFERRED_S) return keptPick
  const dex = inputs.dex && (inputs.dex.liquidityUsd !== null || inputs.dex.volume24hUsd !== null) ? inputs.dex : null
  if (dex) return { basis: 'dexscreener', tvl: dex.liquidityUsd, volume: dex.volume24hUsd, at: dex.retrievedAt }
  if (keptPick) return keptPick
  const selection = inputs.selection
  return selection ? { basis: 'selection', tvl: selection.tvlUsd, volume: selection.volume24hUsd, at: selection.evaluatedAt } : null
}

/** A stand-in figure: DEX Screener's own is current as the provider's; any other is a retained one, stale and dated. */
function standIn(value: string | null, pick: FigurePick): Metric | null {
  if (value === null || !parseDecimal(value)) return null
  return pick.basis === 'dexscreener'
    ? { value, state: 'provider', asOf: pick.at, source: 'DexScreener', fallback: 'dexscreener' }
    : { value, state: 'stale', asOf: pick.at, source: 'GeckoTerminal', fallback: pick.basis }
}

const attributed = (raw: string | null, retrievedAt: number): AttributedFigure =>
  raw === null || formatUsdCompact(raw) === null
    ? { state: 'not_reported', provider: 'dexscreener' }
    : { state: 'attributed', value: formatUsdCompact(raw) as string, raw, zero: parseDecimal(raw)?.coefficient === 0n, provider: 'dexscreener', retrievedAt, cacheAgeSeconds: null }

/** The APR estimate a row stands in with, in the header's order; null when there is none. */
export function pickApr(row: Pick<Market, 'feePips' | 'integration' | 'protocolFeeRaw'>, inputs: FallbackInputs): FallbackApr | null {
  const at = nowSeconds(inputs.now)
  const kept = inputs.kept && inputs.kept.apr !== null && inputs.kept.aprAt !== null && at - inputs.kept.aprAt <= KEPT_MAX_AGE_S ? inputs.kept : null
  const keptApr: FallbackApr | null = kept ? { percent: kept.apr as string, asOf: kept.aprAt as number, basis: 'kept' } : null
  if (keptApr && at - keptApr.asOf <= KEPT_PREFERRED_S) return keptApr
  const dex = inputs.dex
  if (dex && row.feePips !== null && row.integration !== undefined) {
    const estimate = rowApr({ integration: row.integration, currentLpFeePips: row.feePips, protocolFeeRaw: row.protocolFeeRaw, liquidity: attributed(dex.liquidityUsd, dex.retrievedAt), volume: attributed(dex.volume24hUsd, dex.retrievedAt) })
    if (estimate.kind === 'estimate') return { percent: estimate.text, asOf: dex.retrievedAt, basis: 'dexscreener' }
  }
  if (keptApr) return keptApr
  return inputs.selection && parseDecimal(inputs.selection.apr) ? { percent: inputs.selection.apr, asOf: inputs.selection.evaluatedAt, basis: 'selection' } : null
}

/** The row as it is shown: refused figures stood in for where there is something to stand in with (see the header). */
export function withFallback(row: Market, inputs: FallbackInputs): Market {
  let out = row
  if (refusedFigure(row.tvlUsd) || refusedFigure(row.volume24hUsd)) {
    const pick = pickFigures(inputs)
    if (pick) {
      const tvl = refusedFigure(row.tvlUsd) ? standIn(pick.tvl, pick) : null
      const volume = refusedFigure(row.volume24hUsd) ? standIn(pick.volume, pick) : null
      out = { ...out, ...(tvl ? { tvlUsd: tvl } : {}), ...(volume ? { volume24hUsd: volume } : {}) }
    }
  }
  if (estimateRefused(row, inputs.now)) {
    const apr = pickApr(row, inputs)
    if (apr) out = { ...out, aprFallback: apr }
  }
  return out
}

/** Figures for a pool with no row at all (still being collected, or not read): the same stand-ins, for its catalogue row. */
export function catalogueFallback(inputs: FallbackInputs, pool: Pick<Market, 'feePips' | 'integration' | 'protocolFeeRaw'>): { tvl: Metric | null; volume: Metric | null; apr: FallbackApr | null } {
  const pick = pickFigures(inputs)
  return {
    tvl: pick ? standIn(pick.tvl, pick) : null,
    volume: pick ? standIn(pick.volume, pick) : null,
    apr: pickApr(pool, inputs),
  }
}
