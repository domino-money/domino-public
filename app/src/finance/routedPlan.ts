import type { SwapRoutePlan } from '../../../api-contracts/onboarding-v1/types'
import { mintPlanFor } from '../lib/create/mintPlan'
import type { BatchPlan, PoolKey } from './setup'

/** Existing mint maths, funded from the least the router guarantees, never the estimate. */
export function routedBatchPlan(preview: SwapRoutePlan, totalInput: bigint, key: PoolKey,
  range: { tickLower: number; tickUpper: number; slippageBps: number }, sqrtPriceX96: bigint): BatchPlan {
  if (preview.decision !== 'uniswap' || !preview.uniswap || preview.request.amountRaw === '0') throw new Error('invalid_routed_swap')
  const gross = BigInt(preview.request.amountRaw), minimum = BigInt(preview.uniswap.minimumAmountOutRaw)
  const from0 = preview.request.tokenIn.toLowerCase() === key.currency0.toLowerCase()
  if ((!from0 && preview.request.tokenIn.toLowerCase() !== key.currency1.toLowerCase()) || gross > totalInput || minimum <= 0n) throw new Error('invalid_routed_swap')
  const amount0 = from0 ? totalInput - gross : minimum
  const amount1 = from0 ? minimum : totalInput - gross
  const mint = mintPlanFor({ sqrtPriceX96: String(sqrtPriceX96), ...range, balance0: amount0, balance1: amount1 })
  if (!mint) throw new Error('swap_makes_no_position')
  return { key, amount0, amount1, swap: null, mint: { tickLower: range.tickLower, tickUpper: range.tickUpper, ...mint }, routed: { preview, totalInput } }
}

/** Requoting may renew a deadline, never silently change the reviewed economics. */
export function routedTermsKey(preview: SwapRoutePlan, totalInput: bigint): string {
  const u = preview.uniswap
  return JSON.stringify([preview.request, String(totalInput), preview.tokenOut, preview.decision,
    u?.amountOutRaw, u?.minimumAmountOutRaw, u?.feeRaw, u?.minimumFeeRaw, u?.priceImpactPercent, preview.advantageBps])
}
