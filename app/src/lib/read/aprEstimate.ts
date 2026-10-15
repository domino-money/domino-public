import type { PoolAprEstimate } from 'api-contracts/read-v2/types'
import type { Instant } from '../markets'
import { aprDigits } from '../format/apr'

/** The exact producer result is retained separately from qualified historical APR. */
export interface AprEstimateObservation {
  data: PoolAprEstimate | null
  reason?: string
  receivedAt: number
  receivedMonotonic?: number
  retained?: boolean
}

type Limitation = PoolAprEstimate['limitations'][number]

/**
 * The producer's limitations, each as one sentence. Every estimate carries
 * its own list, so what an estimate is not is said from the payload, never
 * from a caveat written here.
 */
const LIMITATIONS: Record<Limitation, string> = {
  provider_reported_volume_and_tvl_unreconciled: 'From a market data provider’s reported 24h volume and TVL, not reconciled.',
  provider_update_time_unknown: 'The provider’s update time is unknown.',
  current_tvl_not_time_weighted: 'Current TVL, not time-weighted.',
  assumes_current_fixed_lp_fee_for_24h_volume: 'Assumes the current fixed LP fee for the whole 24h volume.',
  protocol_fee_effect_not_reconciled: 'The protocol fee’s effect is not reconciled.',
  no_full_day_coverage_proof: 'Full-day coverage is not proven.',
  excludes_rewards_gas_service_fees_and_price_pnl: 'Excludes rewards, gas, service fees and price changes.',
  pool_estimate_not_position_apr_or_apy: 'Pool estimate, not position APR or APY.',
  not_a_return_forecast_or_recommendation: 'Not a return forecast or a recommendation.',
}

/** What any estimate is, said when there is none to carry its own limitations. */
export const ESTIMATE_SCOPE = 'Pool estimate, not position APR, APY or a return forecast.'

/** A limitation code as its sentence; a code this build does not know, as plain words. */
export const limitationText = (code: string) => LIMITATIONS[code as Limitation] ?? `${code.replace(/_/g, ' ')}.`

export function presentAprEstimate(observation: AprEstimateObservation | undefined, now: Instant) {
  const data = observation?.data
  if (!data || !observation) return { state: 'unavailable' as const, text: null, reasons: [observation?.reason ?? 'estimate_not_enabled'], ageSeconds: null }
  const elapsed = Math.max(0, Math.floor((now.monotonic !== undefined && observation.receivedMonotonic !== undefined
    ? now.monotonic - observation.receivedMonotonic : now.wall - observation.receivedAt) / 1000))
  const p = data.provenance
  const age = p.effectiveMarketAgeSeconds === null ? null : p.effectiveMarketAgeSeconds + elapsed
  const snapshotAge = p.snapshotAgeSeconds === null ? null : p.snapshotAgeSeconds + elapsed
  const reasons: string[] = [...data.reasons]
  if (age !== null && age > p.maxStaleSeconds) reasons.push('market_data_expired')
  if (snapshotAge !== null && snapshotAge > p.maxStaleSeconds) reasons.push('snapshot_expired')
  if (data.status === 'unavailable' || data.feeAprEstimate24hPercent === null || reasons.some((r) => r === 'market_data_expired' || r === 'snapshot_expired')) {
    return { state: 'unavailable' as const, text: null, reasons: [...new Set(reasons)], ageSeconds: age }
  }
  if (age !== null && age >= p.freshForSeconds) reasons.push('market_cache_stale')
  if (snapshotAge !== null && snapshotAge > p.snapshotFreshForSeconds) reasons.push('onchain_snapshot_stale')
  if (observation.retained) reasons.push('retained_after_refresh_failure')
  const value = data.feeAprEstimate24hPercent
  // The one APR rule of every screen (lib/format/apr.ts, audit E21, 2026-10-01): "27.2", "530", "<0.1".
  const text = aprDigits(value)
  return { state: data.status === 'stale' || reasons.length ? 'stale' as const : 'available' as const, text, reasons: [...new Set(reasons)], ageSeconds: age }
}

const REASONS: Record<string, string> = {
  estimate_not_enabled: 'Estimated APR is not enabled on this connection.',
  estimate_transport_unavailable: 'Estimated APR is unavailable; market figures use the supported read connection.',
  estimate_not_in_snapshot: 'Estimated APR is read with the pool’s own market figures, not with stored ones.',
  estimate_contract_mismatch: 'Estimated APR is unavailable: the read service answered in an estimate format this page does not accept.',
  retained_after_refresh_failure: 'A refresh failed; this estimate is retained and is not current.',
  protocol_fee_unsupported: 'A nonzero protocol fee prevents this estimate.',
  protocol_fee_directional_unsupported: 'Asymmetric directional protocol fees cannot be applied to aggregate volume.',
  invalid_protocol_fee: 'The protocol fee could not be validated.',
  market_data_expired: 'Provider inputs are older than the five-minute limit.',
  snapshot_expired: 'The pool snapshot is older than the five-minute limit.',
  market_cache_stale: 'Provider inputs are stale.',
  provider_observation_stale: 'The provider observation is stale.',
  onchain_snapshot_stale: 'The pool snapshot is stale.',
  zero_reported_tvl: 'Reported TVL is zero, so APR cannot be estimated.',
  missing_reported_tvl: 'Reported TVL is missing.',
  missing_volume24h: 'Reported 24h volume is missing.',
  dynamic_fee_unsupported: 'Dynamic fees are not supported by this estimate.',
  hooked_pool_unsupported: 'Hooked pools require a separate estimate method.',
  estimate_below_display_precision: 'The estimate is below the producer’s display precision.',
}
export const aprReason = (reason: string) => REASONS[reason] ?? reason.replace(/_/g, ' ')

/**
 * The estimate's title: its own limitations. With no estimate at all, what the figure would have been.
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis only. Why an estimate is unavailable
 * or kept (its reasons, aprReason: "A refresh failed; this estimate is retained and is not current.", "Provider inputs
 * are stale.", "Estimated APR is not enabled on this connection.", …) and "Stale, not current." are no longer added;
 * the reasons stay as data (`data-apr-reasons`), and the title no longer depends on the time (`now` is gone).
 */
export function estimateTitle(observation: AprEstimateObservation | undefined): string {
  const limits = observation?.data ? observation.data.limitations.map(limitationText) : [ESTIMATE_SCOPE]
  return limits.join(' ')
}
