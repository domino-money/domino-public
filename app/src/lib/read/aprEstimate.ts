import type { PoolAprEstimate } from 'api-contracts/read-v2/types'
import type { Instant } from '../markets'
import { compare, toFixed } from './decimal'

/** The exact producer result is retained separately from qualified historical APR. */
export interface AprEstimateObservation {
  data: PoolAprEstimate | null
  reason?: string
  receivedAt: number
  receivedMonotonic?: number
  retained?: boolean
}

export const APR_CAVEAT = 'Estimated from GeckoTerminal’s reported 24h volume and current TVL using the current fixed LP fee. Unreconciled, without full-day coverage; excludes rewards, gas, service fees and price changes. Pool estimate, not position APR, APY or a return forecast.'

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
  const text = compare(value, '0') === 1 && compare(value, '0.01') === -1 ? '<0.01' : toFixed(value, 2)
  return { state: data.status === 'stale' || reasons.length ? 'stale' as const : 'available' as const, text, reasons: [...new Set(reasons)], ageSeconds: age }
}

const REASONS: Record<string, string> = {
  estimate_not_enabled: 'Estimated APR is not enabled on this connection.',
  estimate_transport_unavailable: 'Estimated APR is unavailable; market figures use the supported read connection.',
  retained_after_refresh_failure: 'A refresh failed; this estimate is retained and is not current.',
  protocol_fee_unsupported: 'A nonzero protocol fee prevents this estimate.',
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
