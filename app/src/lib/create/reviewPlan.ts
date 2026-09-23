/**
 * Review's reading of the position before Create position is pressed: what
 * it takes of each token at the pool's price as read, and how the wallet
 * funds it from the balances the read service reports (depositPlan.ts). The
 * final control uses the same reading to hold Create position back when the
 * wallet cannot fund it either way; Create position reads the wallet again
 * through the wallet itself and decides from what it finds.
 *
 * Native ETH is counted after a gas allowance larger than the steps cost at
 * Robinhood Chain's usual gas price, so Review is never more hopeful than
 * Create position, which keeps the steps' own gas at the price it reads.
 *
 * Nothing here reads the chain or the wallet, and nothing here signs.
 */
import { ASSISTED_SWAP_FEE_BPS, depositPlan, type DepositPlan, type Side } from './depositPlan'
import { candidateDecimals, validateBudget, validateSlippage, type JourneyState } from './journey'
import { pairedAmount } from './pairAmount'
import { NATIVE_CURRENCY } from '../read/screens/identity'

/** The ETH Review keeps back for network gas when native ETH is one of the pool's tokens: 0.0005 ETH. */
export const REVIEW_GAS_RESERVE_WEI = 500_000_000_000_000n

export interface ReviewPlan {
  /** The token the amount was typed in. */
  independent: Side
  /** What the position takes of each token at the pool's price as read: the typed amount and the one the range pairs with it. */
  need: readonly [bigint, bigint]
  /** How the wallet funds it; null while its balances are unknown. */
  plan: DepositPlan | null
}

/** Review's reading for these choices and these raw balances (in pool order), or null while a choice is missing or unusable. */
export function reviewPlan(state: JourneyState, balances: readonly [string | null, string | null] | null): ReviewPlan | null {
  const { pool, token, range } = state
  if (!pool || !token || !range) return null
  const found = pool.currencies.findIndex((currency) => currency.address === token.key)
  if (found !== 0 && found !== 1) return null
  const independent: Side = found === 0 ? 0 : 1
  const budget = validateBudget(state.budget, candidateDecimals(token))
  if (!budget.ok) return null
  const other = pairedAmount({ sqrtPriceX96: pool.sqrtPriceX96, tickLower: range.lower, tickUpper: range.upper, independent, amountRaw: budget.raw })
  if (other.kind !== 'amount') return null
  const need: readonly [bigint, bigint] = independent === 0 ? [BigInt(budget.raw), BigInt(other.raw)] : [BigInt(other.raw), BigInt(budget.raw)]
  const slippage = validateSlippage(state.slippageBps)
  if (!slippage.ok || !balances || balances[0] === null || balances[1] === null) return { independent, need, plan: null }
  const spendable = (raw: string, index: Side) => {
    const value = BigInt(raw)
    if (pool.currencies[index].address !== NATIVE_CURRENCY) return value
    return value > REVIEW_GAS_RESERVE_WEI ? value - REVIEW_GAS_RESERVE_WEI : 0n
  }
  const plan = depositPlan({
    terms: { sqrtPriceX96: BigInt(pool.sqrtPriceX96), tickLower: range.lower, tickUpper: range.upper, feePips: pool.feePips, assistedFeeBps: ASSISTED_SWAP_FEE_BPS, slippageBps: slippage.bps },
    independent,
    typedRaw: BigInt(budget.raw),
    need0: need[0],
    need1: need[1],
    slippageBps: slippage.bps,
    balances: [spendable(balances[0], 0), spendable(balances[1], 1)],
  })
  return { independent, need, plan }
}
