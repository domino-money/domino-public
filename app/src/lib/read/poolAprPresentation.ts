import type { Instant, Market } from '../markets'
import { presentAprEstimate } from './aprEstimate'

/** One choice for the row and its explanation. Opening Details must not switch the advertised APR's source. */
export function poolAprPresentation(market: Market, now: Instant) {
  const qualified = market.feeAprPercent.value !== null && (market.feeAprPercent.state === 'qualified' || market.feeAprPercent.state === 'stale')
  const estimate = presentAprEstimate(market.feeAprEstimate, now)
  const fallback = !qualified && estimate.text === null ? market.aprFallback ?? null : null
  return { qualified, estimate, fallback, pending: market.figuresPending === true && !qualified && fallback === null && estimate.text === null }
}
