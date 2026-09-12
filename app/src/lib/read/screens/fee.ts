/**
 * Uniswap v4 LP fees, written exactly.
 *
 * `fee_pips` are hundredths of a basis point: percent = pips / 10 000. The old
 * helpers wrote `(pips / 10000).toFixed(2)`, which shows a valid 1-pip fee as
 * 0.00% and rounds 50 pips away. This one uses integer arithmetic only: at
 * least two decimals, and every further digit that is not zero. The dynamic
 * sentinel (8388608) is not a percentage at all; it means the hook sets the fee.
 */
import type { DynamicPoolKey, FixedPoolKey } from 'api-contracts/read-v1/types'

export const DYNAMIC_FEE_PIPS = 8388608

/** 1 → 0.0001%, 50 → 0.005%, 100 → 0.01%, 3000 → 0.30%, 10000 → 1.00%. */
export function fixedFeePercent(pips: number): string {
  if (Math.trunc(pips) !== pips || pips < 0) return 'Unknown fee'
  const whole = Math.floor(pips / 10_000)
  const fraction = String(pips % 10_000).padStart(4, '0')
  const shown = fraction.slice(0, 2) + fraction.slice(2).replace(/0+$/, '')
  return `${whole}.${shown}%`
}

/** A pool key's fee as the read screens write it. Never `currentLpFeePips` for a dynamic pool. */
export function feeLabel(key: FixedPoolKey | DynamicPoolKey): string {
  return key.feeMode === 'dynamic' ? 'Dynamic' : fixedFeePercent(key.fee_pips)
}

/** For pips carried without a pool key of their own. */
export const feeFromPips = (pips: number) => (pips === DYNAMIC_FEE_PIPS ? 'Dynamic' : fixedFeePercent(pips))
