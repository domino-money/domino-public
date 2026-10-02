/**
 * Uniswap v3's position math, exactly, in bigint (2026-10-01, the chain2 workstream, audit item G7): what a position
 * holds at a price, the fees it earned and has not collected, whether the price is in its range, and how a page writes a
 * v3 pool's price. Reused, not copied: TickMath and the liquidity amounts are the app's own (lib/read/screens/poolRange.ts
 * sqrtPriceAtTick, lib/create/pairAmount.ts), which are v4-core's and identical to v3-core's; the price strings are
 * lib/format/price.ts's.
 *
 * The fees are the NonfungiblePositionManager's own arithmetic (periphery 1.4.4, Solidity 0.7.6, where subtraction wraps
 * and uint128() truncates): the fee growth inside the range from the pool's global growth and the two ticks' outside
 * growth (core's Tick.getFeeGrowthInside), then tokensOwed plus liquidity × (inside − insideLast) / 2^128, as collect()
 * would pay them if it were called at that block. No floating point anywhere a figure comes from.
 *
 * Pure, Node-safe.
 */
import { amount0ForLiquidity, amount1ForLiquidity } from '../lib/create/pairAmount'
import { priceFromSqrtIn } from '../lib/format/price'
import { sqrtPriceAtTick } from '../lib/read/screens/poolRange'

const Q128 = 1n << 128n
const U256 = (1n << 256n) - 1n
const U128 = (1n << 128n) - 1n

/** a − b modulo 2^256, as Solidity 0.7 subtracts uint256. */
const sub256 = (a: bigint, b: bigint) => (a - b) & U256

export interface TickOutside {
  feeGrowthOutside0X128: bigint
  feeGrowthOutside1X128: bigint
}

/** Core's Tick.getFeeGrowthInside: the fee growth per unit of liquidity inside [lower, upper) at `tickCurrent`. */
export function feeGrowthInside(
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
  lower: TickOutside,
  upper: TickOutside,
  global0: bigint,
  global1: bigint,
): readonly [bigint, bigint] {
  const below0 = tickCurrent >= tickLower ? lower.feeGrowthOutside0X128 : sub256(global0, lower.feeGrowthOutside0X128)
  const below1 = tickCurrent >= tickLower ? lower.feeGrowthOutside1X128 : sub256(global1, lower.feeGrowthOutside1X128)
  const above0 = tickCurrent < tickUpper ? upper.feeGrowthOutside0X128 : sub256(global0, upper.feeGrowthOutside0X128)
  const above1 = tickCurrent < tickUpper ? upper.feeGrowthOutside1X128 : sub256(global1, upper.feeGrowthOutside1X128)
  return [sub256(sub256(global0, below0), above0), sub256(sub256(global1, below1), above1)]
}

export interface OwedInput {
  liquidity: bigint
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

/** What collect() would pay the position at the block its inputs were read at: the manager's arithmetic, wrap included. */
export function uncollectedFees(position: OwedInput, inside: readonly [bigint, bigint]): readonly [bigint, bigint] {
  const earned0 = ((sub256(inside[0], position.feeGrowthInside0LastX128) * position.liquidity) / Q128) & U128
  const earned1 = ((sub256(inside[1], position.feeGrowthInside1LastX128) * position.liquidity) / Q128) & U128
  return [(position.tokensOwed0 + earned0) & U128, (position.tokensOwed1 + earned1) & U128]
}

/** Periphery's LiquidityAmounts.getAmountsForLiquidity: what `liquidity` holds of each token at `sqrtPriceX96`, rounded down. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): readonly [bigint, bigint] {
  const sqrtA = sqrtPriceAtTick(tickLower)
  const sqrtB = sqrtPriceAtTick(tickUpper)
  if (sqrtPriceX96 <= sqrtA) return [amount0ForLiquidity(sqrtA, sqrtB, liquidity), 0n]
  if (sqrtPriceX96 < sqrtB) return [amount0ForLiquidity(sqrtPriceX96, sqrtB, liquidity), amount1ForLiquidity(sqrtA, sqrtPriceX96, liquidity)]
  return [0n, amount1ForLiquidity(sqrtA, sqrtB, liquidity)]
}

/** v3 counts a position in range while lower ≤ tick < upper. */
export const inRange = (tick: number, tickLower: number, tickUpper: number): boolean => tick >= tickLower && tick < tickUpper

/**
 * The share of a swap fee the pool's liquidity providers keep, per token: all of it while the protocol fee is off (0), or
 * all but 1/N of it where N is the token's protocol fee (slot0.feeProtocol: token0's in the low four bits, token1's in
 * the high four).
 */
export function providerShare(feeAmount: bigint, feeProtocol: number, side: 0 | 1): bigint {
  const n = side === 0 ? feeProtocol % 16 : feeProtocol >> 4
  return n === 0 ? feeAmount : feeAmount - feeAmount / BigInt(n)
}

/**
 * The fees a pool's providers earned from what swappers paid in, an estimate: the fee tier (in millionths) of each
 * token paid in, less the protocol's share. Exact per swap step in the pool; this takes the swap's whole input, so it is
 * written with "≈" on the page.
 */
export function providerFees(paidIn: readonly [bigint, bigint], feePips: number, feeProtocol: number): readonly [bigint, bigint] {
  const fee = BigInt(feePips)
  return [providerShare((paidIn[0] * fee) / 1_000_000n, feeProtocol, 0), providerShare((paidIn[1] * fee) / 1_000_000n, feeProtocol, 1)]
}

/**
 * A v3 pool's price as the page writes it, "1 BASE = text QUOTE": token1 per token0, or token0 per token1 where the
 * chain's quote ranks say the first token is the one value is counted in (`inverted`). Eighteen fraction digits,
 * truncated, as lib/format/price.ts writes them; null when a token's decimals are unknown.
 */
export function priceText(sqrtPriceX96: bigint, decimals0: number | null, decimals1: number | null, inverted: boolean): string | null {
  if (decimals0 === null || decimals1 === null || sqrtPriceX96 <= 0n) return null
  return priceFromSqrtIn(sqrtPriceX96, decimals0, decimals1, inverted)
}
