/**
 * The mint a funded setup operation can make of its balances: the liquidity
 * both balances cover wherever the price sits in the band the mint must find
 * the pool inside, capped by the balances.
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

/**
 * The band the mint must find the pool inside, clamped to the range: `low` is
 * the price currency0's need is sized at (the band's floor, or the range's
 * lower edge when that is higher), `high` the one currency1's is (the band's
 * ceiling, or the range's upper edge when that is lower).
 */
export interface Band {
  minSqrtPriceX96: bigint
  maxSqrtPriceX96: bigint
  sqrtLower: bigint
  sqrtUpper: bigint
  low: bigint
  high: bigint
}

/** The band around this price for this slippage limit and range, or null when the inputs make none. */
export function bandFor(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, slippageBps: number): Band | null {
  let sqrtLower: bigint
  let sqrtUpper: bigint
  try {
    sqrtLower = sqrtPriceAtTick(tickLower)
    sqrtUpper = sqrtPriceAtTick(tickUpper)
  } catch {
    return null
  }
  if (sqrtPriceX96 <= 0n || sqrtLower >= sqrtUpper) return null
  if (!Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS) return null
  // The price may sit anywhere in the band when the mint executes (the contract checks it is inside). What a
  // liquidity takes of currency0 grows as the price falls, of currency1 as it rises: size for the worst of each,
  // so the mint fits the balances wherever in the band it lands. What it does not use returns with the NFT.
  const band = BigInt(slippageBps)
  const minSqrtPriceX96 = (sqrtPriceX96 * (20000n - band)) / 20000n
  const maxSqrtPriceX96 = (sqrtPriceX96 * (20000n + band) + 19999n) / 20000n
  if (minSqrtPriceX96 <= 0n || maxSqrtPriceX96 >= 2n ** 160n) return null
  return {
    minSqrtPriceX96,
    maxSqrtPriceX96,
    sqrtLower,
    sqrtUpper,
    low: minSqrtPriceX96 > sqrtLower ? minSqrtPriceX96 : sqrtLower,
    high: maxSqrtPriceX96 < sqrtUpper ? maxSqrtPriceX96 : sqrtUpper,
  }
}

/**
 * The liquidity each balance covers anywhere in the band: [from currency0,
 * from currency1], null for a side the band does not need at all (wholly
 * below the range only currency0 funds it, wholly above only currency1).
 */
export function bandLiquidity(band: Band, balance0: bigint, balance1: bigint): readonly [bigint | null, bigint | null] {
  return [
    band.low < band.sqrtUpper ? liquidityForAmount0(band.low, band.sqrtUpper, balance0) : null,
    band.high > band.sqrtLower ? liquidityForAmount1(band.sqrtLower, band.high, balance1) : null,
  ]
}

/** The mint for these balances at this price, or null when the inputs make none. */
export function mintPlanFor(input: MintInput): MintPlan | null {
  let sqrtPrice: bigint
  try {
    sqrtPrice = BigInt(input.sqrtPriceX96)
  } catch {
    return null
  }
  const { balance0, balance1 } = input
  if (balance0 < 0n || balance1 < 0n) return null
  const band = bandFor(sqrtPrice, input.tickLower, input.tickUpper, input.slippageBps)
  if (!band) return null
  const [from0, from1] = bandLiquidity(band, balance0, balance1)
  const exact = from0 === null ? from1 : from1 === null ? from0 : from0 < from1 ? from0 : from1
  if (exact === null) return null
  const liquidity = (exact * (10000n - LIQUIDITY_SLACK_BPS)) / 10000n
  if (liquidity <= 0n || liquidity >= 2n ** 127n) return null
  return { liquidity, maxAmount0: balance0, maxAmount1: balance1, minSqrtPriceX96: band.minSqrtPriceX96, maxSqrtPriceX96: band.maxSqrtPriceX96, initialSqrtPriceX96: 0n }
}
