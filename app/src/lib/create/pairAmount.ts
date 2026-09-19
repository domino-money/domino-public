/**
 * The other token's amount for a position: what a range and a price make the
 * second deposit, given an amount of the first.
 *
 * A concentrated position holds both of a pool's currencies, in a ratio the
 * range and the current price fix. Typing an amount of one currency therefore
 * determines the other: that is what Uniswap's own interface shows in its two
 * linked fields, and what `independentToken` plus `amountRaw` mean in
 * onboarding-v1's position preview.
 *
 * Exact integer arithmetic, from the pool's own `sqrtPriceX96` as read and the
 * chosen ticks through `sqrtPriceAtTick`, which is v4-core's `TickMath` — the
 * same inputs the service uses. No floating point and no price approximation.
 *
 * This is the amount at the price of the read it came from; the mint rounds in
 * the pool's favour and the price moves. The authority stays the service's
 * position preview, which reports the expected deposit, the maximum debit with
 * slippage and whether the wallet covers it. Nothing here signs or deposits.
 */
import { sqrtPriceAtTick } from '../read/screens/poolRange'

const Q96 = 1n << 96n

const ordered = (a: bigint, b: bigint): readonly [bigint, bigint] => (a > b ? [b, a] : [a, b])

/** L for an amount of currency0 held between two prices (v4-core LiquidityAmounts.getLiquidityForAmount0). */
function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  if (high === low) return 0n
  return (amount0 * ((low * high) / Q96)) / (high - low)
}

/** L for an amount of currency1 held between two prices (getLiquidityForAmount1). */
function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  if (high === low) return 0n
  return (amount1 * Q96) / (high - low)
}

/** The currency0 a liquidity holds between two prices (getAmount0ForLiquidity). */
function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  if (low === 0n || high === low) return 0n
  return (((liquidity * Q96) * (high - low)) / high) / low
}

/** The currency1 a liquidity holds between two prices (getAmount1ForLiquidity). */
function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  return (liquidity * (high - low)) / Q96
}

export interface PairInput {
  /** The pool's square-root price as the pools read returned it. */
  sqrtPriceX96: string
  tickLower: number
  tickUpper: number
  /** Which currency the amount is in: its index in the pool key. */
  independent: 0 | 1
  /** That amount, in the currency's raw units. */
  amountRaw: string
}

export type PairAmount =
  /** The other currency's amount, raw. `only` names the single currency this range takes at this price. */
  | { kind: 'amount'; raw: string; only: 0 | 1 | null }
  /** The range takes none of the currency the amount is in: this amount buys no position here. */
  | { kind: 'unused'; only: 0 | 1 }
  /** The price or the ticks could not be used, so nothing is claimed. */
  | { kind: 'unknown' }

/**
 * The amount of the pool's other currency, or why there is none.
 *
 * Below the range a position is all currency0, above it all currency1: then one
 * side is zero, and an amount typed into the unused side buys nothing — said as
 * `unused` rather than shown as a zero that looks like a figure.
 */
export function pairedAmount(input: PairInput): PairAmount {
  let sqrtPrice: bigint
  let sqrtLower: bigint
  let sqrtUpper: bigint
  let amount: bigint
  try {
    sqrtPrice = BigInt(input.sqrtPriceX96)
    sqrtLower = sqrtPriceAtTick(input.tickLower)
    sqrtUpper = sqrtPriceAtTick(input.tickUpper)
    amount = BigInt(input.amountRaw)
  } catch {
    return { kind: 'unknown' }
  }
  if (sqrtPrice <= 0n || amount < 0n || sqrtLower >= sqrtUpper) return { kind: 'unknown' }

  // Wholly below the range: the position is currency0 only.
  if (sqrtPrice <= sqrtLower) {
    if (input.independent === 1) return { kind: 'unused', only: 0 }
    return { kind: 'amount', raw: '0', only: 0 }
  }
  // Wholly above it: currency1 only.
  if (sqrtPrice >= sqrtUpper) {
    if (input.independent === 0) return { kind: 'unused', only: 1 }
    return { kind: 'amount', raw: '0', only: 1 }
  }
  // Inside the range, both sides fund it: one side fixes the liquidity, the other follows.
  if (input.independent === 0) {
    const liquidity = liquidityForAmount0(sqrtPrice, sqrtUpper, amount)
    return { kind: 'amount', raw: String(amount1ForLiquidity(sqrtLower, sqrtPrice, liquidity)), only: null }
  }
  const liquidity = liquidityForAmount1(sqrtLower, sqrtPrice, amount)
  return { kind: 'amount', raw: String(amount0ForLiquidity(sqrtPrice, sqrtUpper, liquidity)), only: null }
}
