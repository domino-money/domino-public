import { profileRank, v2Chain } from '../../v2/chains'
import type { PriceOrientation } from '../../v2/trigger'
import type { Address, V2ChainId } from '../../v2/types'

/**
 * The orientation an exit order's prices are first typed in (spec F7 §4.3: the app translates; the person may turn it
 * round): the chain's stable when the pool has it ("USDG per ETH"), else ETH, else the pool's own order, the rule the
 * app's other screens write prices by (lib/read/orientation.ts), by the chain profile's charge-currency ranks. Pure.
 */
export function defaultOrientation(chainId: V2ChainId, pool: { currency0: Address; currency1: Address }): PriceOrientation {
  const chain = v2Chain(chainId)
  const score = (token: Address) => {
    const rank = profileRank(chain, token)
    return rank === 1 ? 2 : rank === 2 ? 1 : 0
  }
  return score(pool.currency0) > score(pool.currency1) ? 'token0PerToken1' : 'token1PerToken0'
}
