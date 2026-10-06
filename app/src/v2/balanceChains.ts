/**
 * read-v6's balance chains, Ethereum (1) and OP Mainnet (10), from their published profiles
 * (api-contracts/v2/balance-chains/*.json), read at build time as ./chains.ts reads Domino's three rather than copied by
 * hand. Added 2026-10-06 (rugged97's #379, the owner's decision of 6 Oct): chain-balances also reads these two when a
 * request names them (`tokens`); no Domino V2 deployment, index, plan or automation runs there.
 *
 * Only what a balance read names is taken from each profile: the chain and the three tokens read there, its ETH (the zero
 * address), its WETH and its stable (USDC, the profile's rank-1 charge currency: Circle's native one, never a bridged one),
 * with their symbols and decimals. Named imports, so a build carries those fields alone, never the profile's verification
 * record, notes or sources. Changed on purpose 2026-10-06 (the review: the Domino V2 family over its budget): the profiles'
 * shape (a balance chain's kind, chain 1 or 10, ETH native at the zero address, WETH among the charge currencies, exactly
 * one stable at rank 1, every address well formed) is held by tests/v2/funds-balance-chains.test.mjs, against the very
 * files bundled here, rather than checked again at every load; their names are the app's one table's (lib/networkName.ts),
 * which that test holds to the profiles' own.
 *
 * No viem, no wallet: screens may import this.
 */
import { chainId as ethereumId, chargeCurrencies as ethereumCurrencies, wrappedNative as ethereumWrapped } from '../../../api-contracts/v2/balance-chains/ethereum-1.json'
import { chainId as optimismId, chargeCurrencies as optimismCurrencies, wrappedNative as optimismWrapped } from '../../../api-contracts/v2/balance-chains/optimism-10.json'
import type { Address } from './types'

export type BalanceChainId = 1 | 10

/** A token a balance read names on a balance chain. Address lowercase; address(0) is the chain's ETH. */
export interface BalanceToken {
  address: Address
  symbol: string
  decimals: number
}

export interface BalanceChain {
  chainId: BalanceChainId
  /** Its ETH, WETH and stable, in that order (the order finance/v2/holdings.ts CANDIDATE_ORIGINS reads every network in). */
  tokens: readonly BalanceToken[]
  /** Its wrapped ETH (WETH), lowercase. */
  wrapped: Address
  /** Its stable, the rank-1 charge currency (USDC), lowercase. */
  stable: Address
}

/** One balance chain as a balance read takes it, from its profile's chain id, WETH and charge currencies. */
function chainOf(chainId: number, weth: { address: string }, currencies: readonly { rank: number; symbol: string; address: string; decimals: number }[]): BalanceChain {
  const stable = currencies.find((c) => c.rank === 1)!
  const wrapped = weth.address.toLowerCase() as Address
  const dollar = stable.address.toLowerCase() as Address
  return {
    chainId: chainId as BalanceChainId,
    tokens: Object.freeze([
      { address: '0x0000000000000000000000000000000000000000' as Address, symbol: 'ETH', decimals: 18 },
      { address: wrapped, symbol: 'WETH', decimals: 18 },
      { address: dollar, symbol: stable.symbol, decimals: stable.decimals },
    ]),
    wrapped,
    stable: dollar,
  }
}

/** Ethereum, then OP Mainnet. */
export const BALANCE_CHAINS: readonly BalanceChain[] = Object.freeze([chainOf(ethereumId, ethereumWrapped, ethereumCurrencies), chainOf(optimismId, optimismWrapped, optimismCurrencies)])

/** A balance chain's profile; null for any other network (Domino's own included). */
export function balanceChain(chainId: number): BalanceChain | null {
  return BALANCE_CHAINS.find((chain) => chain.chainId === chainId) ?? null
}
