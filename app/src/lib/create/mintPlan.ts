/**
 * The mint a funded setup operation can make of its balances: the liquidity
 * the range takes at the pool's price, capped by both balances, and the price
 * band the mint must find the pool inside.
 *
 * Exact integer arithmetic on the same v4-core helpers the paired amount uses
 * (pairAmount.ts): inside the range each balance fixes a liquidity, and the
 * smaller one is what both balances cover. Wholly below the range only
 * currency0 funds it, wholly above only currency1. A small part is kept back
 * from that liquidity so the pool's round-up on each side still fits inside
 * the funded balances: an exact figure comes out a few units short on one
 * side and the contract refuses it before anything is spent. What the mint
 * does not use returns to the owner with the NFT.
 *
 * The band is the owner's slippage limit, halved for a square-root price: a
 * price that moved more than the limit since the read leaves the pool outside
 * it, and the mint reverts in simulation rather than at a price never shown.
 *
 * Nothing here reads the chain or the wallet, and nothing here signs.
 */
import { sqrtPriceAtTick } from '../read/screens/poolRange'
import { liquidityForAmount0, liquidityForAmount1 } from './pairAmount'
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from './slippage'

/** Kept back from the exact liquidity, in basis points, so each side's round-up fits inside the balances. */
export const LIQUIDITY_SLACK_BPS = 10n

export interface MintInput {
  /** The pool's square-root price as the latest read returned it. */
  sqrtPriceX96: string
  tickLower: number
  tickUpper: number
  /** The setup operation's balances, as read from chain. */
  balance0: bigint
  balance1: bigint
  slippageBps: number
}

export interface MintPlan {
  liquidity: bigint
  maxAmount0: bigint
  maxAmount1: bigint
  minSqrtPriceX96: bigint
  maxSqrtPriceX96: bigint
  /** Zero: the pool exists. Creating a pool is the advanced path's alone. */
  initialSqrtPriceX96: 0n
}

/** The mint for these balances at this price, or null when the inputs make none. */
export function mintPlanFor(input: MintInput): MintPlan | null {
  let sqrtPrice: bigint
  let sqrtLower: bigint
  let sqrtUpper: bigint
  try {
    sqrtPrice = BigInt(input.sqrtPriceX96)
    sqrtLower = sqrtPriceAtTick(input.tickLower)
    sqrtUpper = sqrtPriceAtTick(input.tickUpper)
  } catch {
    return null
  }
  const { balance0, balance1, slippageBps } = input
  if (sqrtPrice <= 0n || sqrtLower >= sqrtUpper || balance0 < 0n || balance1 < 0n) return null
  if (!Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS) return null

  let exact: bigint
  if (sqrtPrice <= sqrtLower) exact = liquidityForAmount0(sqrtLower, sqrtUpper, balance0)
  else if (sqrtPrice >= sqrtUpper) exact = liquidityForAmount1(sqrtLower, sqrtUpper, balance1)
  else {
    const from0 = liquidityForAmount0(sqrtPrice, sqrtUpper, balance0)
    const from1 = liquidityForAmount1(sqrtLower, sqrtPrice, balance1)
    exact = from0 < from1 ? from0 : from1
  }
  const liquidity = (exact * (10000n - LIQUIDITY_SLACK_BPS)) / 10000n
  if (liquidity <= 0n || liquidity >= 2n ** 127n) return null

  const band = BigInt(slippageBps)
  const minSqrtPriceX96 = (sqrtPrice * (20000n - band)) / 20000n
  const maxSqrtPriceX96 = (sqrtPrice * (20000n + band) + 19999n) / 20000n
  if (minSqrtPriceX96 <= 0n || maxSqrtPriceX96 >= 2n ** 160n) return null
  return { liquidity, maxAmount0: balance0, maxAmount1: balance1, minSqrtPriceX96, maxSqrtPriceX96, initialSqrtPriceX96: 0n }
}
