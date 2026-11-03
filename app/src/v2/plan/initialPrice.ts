/**
 * A new pool's starting price (spec F7 rev2 §2.6.5, decision #7): what the person types, in either orientation, turned
 * into the exact `initSqrtPriceX96` and tick the zap initializes the pool with, and read back from that integer in both
 * orientations (the round trip the review shows). Exact integer arithmetic throughout: no float touches the value.
 *
 *   initSqrtPriceX96 = floor(sqrt(P × 10^(d1 − d0)) × 2^96), P = currency1 per one currency0 (whole tokens);
 *   tick = the largest t with getSqrtPriceAtTick(t) ≤ initSqrtPriceX96 (TickMath.getTickAtSqrtPrice).
 *
 * The §7.5 vector: ETH/USDG v4 on Robinhood (currency0 ETH, 18 decimals; currency1 USDG, 6), 2,500 USDG per ETH, stated
 * either way, is 3961408125713216879677197 at tick −198080 (tests/v2/s1-initial-price.test.mjs). The plan API computes
 * the same (docs/v2/V2_S1_PLAN_API.md "New pools"), and the app checks the plan's value against its own (check 13).
 *
 * Pure: no viem, no wallet.
 */
import { readFigure, type Decimal } from '../../lib/create/typedFigure'

export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
export const MIN_TICK = -887272
export const MAX_TICK = 887272

const Q128 = 1n << 128n
const MAX_U256 = (1n << 256n) - 1n
// TickMath's factors (v4-core), bit by bit of |tick|.
const TICK_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
]

/** TickMath.getSqrtPriceAtTick, exactly. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error('tick_out_of_bounds')
  const abs = BigInt(Math.abs(tick))
  let ratio = Q128
  TICK_FACTORS.forEach((factor, bit) => {
    if (abs & (1n << BigInt(bit))) ratio = (ratio * factor) >> 128n
  })
  if (tick > 0) ratio = MAX_U256 / ratio
  const shifted = ratio >> 32n
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n
}

/** TickMath.getTickAtSqrtPrice: the largest tick whose sqrt price is at most `sqrtPriceX96` (by bisection over the exact port). */
export function tickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new Error('sqrt_price_out_of_bounds')
  let low = MIN_TICK
  let high = MAX_TICK
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (sqrtPriceAtTick(mid) <= sqrtPriceX96) low = mid
    else high = mid - 1
  }
  return low
}

/** Integer square root, rounded down (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt_negative')
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** A positive price as an exact fraction `num / den`, with its canonical text (the plan API's `initialPrice.price` form). */
export interface PriceFraction {
  num: bigint
  den: bigint
  /** `^(0|[1-9][0-9]{0,39})(\.[0-9]{1,36})?$`, trailing fraction zeros dropped. */
  text: string
}

/**
 * What a person typed as a price ("2500", "0.0004", "1.25"): surrounding spaces are dropped; anything else that is not a
 * plain positive decimal with at most 40 whole and 36 fraction digits is null.
 *
 * Changed on purpose 2026-11-02 (review of the money PRs, M4): every comma was dropped, so a starting price typed "1,5"
 * set the new pool at 15, and "1,250" at 1250. Commas are read by lib/create/typedFigure.ts's rule now: a page-style
 * "2,500.5" or "2,500,000" loses its separators, an ambiguous "2,500" is refused, and "1,5" is 1.5 where the person's
 * language writes a decimal comma (`decimal`, handed in by a test).
 */
export function parsePriceText(typed: string, decimal?: Decimal): PriceFraction | null {
  const read = readFigure(typed, decimal)
  if (!read.ok) return null
  const clean = read.text
  const match = /^([0-9]{1,40})(?:\.([0-9]{1,36}))?$/.exec(clean)
  if (!match) return null
  const whole = match[1].replace(/^0+(?=[0-9])/, '')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (whole.length > 40) return null
  const den = 10n ** BigInt(fraction.length)
  const num = BigInt(whole) * den + BigInt(fraction || '0')
  if (num === 0n) return null
  return { num, den, text: fraction ? `${whole}.${fraction}` : whole }
}

export interface InitialPriceInput {
  price: PriceFraction
  /** Which currency the typed price is the value of ("one whole base token is worth `price` of the other"). */
  base: 'currency0' | 'currency1'
  decimals0: number
  decimals1: number
}

export interface InitialPriceResult {
  sqrtPriceX96: bigint
  tick: number
}

const decimalsOk = (d: number) => Number.isSafeInteger(d) && d >= 0 && d <= 77

/**
 * The exact `initSqrtPriceX96` and tick for a typed price; null when the decimals are not real token decimals or the
 * value falls outside TickMath's bounds [4295128739, 1461446703485210103287273052203988822378723970342).
 */
export function initialSqrtPrice(input: InitialPriceInput): InitialPriceResult | null {
  if (!decimalsOk(input.decimals0) || !decimalsOk(input.decimals1) || input.price.num <= 0n || input.price.den <= 0n) return null
  // P = currency1 per currency0, as num / den.
  const [pNum, pDen] = input.base === 'currency0' ? [input.price.num, input.price.den] : [input.price.den, input.price.num]
  const shift = input.decimals1 - input.decimals0
  const num = pNum * (shift >= 0 ? 10n ** BigInt(shift) : 1n) * (1n << 192n)
  const den = pDen * (shift < 0 ? 10n ** BigInt(-shift) : 1n)
  // floor(sqrt(x)) = isqrt(floor(x)) for any real x ≥ 0.
  const sqrtPriceX96 = isqrt(num / den)
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) return null
  return { sqrtPriceX96, tick: tickAtSqrtPrice(sqrtPriceX96) }
}

/**
 * A fraction as decimal text with `significant` significant digits, ROUNDED DOWN, digits grouped by thousands
 * ("2,500", "0.0004", "0.799999"); "0" for zero.
 */
export function fractionText(num: bigint, den: bigint, significant = 6): string {
  if (den <= 0n || num < 0n) throw new Error('fraction_invalid')
  if (num === 0n) return '0'
  const whole = num / den
  let rest = num % den
  const wholeDigits = whole === 0n ? '' : whole.toString(10)
  let fraction = ''
  let counted = wholeDigits.length
  // Fraction digits until `significant` significant digits are written (leading zeros after the point do not count).
  while (rest !== 0n && counted < significant && fraction.length < 80) {
    rest *= 10n
    const digit = rest / den
    rest %= den
    fraction += digit.toString(10)
    if (counted > 0 || digit !== 0n) counted++
  }
  fraction = fraction.replace(/0+$/, '')
  const grouped = (wholeDigits || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/**
 * The price an integer sqrt price stands for, both ways round, recomputed from the integer (the review's round trip):
 * `price0In1` currency1 per one currency0, `price1In0` currency0 per one currency1.
 */
export function pricesAtSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number, significant = 6): { price0In1: string; price1In0: string } {
  if (!decimalsOk(decimals0) || !decimalsOk(decimals1) || sqrtPriceX96 <= 0n) throw new Error('price_invalid')
  const square = sqrtPriceX96 * sqrtPriceX96
  const shift = decimals0 - decimals1
  // price0In1 = sqrt² / 2^192 × 10^(d0 − d1)
  const num = square * (shift >= 0 ? 10n ** BigInt(shift) : 1n)
  const den = (1n << 192n) * (shift < 0 ? 10n ** BigInt(-shift) : 1n)
  return { price0In1: fractionText(num, den, significant), price1In0: fractionText(den, num, significant) }
}

/** The typed price said both ways round from the typed fraction itself (before the integer): "1 ETH = 2,500 USDG · 1 USDG = 0.0004 ETH". */
export function typedBothWays(price: PriceFraction, significant = 6): { forward: string; inverse: string } {
  return { forward: fractionText(price.num, price.den, significant), inverse: fractionText(price.den, price.num, significant) }
}
